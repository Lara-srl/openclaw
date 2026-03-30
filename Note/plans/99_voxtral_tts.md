# Analisi TTS/STT: Voxtral (Mistral) per LaraGoci

> Creato: 2026-03-26 — Aggiornato: 2026-03-30
>
> **Stato**: TTS funzionante ✅ (audio OK su device, branch feat/voxtral-tts) — Volume TTS risolto con XIAOZHI_TTS_GAIN ✅ — STT da integrare

---

## Stack Mistral completo (obiettivo)

| Componente | Modello                 | Endpoint                                         | Stato                    |
| ---------- | ----------------------- | ------------------------------------------------ | ------------------------ |
| LLM        | `mistral-small-latest`  | `https://api.mistral.ai/v1`                      | ✅ configurato           |
| TTS        | `voxtral-mini-tts-2603` | `https://api.mistral.ai/v1/audio/speech`         | ✅ funzionante su device |
| STT        | `voxtral-mini-latest`   | `https://api.mistral.ai/v1/audio/transcriptions` | ⏳ da integrare          |

---

## TTS Voxtral — Findings reali (2026-03-30)

### Specifiche tecniche verificate

| Parametro       | Valore                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Modello         | `voxtral-mini-tts-2603`                                                                                                                   |
| API endpoint    | `POST https://api.mistral.ai/v1/audio/speech`                                                                                             |
| Autenticazione  | `Authorization: Bearer <MISTRAL_API_KEY>`                                                                                                 |
| Formato output  | PCM 24kHz, WAV, MP3, Opus, FLAC, AAC                                                                                                      |
| **PCM 24kHz**   | ✅ Nativo — zero conversione per pipeline xiaozhi                                                                                         |
| Risposta        | ⚠️ **JSON** `{"audio_data":"<base64>"}` — la nota 26-mar era CORRETTA. Test curl con `--output` ingannava perché scriveva il JSON grezzo. |
| Formato PCM     | **float32 LE** (confermato da docs.mistral.ai) — va convertito a int16 LE                                                                 |
| Preset italiani | ❌ Non esistono — `it_female` → 404. Serve voice cloning con `voice_id` UUID                                                              |
| Latenza API     | ~1.2s per frase breve (misurata in test reale)                                                                                            |
| Costo           | $0.016 / 1k chars (vs ElevenLabs ~$0.30/min ≈ 99% risparmio)                                                                              |
| EU              | ✅ Parigi (OPCORE)                                                                                                                        |

### Formato request corretto

```json
{
  "model": "voxtral-mini-tts-2603",
  "input": "Ciao, come stai?",
  "voice_id": "10e8fb02-3a0a-4b93-81c2-32bd37b7d6a4",
  "response_format": "pcm"
}
```

> ⚠️ `voice_id` (non `voice`) — non OpenAI-compatible.
> La risposta è JSON `{"audio_data":"<base64>"}` — va parsata e decodificata.
> Il base64 contiene float32 LE — va convertito a int16 LE prima di Opus encode.

### Voce italiana creata

| Campo    | Valore                                           |
| -------- | ------------------------------------------------ |
| Nome     | `francesco` (voce di test, rinominare)           |
| voice_id | `10e8fb02-3a0a-4b93-81c2-32bd37b7d6a4`           |
| Creata   | console.mistral.ai — upload audio italiano 3-10s |

Per creare nuove voci (o sostituire `francesco` con voce femminile migliore):

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
# Lista voci account:
curl -s https://api.mistral.ai/v1/audio/voices -H "Authorization: Bearer $MKEY" | python3 -m json.tool

# Crea nuova voce da file audio:
curl -X POST https://api.mistral.ai/v1/audio/voices \
  -H "Authorization: Bearer $MKEY" \
  -F 'file=@/percorso/audio-italiano.wav' \
  -F 'name=lara-italiana'
```

---

## Fix implementati (branch feat/voxtral-tts)

### 1. `src/tts/tts-core.ts` — voice_id UUID (commit `91b9778ef`)

Quando `voice` è un UUID e si usa custom endpoint → invia `voice_id` invece di `voice`.

```typescript
...(isCustomOpenAIEndpoint() && /^[0-9a-f-]{36}$/i.test(voice)
  ? { voice_id: voice }
  : { voice }),
```

### 2. `extensions/xiaozhi/src/audio-pipeline.ts` — pipeline Voxtral (commit `0dd01801c`)

Pipeline completa per gestire la risposta Voxtral:

```
JSON {"audio_data":"<base64>"}
  → base64 decode → float32 LE buffer
  → float32→int16 LE conversion
  → resamplePcm (sampleRate=24000, no-op)
  → normalizePcm (peak cap)
  → Opus encode → device
```

Funzioni aggiunte in `audio-pipeline.ts`:

- `maybeUnwrapVoxtralResponse(buf)` — se OPENAI_TTS_BASE_URL contiene "mistral" e buf inizia con `{`, parsa JSON e decodifica base64
- `maybeFloat32ToInt16(buf)` — se OPENAI_TTS_BASE_URL contiene "mistral", converte float32 LE → int16 LE
- `normalizePcm`: aggiunto `Math.floor` per buffer con byte count dispari (commit `56cc9a937`)

---

## Configurazione gateway (da fare)

Il CLI `pnpm openclaw config set tts.*` non supporta la chiave `tts` top-level —
va scritto direttamente in `~/.openclaw/openclaw.json`.

### 1. Aggiungi a `~/.bashrc`

```bash
export OPENAI_TTS_BASE_URL=https://api.mistral.ai/v1
```

### 2. Aggiungi sezione `tts` in `~/.openclaw/openclaw.json`

```json
{
  "tts": {
    "provider": "openai",
    "openai": {
      "apiKey": "<MISTRAL_API_KEY>",
      "model": "voxtral-mini-tts-2603",
      "voice": "10e8fb02-3a0a-4b93-81c2-32bd37b7d6a4"
    }
  }
}
```

> `apiKey` nel JSON evita collisioni con `OPENAI_API_KEY` globale.
> `OPENAI_TTS_BASE_URL` fa puntare le chiamate a Mistral invece che OpenAI.

### 3. Riavvia gateway

```bash
cd ~/openclaw
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
GKEY=$(grep GROQ_API_KEY ~/.bashrc | cut -d= -f2-)
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
MISTRAL_API_KEY="$MKEY" \
GROQ_API_KEY="$GKEY" \
OPENAI_TTS_BASE_URL="https://api.mistral.ai/v1" \
nohup pnpm openclaw gateway run --bind loopback --port 18789 --force \
  > /tmp/openclaw-gateway.log 2>&1 &
sleep 5 && tail -20 /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'
```

---

## STT Voxtral — da integrare

### Specifiche

| Parametro   | Valore                                                |
| ----------- | ----------------------------------------------------- |
| Modello     | `voxtral-mini-latest`                                 |
| Endpoint    | `POST https://api.mistral.ai/v1/audio/transcriptions` |
| Compatibile | OpenAI Whisper API ✅ — stessa struttura multipart    |
| Italiano    | ✅ supportato (13 lingue)                             |
| Costo       | $0.003/min (vs Groq ~$0.00 ma ZDR ok)                 |
| Latenza     | sub-200ms (Realtime), batch per offline               |

### Modifica richiesta

File: `extensions/xiaozhi/src/audio-pipeline.ts` — funzione `whisperTranscribe()` (~riga 507)

Cambiare solo URL e model:

```typescript
// Da (Groq):
url = "https://api.groq.com/openai/v1/audio/transcriptions";
model = "whisper-large-v3-turbo";
apiKey = GROQ_API_KEY;

// A (Voxtral):
url = "https://api.mistral.ai/v1/audio/transcriptions";
model = "voxtral-mini-latest";
apiKey = MISTRAL_API_KEY;
```

~5 righe di codice. Zero cambiamenti all'architettura (stesso formato multipart OpenAI-compatible).

---

## Test curl STT (prima di integrare)

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
# Genera un PCM di test con il TTS attuale, poi trascrivilo:
curl -X POST https://api.mistral.ai/v1/audio/transcriptions \
  -H "Authorization: Bearer $MKEY" \
  -F "file=@/tmp/test-lara.pcm;type=audio/pcm" \
  -F "model=voxtral-mini-latest" \
  -F "language=it"
```

---

## Volume TTS — XIAOZHI_TTS_GAIN

Voxtral restituisce float32 LE con ampiezza ~0.3–0.5 → dopo conversione int16, il segnale è al 30–50% del massimo.
`normalizePcm` è ora **bidirezionale** (amplifica se sotto target, attenua se sopra).

| Variabile          | Default | Range     | Note                                                   |
| ------------------ | ------- | --------- | ------------------------------------------------------ |
| `XIAOZHI_TTS_GAIN` | `0.85`  | `0.1–1.0` | Peak target normalizzato; set in env prima del gateway |

```bash
# Esempio: gain massimo per voce bassa (es. Francesco con sample PC)
XIAOZHI_TTS_GAIN=1.0 ... pnpm openclaw gateway run ...
```

> La voce "Francesco" è stata creata con registrazione da microfono PC (bassa qualità).
> Per una voce migliore vedere sezione "Come creare una voce migliore" sotto.

---

## Come creare una voce migliore

### Via console.mistral.ai (GUI)

1. Vai su **https://console.mistral.ai/** → sezione **Voices**
2. Clicca **Create voice**
3. Carica un audio WAV/MP3 di **10–30 secondi** — voce italiana chiara, senza rumore di fondo
4. Registrazione consigliata: smartphone in stanza silenziosa, o campione da voice actor
5. Copia il `voice_id` (UUID) ottenuto → aggiorna `~/.openclaw/openclaw.json` → `messages.tts.openai.voice`

### Via API

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
curl -X POST https://api.mistral.ai/v1/audio/voices \
  -H "Authorization: Bearer $MKEY" \
  -F 'file=@/percorso/voce-italiana.wav' \
  -F 'name=lara-italiana'
# Risposta: {"id":"<UUID>","name":"lara-italiana",...}
```

---

## Decisioni prese (2026-03-30)

| Componente | Decisione                        | Note                             |
| ---------- | -------------------------------- | -------------------------------- |
| TTS        | ✅ Voxtral — implementato        | voice_id UUID fix in tts-core.ts |
| LLM        | ✅ mistral-small-latest          | configurato in openclaw.json     |
| STT        | ⏳ Voxtral — prossimo step       | ~5 righe in audio-pipeline.ts    |
| ElevenLabs | Fallback se Voxtral non soddisfa | Già integrato, zero rischio      |
| Piper      | ❌ Scartato                      | Qualità italiana insufficiente   |
| Groq STT   | Mantenere come fallback          | Funziona, ZDR attivo, $0.00/min  |
