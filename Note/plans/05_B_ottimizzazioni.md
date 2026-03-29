# Piano: Ottimizzazioni Audio XiaoZhi — Bitrate, pcm_24000, Streaming TTS

> Aggiornato: 2026-03-29 — Stato: P0 ✅, P1a ✅, P1b-STT ✅, P1b-LLM ✅, P1c da fare

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

## P1a — System prompt conciso ✅ FATTO (2026-03-29)

**Approccio scelto:** `extraSystemPrompt` in `runEmbeddedPiAgent` — non tocca il workspace globale.

**File:** `extensions/xiaozhi/src/audio-pipeline.ts` — costante `VOICE_EXTRA_SYSTEM_PROMPT` in sezione
`// ─── Agent prompts ───` (top del file, unico punto da editare).

**Contenuto:**

```
MODALITÀ VOCALE — priorità assoluta su tutto il resto:
- La lunghezza dipende dalla domanda: domanda semplice → 1-2 frasi; domanda complessa → quanto serve, max 6-7 frasi
- MAI markdown, emoji, elenchi puntati o numerati — parla sempre in prosa fluente
- MAI premesse, intro o recap — vai diretto alla risposta
- Tono conversazionale naturale, come se stessi parlando ad alta voce
```

**Nota design (2026-03-29):** il limite fisso "30 parole" è stato rimosso — un agente sempre corto
perde naturalezza su domande complesse. La lunghezza adattiva è più simile a ChatGPT Voice / Gemini Live.
Questo rende P1c streaming più rilevante (risposte lunghe beneficiano molto dello streaming).

**Aggiunto anche:** trace JSONL in `/tmp/xiaozhi-llm-trace.jsonl` — ogni call logga `{ts, ms, input, output, sessionFile}`.
Lettura: `jq -r '"[\(.ms)ms]\n  IN:  \(.input)\n  OUT: \(.output)"' /tmp/xiaozhi-llm-trace.jsonl`

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
  P1a — extraSystemPrompt voice rules + JSONL trace
  P1b-STT — Groq whisper-large-v3-turbo (~150ms)
  P1b-LLM — Gemini 3 Flash Preview (config: agents.defaults.model)

MISURAZIONI REALI (2026-03-29, Gemini 3 Flash + Groq STT):
  → 3617ms e 5105ms dal trace — già molto meglio di 6-9s con Opus
  → cacheRead=0 sempre: Gemini non ha prompt caching automatico (vedi TO_DO T1)
  → input tokens: ~15k per call (workspace gonfia, vedi TO_DO T3)

PROSSIMA SESSIONE:
  → P1c — streaming TTS (onPartialReply → speakChunk, sessione dedicata)

POST-MVP — Da implementare (vedi TO_DO.md):
  → T1: Gemini context caching esplicito
  → T2: Session reset automatico (sliding window)
  → T3: Workspace trimming (da 15k a ~5k token)
```
