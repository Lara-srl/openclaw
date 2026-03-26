# Ottimizzazioni Post-MVP — LaraGoci / XiaoZhi BOX-3

> Data: 2026-03-26 — Stato: MVP completato ✅, ottimizzazioni in pianificazione

---

## Situazione attuale (osservata in produzione)

Il sistema funziona end-to-end con hold-to-talk. Le aree di miglioramento sono:

1. **Audio cracchia** — artefatti/distorsione nel TTS in uscita
2. **Latenza percettibile** — gap tra rilascio bottone e risposta audio (~6-9s stimati)
3. **Nessuno streaming** — il device inizia a parlare solo dopo che LLM + TTS sono completamente finiti
4. **Risposte troppo lunghe** — l'agente non ha un prompt che lo spinge a essere conciso

Display: **lasciato perdere per ora** — comportamento firmware accettato.

---

## Priorità

### P0 — Audio crackling (5 min)

**Causa:** Opus bitrate troppo basso — `DOWNLOAD_BITRATE = 24_000` (24 kbps).
Speech TTS di qualità usa 48 kbps.

**Fix:** `extensions/xiaozhi/src/audio-pipeline.ts`

```ts
const DOWNLOAD_BITRATE = 48_000; // era 24_000
```

---

### P1 — Migrazione stack completa + streaming (priorità principale)

Migrazione in un colpo solo: Groq + Gemini + ElevenLabs.

#### Stack target

| Componente | Da                       | A                                        | Guadagno        |
| ---------- | ------------------------ | ---------------------------------------- | --------------- |
| STT        | OpenAI whisper-1 (~1.5s) | Groq whisper-large-v3 (~150ms)           | ~1.3s           |
| LLM        | Claude Opus 4.6 (~3s)    | Gemini 2.5 Flash (~0.8s)                 | ~2s             |
| TTS        | OpenAI TTS (batch)       | ElevenLabs eleven_turbo_v2_5 (streaming) | ~1.5s percepita |
| **Totale** | **~6-9s**                | **~1.5-2.5s**                            | **~4-6s**       |

#### Streaming TTS — architettura

Il guadagno maggiore in latenza **percepita** viene dallo streaming:
invece di aspettare l'intera risposta LLM + intera sintesi TTS, il device
inizia a parlare non appena arriva il primo chunk audio.

**Flusso attuale (batch):**

```
listen:stop
  → Whisper full (~1.5s)
  → Agent full response (~3s)
  → TTS full audio (~2s)
  → Opus encode all
  → rate-ctrl send
                          ← device inizia a parlare (6-9s dopo)
```

**Flusso target (streaming):**

```
listen:stop
  → Groq Whisper (~150ms)
  → Gemini stream tokens → buffer a sentence boundary
      → prima frase pronta (~400ms) → ElevenLabs chunk 1 → Opus → tts:start + frames
      → seconda frase → ElevenLabs chunk 2 → Opus → frames
      → ...
      → tts:stop
                          ← device inizia a parlare (~700ms dopo)
```

**Sentence boundary:** spezzare a `.`, `?`, `!`, oppure ogni ~80-120 caratteri
per bilanciare latenza e naturalezza vocale.

#### Risposte brevi (system prompt)

Aggiungere al system prompt dell'agente:

```
Rispondi sempre in modo conciso: 1-2 frasi se la domanda è semplice.
Usa frasi più lunghe solo per spiegazioni tecniche o richieste complesse.
Niente premesse, niente conclusioni ridondanti.
```

---

## Modifiche al codice

### File da toccare

| File                                       | Modifica                                            |
| ------------------------------------------ | --------------------------------------------------- |
| `extensions/xiaozhi/src/audio-pipeline.ts` | P0: bitrate 48k; P1: Groq STT, streaming TTS loop   |
| `extensions/xiaozhi/src/channel.ts`        | P1: modello Gemini + system prompt conciso          |
| `extensions/xiaozhi/src/tts-elevenlabs.ts` | P1: nuovo adapter streaming ElevenLabs (da creare)  |
| `extensions/xiaozhi/package.json`          | P1: aggiungere `elevenlabs` o chiamate HTTP dirette |

### Architettura streaming in `audio-pipeline.ts`

La funzione `speak(text)` attuale è batch. Va sostituita con un loop:

```ts
// pseudocodice — streaming speak
async function speakStreaming(agentStream: AsyncIterable<string>) {
  sendTtsStart();
  let buffer = "";
  for await (const token of agentStream) {
    buffer += token;
    if (isSentenceBoundary(buffer)) {
      const chunk = buffer;
      buffer = "";
      const pcm = await elevenLabsTTS(chunk); // streaming HTTP
      const frames = encodeOpus(pcm);
      await rateControlledSend(frames);
    }
  }
  if (buffer) {
    const frames = encodeOpus(await elevenLabsTTS(buffer));
    await rateControlledSend(frames);
  }
  sendTtsStop();
}
```

**⚠️ Punto da verificare — streaming LLM:**
`runEmbeddedPiAgent` (usato in `audio-pipeline.ts:398`) è batch — restituisce l'intera
risposta in una volta. Per lo streaming servirebbe chiamare Gemini direttamente
dall'estensione bypassando `runEmbeddedPiAgent`.
**Non sappiamo ancora i collaterali** — si bypasserebbe la session store, il contesto
conversazione, i tool OpenClaw, i log, ecc. Da analizzare prima di procedere:

- Cosa gestisce `runEmbeddedPiAgent` oltre alla generazione (memoria, tool, log)?
- Esiste un modo per ottenere streaming senza bypassare il Pi agent?
- Accettabile perdere quella logica per il caso XiaoZhi?

---

## Roadmap

```
Subito (oggi):
  → P0: DOWNLOAD_BITRATE 24k → 48k
  → Verificare se runtime espone stream LLM

Prossima sessione:
  → Migrare STT a Groq (modifica ~20 righe, massimo guadagno immediato)
  → Migrare LLM a Gemini 2.5 Flash + system prompt conciso
  → Aggiungere adapter ElevenLabs streaming

Verifica dopo migrazione:
  → Misurare latenza per componente nei log (già loggato con timestamp)
  → Test qualità audio ElevenLabs vs OpenAI TTS
  → Test interrupt B10 con streaming attivo (edge case da verificare)
```
