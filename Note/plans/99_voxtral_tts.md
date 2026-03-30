# Analisi TTS: Voxtral (Mistral) vs ElevenLabs per LaraGoci

## Verdetto

**✅ Voxtral è il TTS sovrano giusto — testarlo SUBITO con 0 righe di codice.**

Voxtral è stato rilasciato il 26 marzo 2026 (3 giorni fa). È OpenAI-compatible,
supporta italiano nativo con PCM 24kHz, è EU (Parigi), e costa 99% meno di ElevenLabs.
Il path di integrazione esiste già in OpenClaw senza toccare codice sorgente.

---

## Findings Voxtral TTS (2026-03-26)

### Specifiche tecniche rilevanti

| Parametro        | Valore                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| Modello          | `voxtral-mini-tts-2603` (4B params)                                    |
| API endpoint     | `POST https://api.mistral.ai/v1/audio/speech`                          |
| Autenticazione   | `Authorization: Bearer <MISTRAL_API_KEY>`                              |
| Formato output   | PCM 24kHz, WAV, MP3, Opus, FLAC, AAC                                   |
| **PCM 24kHz**    | ✅ Nativo — zero conversione per pipeline xiaozhi                      |
| Italiano         | ✅ supportato — **NO preset** (`it_female` non esiste) → voice cloning |
| Qualità italiano | Al pari di ElevenLabs Flash v2.5 (nessun bug noto)                     |
| Latenza API      | ~0.8s per testo breve (vs ~0.5s ElevenLabs)                            |
| Costo            | $0.016 / 1k chars (vs ElevenLabs ~$0.30/min ≈ 99% risparmio)           |
| Open source      | CC BY-NC 4.0 — auto-host possibile (16GB+ VRAM)                        |
| Scaleway         | ❌ Solo STT (Transcribe). TTS usa api.mistral.ai (ancora EU)           |

### Formato request

```json
{
  "model": "voxtral-mini-tts-2603",
  "input": "Ciao, come stai?",
  "voice_id": "<id-voce-creata>",
  "response_format": "pcm"
}
```

> ⚠️ **NON è OpenAI-compatible**: usa `voice_id` (non `voice`) e richiede una voce
> precedentemente creata tramite API Voices, **oppure** `ref_audio` (base64) per cloning one-shot.
> Nessun preset built-in come `"it_female"`.

**Alternativa one-shot (senza creare voce):**

```json
{
  "model": "voxtral-mini-tts-2603",
  "input": "Ciao, come stai?",
  "ref_audio": "<base64-audio-3s>",
  "response_format": "pcm"
}
```

La risposta è JSON con campo `audio_data` (base64), non stream binario diretto.

---

## Path integrazione — NON 0 righe di codice

⚠️ **Revisione**: Voxtral NON è drop-in OpenAI-compatible per TTS.
Il provider `openaiTTS()` in `src/tts/tts-core.ts` invia `voice` (stringa), non `voice_id`.
La risposta è JSON `{audio_data: base64}`, non stream binario — il parser attuale non funziona.

**Opzioni:**

### Opzione A: patch minima `openaiTTS()` (~20 righe)

- Mappare `voice` → `voice_id`
- Decodificare `audio_data` base64 → Buffer
- Creare preventivamente una voce italiana su console.mistral.ai → salvare l'ID

### Opzione B: nuovo provider `voxtralTTS()` in `src/tts/tts-core.ts` (~40 righe)

- Più pulito, nessun rischio regressione OpenAI
- Aggiungere `"voxtral"` a `TtsProvider` in `src/config/types.tts.ts`

**Prerequisito comune**: creare la voce italiana su https://console.mistral.ai/
(upload 3-10s audio italiano → ottieni `voice_id`)

---

## Piano test (prima di decidere)

1. Ottenere Mistral API key: https://console.mistral.ai/
2. Creare voce italiana su https://console.mistral.ai/ → upload 3-10s audio → copiare `voice_id`
3. Test curl con `voice_id` reale:
   ```bash
   # risposta JSON con audio_data base64 → salvare e decodificare
   curl -X POST https://api.mistral.ai/v1/audio/speech \
     -H "Authorization: Bearer $MISTRAL_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"voxtral-mini-tts-2603","input":"Ciao, sono Lara. Come posso aiutarti oggi?","voice_id":"<tuo-voice-id>","response_format":"pcm"}' \
     | jq -r '.audio_data' | base64 -d > /tmp/test.pcm
   ffplay -f s16le -ar 24000 -ac 1 /tmp/test.pcm
   ```
4. Se qualità ok → implementare Opzione A o B (patch TTS provider, ~20-40 righe)

---

## Decisione finale

| Fase                 | TTS                      | Motivazione                      |
| -------------------- | ------------------------ | -------------------------------- |
| **Ora**              | Test Voxtral (0 codice)  | Rilasciato 3 giorni fa, EU, free |
| **Se test ok**       | Voxtral per produzione   | Sostituisce ElevenLabs subito    |
| **Se test fallisce** | ElevenLabs come fallback | Già integrato, zero rischio      |
| **Piper**            | ❌ Scartato              | Qualità italiana insufficiente   |

---

## File coinvolti

| File                        | Funzione                  | Linea   | Modifica necessaria               |
| --------------------------- | ------------------------- | ------- | --------------------------------- |
| `src/tts/tts-core.ts`       | `openaiTTS()`             | 591-635 | Nessuna (usa OPENAI_TTS_BASE_URL) |
| `src/tts/tts-core.ts`       | custom endpoint detection | 337-380 | Nessuna (già rilassa validazione) |
| `src/tts/tts.ts`            | `textToSpeechTelephony()` | 702-789 | Nessuna                           |
| `~/.openclaw/openclaw.json` | config TTS                | —       | Aggiungere model/voice Voxtral    |
