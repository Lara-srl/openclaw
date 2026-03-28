# Piano: Ottimizzazioni Audio XiaoZhi — Bitrate, pcm_24000, Streaming TTS

> Aggiornato: 2026-03-27 — Stato: P0 COMPLETATO ✅, P1 da fare

---

## Context

La pipeline XiaoZhi funziona end-to-end (hold-to-talk, B8/B9/B10/B11 risolti). Le ottimizzazioni
prioritarie sono:

1. ~~Audio che cracchia~~ → ✅ **RISOLTO** (P0a bitrate + P0b pcm_24000 + B11 peak norm)
2. **Latenza percettibile** (~6-9s) → il device inizia a parlare solo dopo LLM + TTS completi
3. **Risposte troppo lunghe** → system prompt dell'agente mancante di istruzioni concisione

---

## P0a — Opus bitrate: 24kbps → 48kbps ✅ FATTO (commit 141799983)

**File:** `extensions/xiaozhi/src/audio-pipeline.ts:20`

```ts
const DOWNLOAD_BITRATE = 48_000; // era 24_000
```

---

## P0b — ElevenLabs telephony: pcm_22050 → pcm_24000 ✅ FATTO (commit 141799983)

**File:** `src/tts/tts.ts:85`

```ts
elevenlabs: { format: "pcm_24000", sampleRate: 24000 }, // era pcm_22050 / 22050
```

**Impatto:** fix globale per tutti i canali voice OpenClaw che usano ElevenLabs telephony.
Il resampler in `audio-pipeline.ts` diventa no-op (`fromRate === toRate`).

---

## B11 — Peak normalization: elimina picchi su vocali forti ✅ FATTO (commit 16119ff96)

**File:** `extensions/xiaozhi/src/audio-pipeline.ts`

**Causa:** OpenAI TTS genera PCM near-full-scale → Opus SILK produce pre-echo su onset vocali aperte.

**Fix:** `normalizePcm(pcm, targetPeak)` — scansiona il buffer, scala se il picco supera la soglia.
Solo attenua, non amplifica mai.

```ts
const pcmResampled = resamplePcm(result.audioBuffer, result.sampleRate, DOWNLOAD_RATE);
const pcm24k = normalizePcm(pcmResampled, 0.85); // cap peaks at ~-1.4 dBFS
```

**Calibrazione:**

- `0.707` (−3 dBFS) → nessun artefatto, volume leggermente più basso
- `0.85` (−1.4 dBFS) → audio pieno, nessun picco ← **valore scelto e verificato**
- Se tornassero artefatti: abbassare a `0.75`; se troppo basso: alzare a `0.90`

---

## P1a — System prompt conciso nel main agent (da fare, ~5 min)

**File:** `~/.openclaw/agents/main/AGENTS.md` (path da verificare sulla macchina)

Aggiungere:

```
Rispondi in modo conciso: 1-2 frasi se la domanda è semplice.
Usa risposte più lunghe solo per spiegazioni tecniche o richieste complesse.
Niente premesse, niente conclusioni ridondanti.
```

---

## P1b — Migrazione stack: Groq STT + Gemini LLM + ElevenLabs TTS (da fare)

### Dove si configura ciascun componente

| Componente       | Dove si configura  | Note                                                      |
| ---------------- | ------------------ | --------------------------------------------------------- |
| LLM → Gemini     | OpenClaw config ✅ | `openclaw config set agent.model google/gemini-2.5-flash` |
| TTS → ElevenLabs | OpenClaw config ✅ | `tts.provider elevenlabs` + `apiKey` + `modelId`          |
| STT → Groq       | Estensione xiaozhi | OpenClaw non ha astrazione STT — rimane nel codice        |

### Comandi di configurazione (zero codice per LLM e TTS)

```bash
openclaw login  # scegli Google/Gemini, inserisci API key
openclaw config set agent.model google/gemini-2.5-flash
openclaw config set tts.provider elevenlabs
openclaw config set tts.elevenlabs.apiKey <key>
openclaw config set tts.elevenlabs.modelId eleven_turbo_v2_5
```

### STT → Groq (~20 righe in audio-pipeline.ts)

Sostituire la chiamata `whisperTranscribe` con una verso l'endpoint Groq compatibile OpenAI:

```ts
// URL da cambiare in whisperTranscribe():
"https://api.groq.com/openai/v1/audio/transcriptions";
// model da cambiare:
"whisper-large-v3";
// API key da usare:
process.env.GROQ_API_KEY;
```

---

## P1c — Streaming TTS via onPartialReply (da fare, sessione dedicata)

### Analisi: nessun bypass necessario

`runEmbeddedPiAgent` accetta già `onPartialReply?: (payload: { text?: string }) => void`.
La callback riceve il testo **accumulato** aggiornato ad ogni token. Sessione, tool, memory,
auth failover, compaction restano invariati.

### Flusso target

```
listen:stop → Groq STT (~150ms) → runEmbeddedPiAgent (con onPartialReply)
                  ↓ ogni token accumulato
             buffer → sentence boundary?
                  ↓ prima frase (~400ms)
             TTS chunk → Opus encode → tts:start + frames
                  ↓ frasi successive
             TTS chunk → Opus encode → frames → tts:stop
                                                     ↑
                                      device inizia a parlare (~700ms dopo)
```

### Modifiche a `audio-pipeline.ts`

**1. `runAgentStreaming`** — sostituisce `runAgent` nel path streaming:

```ts
private async runAgentStreaming(
  text: string,
  onSentence: (sentence: string, isFirst: boolean) => Promise<void>,
): Promise<void> {
  // ...setup identico a runAgent...
  let lastSent = 0;
  let buffer = "";
  let isFirst = true;

  await deps.runEmbeddedPiAgent({
    // ...params esistenti...
    onPartialReply: async ({ text: full }) => {
      if (!full) return;
      const delta = full.slice(lastSent);
      buffer += delta;
      lastSent = full.length;
      const match = buffer.match(/^(.*?[.?!])\s+(.*)$/s);
      if (match || buffer.length > 120) {
        const sentence = match ? match[1] : buffer;
        buffer = match ? match[2] : "";
        await onSentence(sentence.trim(), isFirst);
        isFirst = false;
      }
    },
  });
  if (buffer.trim()) await onSentence(buffer.trim(), isFirst);
}
```

**2. Refactor di `process()`:**

```ts
// da (batch):
const response = await this.runAgent(text);
if (response) await this.speak(response);

// a (streaming):
let ttsStarted = false;
await this.runAgentStreaming(text, async (sentence, isFirst) => {
  if (gen !== this.generation) return; // B10 interrupt check
  if (isFirst) this.sendTtsStart();
  ttsStarted = true;
  await this.speakChunk(sentence, gen);
});
if (ttsStarted) this.sendTtsStop();
```

**3. `speakChunk(text, gen)`** — TTS + Opus encode + rate-ctrl per un singolo chunk.
Estrae la logica TTS dall'attuale `speak()`, aggiunge check `gen` dopo ogni operazione costosa.

### Compatibilità B10

Il check `if (gen !== this.generation) return` dopo ogni `speakChunk` garantisce che un
interrupt durante lo streaming interrompa il flusso esattamente come nel batch.

---

## Ordine di implementazione

```
FATTO ✅:
  P0a — bitrate 48k
  P0b — ElevenLabs pcm_24000
  B11 — peak normalization

PROSSIMA SESSIONE:
  1. P1a — system prompt conciso (5 min)
  2. P1b — Groq STT (~20 righe codice)
  3. P1b — Gemini LLM + ElevenLabs TTS (solo config)
  4. Verifica latenza nei log
  5. P1c — streaming (sessione dedicata, refactor più grande)

VERIFICA DOPO P1b:
  → `tts:start` deve apparire ~1-2s dopo `listen:stop` (era ~6s)
  → Test qualità audio ElevenLabs
  → Test B10 (interrupt) con nuovo stack

VERIFICA DOPO P1c (streaming):
  → `tts:start` deve apparire ~700ms dopo `listen:stop`
  → Test B10 durante streaming (press durante speaking chunk intermedio)

POST-MVP — Gestione sessione per assistente vocale:
  → Problema: sessione cresce durante la giornata → più token → latenza Agent crescente + risposte più lunghe
  → Fix: reset automatico sessione in audio-pipeline.ts (ogni N turni o ogni giorno)
  → Alternativa: session TTL aggressivo (< 30min invece di 1h)
  → Da monitorare: latenza Agent nel corso della giornata per verificare degradazione
```
