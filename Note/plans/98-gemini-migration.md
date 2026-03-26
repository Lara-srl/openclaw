# Valutazione Strategica: SenseCAP Watcher + Stack AI

> Data: 2026-03-25, aggiornato 2026-03-26 — Contesto: LaraGoci / XiaoZhi

## Obiettivo

Valutare due possibili evoluzioni indipendenti:

1. **SenseCAP Watcher** come device di produzione al posto di ESP32-S3-BOX-3
2. **Stack AI ottimizzato** per LLM + STT + TTS + Image

---

## 1. SenseCAP Watcher — Valutazione per time-to-market

### Pro (perché conviene)

| Aspetto                | Dettaglio                                                                         |
| ---------------------- | --------------------------------------------------------------------------------- |
| **Enclosure pronto**   | Plastic case W1-A (trasparente) o W1-B (bianco) — nessun design meccanico da fare |
| **Camera integrata**   | OV5647 120° FOV — possibilità di visione non disponibile su BOX-3                 |
| **Batteria backup**    | 400 mAh — funziona senza USB                                                      |
| **XiaoZhi supportato** | Listato ufficialmente nel repo `78/xiaozhi-esp32` (70+ board)                     |
| **Prezzo**             | ~$79 USD — competitivo                                                            |
| **Himax AI chip**      | HX6538 Cortex-M55 + NPU — 32× più veloce per inference visione                    |
| **Già sul mercato**    | Kickstarter completato, shipping 2025                                             |

### Contro (limitazioni vs BOX-3)

| Aspetto                 | Dettaglio                                                                  |
| ----------------------- | -------------------------------------------------------------------------- |
| **Singolo microfono**   | BOX-3 ha 2 mic — peggio per far-field voice                                |
| **Display più piccolo** | 1.45" 412×412 vs 2.4" 320×240 BOX-3                                        |
| **8 MB PSRAM**          | BOX-3 ha 16 MB — meno spazio per buffer audio                              |
| **Flashing delicato**   | Bisogna preservare le credenziali SenseCraft (EUI) durante il flash custom |
| **Community minore**    | Ecosistema più nuovo rispetto a Espressif BOX-3                            |

### Verdict

✅ **Conviene per market** — se l'obiettivo è un prodotto finito da mettere in mano agli utenti,
SenseCAP Watcher elimina il problema dell'enclosure (il bottleneck più lento da risolvere).
La voce è leggermente peggiore (1 mic), ma accettabile per use case conversazionale normale.

**Prossimo step pratico:** comprare 1 unità (~$79), flashare firmware XiaoZhi custom
(stessa procedura BOX-3 con ESP-IDF v5.5.3), verificare compatibilità protocollo WS.

> **✅ Confermato da Seeed Technical Support (2026-03-26):** custom WebSocket server supportato
> tramite ESP-IDF menuconfig + recompile + flash. Nessuna UI di configurazione — stessa
> procedura già usata sul BOX-3. Nessuna sorpresa all'arrivo.

---

## 2. Stack AI — Opzioni migrazione pipeline

### Stack attuale

| Componente | Provider  | Modello                  |
| ---------- | --------- | ------------------------ |
| LLM        | Anthropic | claude-opus-4-6          |
| STT        | OpenAI    | whisper-1 (WAV → testo)  |
| TTS        | OpenAI    | TTS pcm_24000, voce Nova |
| Image      | —         | non implementato         |

---

### Opzione A — "Stack Gemini" (economico, mono-vendor)

| Componente | Provider | Modello               | Note                                                         |
| ---------- | -------- | --------------------- | ------------------------------------------------------------ |
| LLM        | Google   | gemini-2.5-flash      | ~$0.30/M tok in, $2.50/M tok out — risparmio ~70-80% vs Opus |
| STT        | OpenAI   | whisper-1 (invariato) | Gemini non ha STT real-time equivalente                      |
| TTS        | Google   | gemini-2.5-flash TTS  | PCM 24kHz — drop-in nella pipeline attuale                   |
| Image      | Google   | Imagen 4 Fast         | $0.02/img — più economico di DALL-E                          |

**Verdict A:** migrazione parziale — Gemini per LLM + TTS + Image, Whisper rimane per STT.

---

### Opzione B — "Premium Combo" (qualità massima, multi-vendor)

> Stack consigliato per prodotto consumer con migliaia di utenti.

| Componente | Provider   | Modello             | Latenza           | Costo           |
| ---------- | ---------- | ------------------- | ----------------- | --------------- |
| **STT**    | Groq       | `whisper-large-v3`  | ~100-200ms ⚡     | ~$0.001/min     |
| **LLM**    | Google     | `gemini-2.5-flash`  | bassa             | ~$0.30/M tok    |
| **TTS**    | ElevenLabs | `eleven_turbo_v2_5` | bassa (streaming) | ~$0.18/1k chars |
| **Image**  | Google     | Imagen 4 Fast       | —                 | $0.02/img       |

**Pipeline (PTT release → risposta audio):**

1. **Groq Whisper** trascrive l'audio in <200ms (API OpenAI-compatible, drop-in)
2. **Gemini 2.5 Flash** elabora il testo e genera la risposta
3. **ElevenLabs Turbo** converte in audio con streaming — il device inizia a parlare prima della fine

**⚠️ Attenzione costi a scala:**

- ElevenLabs sarà ~80% del costo totale con migliaia di utenti — previsto, accettato
- ElevenLabs `eleven_turbo_v2_5` usato sempre per tutta la pipeline TTS

**Note tecniche importanti:**

- Le env vars `STT_PROVIDER=groq` / `LLM_PROVIDER=google` / `TTS_PROVIDER=elevenlabs` **non esistono in OpenClaw** — la configurazione va nel codice di `extensions/xiaozhi/src/audio-pipeline.ts`
- Groq ha API audio OpenAI-compatible → modifica minima rispetto a Whisper attuale
- ElevenLabs streaming HTTP → va integrato nella pipeline WS (non automatico, richiede adattamento)
- Tool Calling / Google CLI integration: fuori scope MVP

**Verdict B:** qualità vocale superiore, latenza STT più bassa, ma costo ElevenLabs va gestito con strategia ibrida a scala.

---

### Confronto opzioni

|             | Stack attuale | Opzione A (Gemini) | Opzione B (Premium) |
| ----------- | ------------- | ------------------ | ------------------- |
| Costo LLM   | $$$           | $                  | $                   |
| Qualità TTS | media         | buona              | ottima              |
| Latenza STT | ~500ms        | ~500ms             | ~150ms              |
| Complessità | base          | bassa              | media               |
| Vendor      | 2             | 2                  | 3                   |

**Raccomandazione MVP:** Opzione A (Gemini) per semplicità. Opzione B quando si scala a utenti reali.

---

## Priorità suggerita

```
Adesso (in corso):
  → Completare hold-to-talk firmware (Note/plans/04_pipeline_button.md)

Breve termine:
  → Comprare SenseCAP Watcher, testare compatibilità XiaoZhi

Medio termine:
  → Migrare LLM da Claude a Gemini 2.5 Flash (costo)
  → Aggiungere TTS Gemini come alternativa/fallback
  → Implementare image generation con Imagen 4

Post-MVP:
  → Valutare Google Cloud STT se Whisper diventa costoso/lento
  → Esplorare Gemini Live API per real-time voice (barge-in nativo)
  → Display dinamico: ricevere immagini generate (Imagen 4) via WS e renderizzarle con LVGL
      - Prima su BOX-3 (16MB PSRAM, più margine), poi porta su SenseCAP (8MB)
      - Firmware: esp_jpeg decoder + nuovo tipo messaggio WS + LVGL render
      - Server: Gemini genera stato emotivo → Imagen 4 Fast → JPEG → WS binary message
  → MCP server per controllo device (display, audio, sensori) da LLM
```

---

## File da modificare

### Opzione A (Gemini)

| File                                       | Modifica                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `extensions/xiaozhi/src/audio-pipeline.ts` | Sostituire chiamate OpenAI TTS con Gemini TTS; LLM da Anthropic a Gemini |
| `extensions/xiaozhi/package.json`          | Aggiungere `@google/generative-ai`                                       |

### Opzione B (Premium: Groq + Gemini + ElevenLabs)

| File                                       | Modifica                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `extensions/xiaozhi/src/audio-pipeline.ts` | STT → Groq (endpoint OpenAI-compat); LLM → Gemini; TTS → ElevenLabs streaming |
| `extensions/xiaozhi/package.json`          | Aggiungere `elevenlabs` SDK (o chiamate HTTP dirette)                         |
| `extensions/xiaozhi/src/tts-elevenlabs.ts` | Nuovo: adapter ElevenLabs → PCM 16kHz per pipeline XiaoZhi                    |
