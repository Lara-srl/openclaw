# Steps to Unicorn — Stack EU LaraGoci

> Creato: 2026-03-29 — Da fare nella prossima sessione
>
> **Obiettivo**: stack EU massimale — Voxtral STT + Mistral LLM + Voxtral TTS
> **Ordine fisso**: migrazioni provider → verifica → P1C streaming
>
> **Infrastruttura**: VM Scaleway Paris + Mistral API Paris (OPCORE) = stessa città,
> latenza di rete <5ms su ogni chiamata API → beneficio reale sul round-trip totale.

---

## Stack finale target

| Componente | Provider attuale              | Provider target              | EU?       | Datacenter   |
| ---------- | ----------------------------- | ---------------------------- | --------- | ------------ |
| STT        | Groq whisper-large-v3-turbo   | **Voxtral STT** (Mistral)    | ✅ Parigi | OPCORE/Paris |
| LLM        | google/gemini-3-flash-preview | mistral/mistral-small-latest | ✅ Parigi | OPCORE/Paris |
| TTS        | OpenAI TTS (batch)            | Voxtral TTS (Mistral)        | ✅ Parigi | OPCORE/Paris |
| VM         | exe.dev (USA?)                | **Scaleway Paris**           | ✅ Parigi | PAR1/PAR2    |

> **Co-location**: VM Scaleway Paris ↔ Mistral API Paris = <5ms rete su ogni hop.
> Stack 100% EU, una sola API key, una sola azienda (Mistral).

---

## Step 0 — Prerequisiti (fare prima)

### 0a. Mistral API key

1. Vai su https://console.mistral.ai/
2. Crea account o accedi
3. Genera API key
4. Aggiungi a `~/.bashrc`:
   ```bash
   export MISTRAL_API_KEY=<la-tua-chiave>
   export OPENAI_TTS_BASE_URL=https://api.mistral.ai/v1
   ```
5. Ricarica: `source ~/.bashrc`

### 0b. Attiva ZDR su Groq (privacy EU)

- Vai su https://console.groq.com → Settings → Data Controls
- Attiva **Zero Data Retention**

---

## Step 1 — Test Voxtral TTS (curl diretto, senza toccare nulla)

```bash
curl -X POST https://api.mistral.ai/v1/audio/speech \
  -H "Authorization: Bearer $MISTRAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "voxtral-mini-tts-2603",
    "input": "Ciao, sono Lara. Come posso aiutarti oggi?",
    "voice": "it_female",
    "response_format": "pcm"
  }' \
  --output /tmp/test-voxtral.pcm

# Ascolta (richiede ffplay):
ffplay -f s16le -ar 24000 -ac 1 /tmp/test-voxtral.pcm
```

**Criteri di accettazione**: voce italiana chiara, intonazione naturale, latenza risposta curl < 2s.

Se fallisce → controlla API key e modello (il nome modello potrebbe cambiare: verifica su https://docs.mistral.ai/capabilities/audio/).

---

## Step 2 — Configura TTS Voxtral in OpenClaw

Modifica `~/.openclaw/openclaw.json` — aggiungi/aggiorna la sezione `tts`:

```json
{
  "tts": {
    "provider": "openai",
    "openai": {
      "apiKey": "<MISTRAL_API_KEY>",
      "model": "voxtral-mini-tts-2603",
      "voice": "it_female"
    }
  }
}
```

> **Nota**: `apiKey` nel JSON evita collisioni con `OPENAI_API_KEY` globale.
> `OPENAI_TTS_BASE_URL` in `~/.bashrc` (Step 0) fa puntare le chiamate a Mistral.

---

## Step 3 — Configura LLM Mistral

```bash
# Nel repo openclaw (usa pnpm perché siamo in sorgente):
pnpm openclaw config set agent.model mistral/mistral-small-latest
```

> Modello scelto: `mistral-small-latest` per latenza voice (< 1s attesa).
> Se qualità insufficiente: prova `mistral/mistral-large-latest` (migliore, ~1.5s).
>
> La chiave viene letta da `MISTRAL_API_KEY` nell'ambiente — già in `~/.bashrc`.

---

## Step 4 — Riavvia gateway con nuovo stack

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

## Step 5 — Verifica stack completo sul device

```bash
# Log in tempo reale:
tail -f /tmp/openclaw-gateway.log | grep --line-buffered "XZ\|xiaozhi\|tts\|llm"

# Trace latenza:
jq -r '"[\(.ms)ms] IN: \(.input) | OUT: \(.output)"' /tmp/xiaozhi-llm-trace.jsonl
```

**Criteri di accettazione**:

- [ ] STT Groq funziona (< 300ms nei log)
- [ ] LLM Mistral risponde (cerca `mistral` nei log gateway)
- [ ] TTS Voxtral: audio italiano chiaro sul device
- [ ] Latenza totale: target < 4s (era 3.6-5.1s con Gemini+OpenAI TTS)

---

## Step 6 — P1C: Streaming TTS (dopo che Step 1-5 sono stabili)

> **Non fare prima che Step 1-5 siano verificati sul device fisico.**

Architettura target:

```
Groq STT (~150ms)
  → runEmbeddedPiAgent con onPartialReply
      → sentence boundary detector
          → Voxtral TTS per frase (~800ms)
              → Opus encode → tts:start + frames
  → frasi successive in pipeline
  → tts:stop
```

File da modificare: `extensions/xiaozhi/src/audio-pipeline.ts`

- Aggiungere `runAgentStreaming` con `onPartialReply`
- `speakChunk(text)` → chiama Voxtral → encode Opus → invia frames
- Sentence boundary: split su `.`, `!`, `?`, `\n` + buffer minimo ~30 chars

Target latenza percepita: **~700ms al primo audio** (da ~3.6s attuali).

---

## Note di rollback

Se qualcosa non funziona:

```bash
# Ripristina LLM Gemini:
pnpm openclaw config set agent.model google/gemini-3-flash-preview

# Ripristina TTS OpenAI: rimuovi la sezione tts da ~/.openclaw/openclaw.json
# e togli OPENAI_TTS_BASE_URL da ~/.bashrc

# Riavvia gateway con chiave Anthropic (stato precedente):
KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2-)
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
ANTHROPIC_API_KEY="$KEY" nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

---

## Checklist sessione

- [ ] Step 0: Mistral API key in `~/.bashrc` + ZDR Groq attivato
- [ ] Step 1: curl Voxtral → qualità audio ok
- [ ] Step 2: `~/.openclaw/openclaw.json` aggiornato TTS
- [ ] Step 3: `pnpm openclaw config set agent.model mistral/mistral-small-latest`
- [ ] Step 4: gateway riavviato con nuovo env
- [ ] Step 5: test device fisico — tutti i componenti funzionano
- [ ] Step 6: P1C streaming (sessione separata se serve)
