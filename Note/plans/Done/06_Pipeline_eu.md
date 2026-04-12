# Pipeline EU — LaraGoci / XiaoZhi

> Aggiornato: 2026-03-30
>
> **Stato**: Stack 100% EU funzionante ✅ su branch `feat/voxtral-tts`

---

## Stack attuale

| Componente | Provider          | Modello                 | Datacenter     | Stato                           |
| ---------- | ----------------- | ----------------------- | -------------- | ------------------------------- |
| STT        | Mistral (Voxtral) | `voxtral-mini-latest`   | Paris (OPCORE) | ✅                              |
| LLM        | Mistral           | `mistral-small-latest`  | Paris (OPCORE) | ✅                              |
| TTS        | Mistral (Voxtral) | `voxtral-mini-tts-2603` | Paris (OPCORE) | ✅                              |
| VM         | exe.dev           | Ubuntu 22.04            | USA (temp)     | ⏳ migrazione Scaleway post-MVP |

Una sola API key (`MISTRAL_API_KEY`), una sola azienda, 100% EU/GDPR.

---

## Configurazione

### `~/.bashrc`

```bash
export MISTRAL_API_KEY=<chiave>
export OPENAI_TTS_BASE_URL=https://api.mistral.ai/v1
export XIAOZHI_TTS_GAIN=0.85
```

### `~/.openclaw/openclaw.json` (sezione rilevante)

voce francesco "10e8fb02-3a0a-4b93-81c2-32bd37b7d6a4"
voce donna librox d49d2eb9-2178-4fa6-880b-76b4d4a4fab5
francia fr_marie_sad, fr_marie_neutral
studio : c2b553b2-9e48-43f0-a957-58febfbd5141

```json
{
  "agents": {
    "defaults": {
      "model": "mistral/mistral-small-latest"
    }
  },
  "messages": {
    "tts": {
      "provider": "openai",
      "openai": {
        "apiKey": "<MISTRAL_API_KEY>",
        "model": "voxtral-mini-tts-2603",
        "voice": "10e8fb02-3a0a-4b93-81c2-32bd37b7d6a4"
      }
    }
  }
}
```

> `provider: "openai"` è intenzionale — usa il provider OpenAI-compatible con `OPENAI_TTS_BASE_URL` che punta a Mistral.
> `voice` è il `voice_id` UUID della voce clonata su console.mistral.ai.

---

## Avvio gateway

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
```

```bash
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
```

```bash
MISTRAL_API_KEY="$MKEY" OPENAI_TTS_BASE_URL="https://api.mistral.ai/v1" pnpm openclaw gateway run --bind loopback --port 18789 --force
```

---

## Volume TTS — XIAOZHI_TTS_GAIN

Voxtral TTS restituisce float32 LE con ampiezza ~0.3–0.5. La pipeline converte in int16 e normalizza.

| Variabile          | Default | Range     | Note                                      |
| ------------------ | ------- | --------- | ----------------------------------------- |
| `XIAOZHI_TTS_GAIN` | `0.85`  | `0.1–1.0` | Peak target; da settare in env al gateway |

`normalizePcm` è bidirezionale: amplifica se sotto target, attenua se sopra.

---

## Voce TTS — creare una voce italiana

La voce attuale (`francesco`, UUID `10e8fb02-3a0a-4b93-81c2-32bd37b7d6a4`) è una registrazione
da microfono PC — qualità bassa. Per una voce migliore:

### Via GUI (consigliato)

1. **https://console.mistral.ai/** → **Voices** → **Create voice**
2. Carica WAV/MP3 da **10–30 secondi** — voce italiana, stanza silenziosa, nessun rumore
3. Copia UUID ottenuto → aggiorna `~/.openclaw/openclaw.json` → `messages.tts.openai.voice`

### Via API

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
curl -X POST https://api.mistral.ai/v1/audio/voices \
  -H "Authorization: Bearer $MKEY" \
  -F 'file=@voce-italiana.wav' \
  -F 'name=lara-italiana'
# Risposta: {"id":"<UUID>","name":"lara-italiana",...}
```

---

## Implementazione — file modificati

| File                                       | Modifica                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `extensions/xiaozhi/src/audio-pipeline.ts` | STT Voxtral, TTS JSON unwrap, float32→int16, normalizePcm bidirezionale, XIAOZHI_TTS_GAIN |
| `src/tts/tts-core.ts`                      | UUID detection → invia `voice_id` invece di `voice`                                       |

### Pipeline TTS (audio-pipeline.ts)

```
Voxtral API → JSON {"audio_data":"<base64>"}
  → maybeUnwrapVoxtralResponse() → base64 decode
  → maybeFloat32ToInt16() → int16 LE
  → resamplePcm(24000) → no-op (già 24kHz)
  → normalizePcm(XIAOZHI_TTS_GAIN)
  → Opus encode → device
```

### Pipeline STT (audio-pipeline.ts)

```
Opus frames → decode → PCM 16kHz → WAV
  → POST https://api.mistral.ai/v1/audio/transcriptions
  → model=voxtral-mini-latest, language=it, auth=MISTRAL_API_KEY
  → testo → agente LLM
```

---

## Roadmap

### P1C — Streaming TTS (prossimo step critico)

Latenza attuale: ~3.5-5s totale (attende LLM completo → TTS → audio).
Target: **~700ms al primo audio**.

Architettura:

```
STT (~150ms)
  → LLM con onPartialReply
      → sentence detector (split su . ! ? \n, min ~30 chars)
          → Voxtral TTS per frase (~800ms)
              → Opus encode → tts:start + frames
  → frasi successive in pipeline
  → tts:stop
```

File: `extensions/xiaozhi/src/audio-pipeline.ts` — aggiungere `runAgentStreaming` + `speakChunk(text)`.

---

### VM — Migrazione a Scaleway Paris (post-MVP)

Stack target completo co-located:

```
Scaleway DEV1-L Paris (€30/mese, 8GB RAM)
  ↕ <5ms rete
Mistral API Paris (OPCORE)
```

Passi (nessun codice):

1. Crea Scaleway Instance Paris
2. Installa openclaw, configura gateway
3. Aggiorna DNS `laragoci.lara-ai.eu` → IP Scaleway
4. Migra `~/.openclaw/` (workspace, sessions, credentials)
5. Shutdown exe.dev VM

---

### Hosted Gateway — Multi-tenant SaaS (futuro)

Architettura: 1 container Docker per utente su VM Scaleway.

```
nginx (reverse proxy + SSL)
├── utente-1: container openclaw-gateway (porta dinamica)
│   └── /data/users/utente-1/.openclaw/
├── utente-2: container openclaw-gateway
│   └── /data/users/utente-2/.openclaw/
└── ...
```

Costi: ~€2/utente/mese infra. Abbonamento target: €12/mese → ~€10 margine/utente.
Break-even VM: 3 utenti. A 50 utenti: ~€500/mese margine.

Onboarding target (zero terminale):

1. Acquisto device + abbonamento su laragoci.eu (Stripe)
2. Device in WiFi AP mode → phone inserisce SSID + password casa
3. Device online → agente attivo su WhatsApp/Telegram

**Blocco tecnico aperto**: XiaoZhi WiFi AP mode — verifica se supporta campo WS URL custom o serve re-flash per ogni utente.

---

## Rollback

```bash
# Ripristina LLM Anthropic:
pnpm openclaw config set agents.defaults.model anthropic/claude-haiku-4-5-20251001

# Ripristina TTS OpenAI: rimuovi messages.tts da ~/.openclaw/openclaw.json
# e togli OPENAI_TTS_BASE_URL da ~/.bashrc

# Gateway con chiave Anthropic:
KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2-)
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
ANTHROPIC_API_KEY="$KEY" nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```
