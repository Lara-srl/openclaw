# Analisi TTS/STT: Voxtral (Mistral) per LaraGoci

> Creato: 2026-03-26 — Aggiornato: 2026-03-30
>
> **Stato**: TTS integrato ✅ (voice_id fix committato) — STT da integrare — config gateway da completare

---

## Stack Mistral completo (obiettivo)

| Componente | Modello                 | Endpoint                                         | Stato                                    |
| ---------- | ----------------------- | ------------------------------------------------ | ---------------------------------------- |
| LLM        | `mistral-small-latest`  | `https://api.mistral.ai/v1`                      | ✅ configurato                           |
| TTS        | `voxtral-mini-tts-2603` | `https://api.mistral.ai/v1/audio/speech`         | ✅ codice fatto — config gateway da fare |
| STT        | `voxtral-mini-latest`   | `https://api.mistral.ai/v1/audio/transcriptions` | ⏳ da integrare                          |

---

## TTS Voxtral — Findings reali (2026-03-30)

### Specifiche tecniche verificate

| Parametro       | Valore                                                                             |
| --------------- | ---------------------------------------------------------------------------------- |
| Modello         | `voxtral-mini-tts-2603`                                                            |
| API endpoint    | `POST https://api.mistral.ai/v1/audio/speech`                                      |
| Autenticazione  | `Authorization: Bearer <MISTRAL_API_KEY>`                                          |
| Formato output  | PCM 24kHz, WAV, MP3, Opus, FLAC, AAC                                               |
| **PCM 24kHz**   | ✅ Nativo — zero conversione per pipeline xiaozhi                                  |
| Risposta        | ✅ **Binario diretto** — NON JSON con `audio_data` base64 (nota 26-mar era errata) |
| Preset italiani | ❌ Non esistono — `it_female` → 404. Serve voice cloning con `voice_id` UUID       |
| Latenza API     | ~1.2s per frase breve (misurata in test reale)                                     |
| Costo           | $0.016 / 1k chars (vs ElevenLabs ~$0.30/min ≈ 99% risparmio)                       |
| EU              | ✅ Parigi (OPCORE)                                                                 |

### Formato request corretto

```json
{
  "model": "voxtral-mini-tts-2603",
  "input": "Ciao, come stai?",
  "voice_id": "10e8fb02-3a0a-4b93-81c2-32bd37b7d6a4",
  "response_format": "pcm"
}
```

> ⚠️ `voice_id` (non `voice`) — questo è l'unico campo non OpenAI-compatible.
> La risposta è binario PCM diretto, non JSON. `arrayBuffer()` funziona as-is.

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

## Fix implementato in OpenClaw

**File**: `src/tts/tts-core.ts` — funzione `openaiTTS()` (commit `91b9778ef`)

Quando il campo `voice` è un UUID (36 chars hex+dash) E si usa un custom endpoint,
invia `voice_id` invece di `voice`. Backward-compatible: endpoint OpenAI standard ignorano `voice_id`.

```typescript
// Voxtral (Mistral) uses voice_id (UUID); standard OpenAI-compatible endpoints use voice
...(isCustomOpenAIEndpoint() && /^[0-9a-f-]{36}$/i.test(voice)
  ? { voice_id: voice }
  : { voice }),
```

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

## Decisioni prese (2026-03-30)

| Componente | Decisione                        | Note                             |
| ---------- | -------------------------------- | -------------------------------- |
| TTS        | ✅ Voxtral — implementato        | voice_id UUID fix in tts-core.ts |
| LLM        | ✅ mistral-small-latest          | configurato in openclaw.json     |
| STT        | ⏳ Voxtral — prossimo step       | ~5 righe in audio-pipeline.ts    |
| ElevenLabs | Fallback se Voxtral non soddisfa | Già integrato, zero rischio      |
| Piper      | ❌ Scartato                      | Qualità italiana insufficiente   |
| Groq STT   | Mantenere come fallback          | Funziona, ZDR attivo, $0.00/min  |
