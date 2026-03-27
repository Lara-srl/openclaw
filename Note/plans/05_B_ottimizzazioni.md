# Piano: Ottimizzazioni Audio XiaoZhi — Bitrate, pcm_24000, Streaming TTS

## laude --resume 96959330-5615-4d83-80d6-dc9806ff9538

## Context

La pipeline XiaoZhi funziona end-to-end (hold-to-talk, B8/B9/B10 risolti). Le ottimizzazioni
prioritarie sono:

1. Audio che cracchia → Opus bitrate troppo basso + ElevenLabs restituisce 22050 Hz che viene
   resamplinato con interpolazione lineare invece di essere richiesto direttamente a 24000 Hz
2. Latenza percettibile (~6-9s) → il device inizia a parlare solo dopo che LLM + TTS sono
   completamente finiti. Lo streaming via `onPartialReply` (già nel SDK) elimina questo gap.
3. Risposte troppo lunghe → system prompt del main agent mancante di istruzioni concisione.

---

## P0a — Opus bitrate: 24kbps → 48kbps

**File:** `extensions/xiaozhi/src/audio-pipeline.ts:20`

```ts
// da:
const DOWNLOAD_BITRATE = 24_000;
// a:
const DOWNLOAD_BITRATE = 48_000;
```

**Impatto:** nessuno sul protocollo (Opus è self-describing). Il device decodifica qualsiasi bitrate.

---

## P0b — ElevenLabs telephony: pcm_22050 → pcm_24000 (fix nel core)

**Problema:** `TELEPHONY_OUTPUT.elevenlabs = { format: "pcm_22050", sampleRate: 22050 }` in
`src/tts/tts.ts:85`. Quando ElevenLabs è il provider TTS, restituisce 22050 Hz che viene
resamplinato a 24000 Hz con interpolazione lineare → artefatti audio.

**Verifica:** ElevenLabs supporta nativamente `pcm_24000` (S16LE, 24kHz) su tutti i modelli
incluso `eleven_turbo_v2_5`. Nessuna differenza di latenza. Richiede tier Creator o superiore
(stesso del pcm_22050).

**File:** `src/tts/tts.ts:85`

```ts
// da:
elevenlabs: { format: "pcm_22050", sampleRate: 22050 },
// a:
elevenlabs: { format: "pcm_24000", sampleRate: 24000 },
```

**Impatto:** fix globale per tutti i canali voice OpenClaw che usano ElevenLabs telephony
(voice-call, xiaozhi, futuri canali). Il resampler in audio-pipeline.ts diventa no-op
(`fromRate === toRate` → restituisce buffer invariato).

---

## P1a — System prompt conciso nel main agent

**File:** `~/.openclaw/agents/main/AGENTS.md` (o equivalente agent config)

Aggiungere istruzione:

```
Rispondi in modo conciso: 1-2 frasi se la domanda è semplice.
Usa risposte più lunghe solo per spiegazioni tecniche o richieste complesse.
Niente premesse, niente conclusioni ridondanti.
```

**Nota:** questo file va verificato — path esatto dipende dalla configurazione locale.

---

## P1b — Streaming TTS via onPartialReply

### Analisi: nessun bypass necessario

`runEmbeddedPiAgent` accetta già `onPartialReply?: (payload: { text?: string }) => void`
(`src/agents/pi-embedded-runner/run/params.ts:89`). La callback riceve il testo **accumulato**
aggiornato ad ogni token. Bypassing non necessario → sessione, tool, memory, auth failover,
compaction restano invariati.

### Architettura

**Flusso attuale (batch):**

```
listen:stop → Groq STT → runEmbeddedPiAgent (batch) → speak(full text) → tts:start + frames + tts:stop
                                                                                                ↑
                                                                           device inizia a parlare qui (~6-9s)
```

**Flusso target (streaming):**

```
listen:stop → Groq STT → runEmbeddedPiAgent (con onPartialReply)
                              ↓ ogni token accumulato
                         buffer → sentence boundary?
                              ↓ prima frase (~400ms)
                         TTS chunk → Opus encode → tts:start + frames
                              ↓ frasi successive
                         TTS chunk → Opus encode → frames
                              ↓ agente finisce
                         flush buffer → TTS → frames → tts:stop
                                                              ↑
                                                device inizia a parlare qui (~700ms)
```

### Modifiche a `extensions/xiaozhi/src/audio-pipeline.ts`

**1. Nuova funzione `runAgentStreaming`** (sostituisce `runAgent` nel path streaming):

```ts
private async runAgentStreaming(
  text: string,
  onSentence: (sentence: string, isFirst: boolean) => Promise<void>,
): Promise<void> {
  // ...setup identico a runAgent...
  let accumulated = "";
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
      // sentence boundary: ". " "? " "! " o buffer > 120 chars con spazio
      const match = buffer.match(/^(.*?[.?!])\s+(.*)$/s);
      if (match || buffer.length > 120) {
        const sentence = match ? match[1] : buffer;
        buffer = match ? match[2] : "";
        await onSentence(sentence.trim(), isFirst);
        isFirst = false;
      }
    },
  });
  // flush residuo
  if (buffer.trim()) await onSentence(buffer.trim(), isFirst);
}
```

**2. Refactor di `process()`** — sostituire la chiamata sequenziale:

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

**3. Nuova funzione `speakChunk(text, gen)`** — TTS + Opus encode + rate-ctrl per un singolo chunk:
Estrae la logica TTS dall'attuale `speak()`, aggiunge check `gen` dopo ogni operazione costosa.

**4. `sendTtsStart()` / `sendTtsStop()`** — estratti da `speak()` come metodi separati.

### Compatibilità B10

Il check `if (gen !== this.generation) return` dopo ogni `speakChunk` garantisce che un
interrupt durante lo streaming interrompa il flusso esattamente come nel batch. Il
`rate-ctrl` esistente rimane invariato per chunk.

---

## File da modificare

| File                                          | Modifica                                                     |
| --------------------------------------------- | ------------------------------------------------------------ |
| `src/tts/tts.ts:85`                           | P0b: `pcm_22050` → `pcm_24000`                               |
| `extensions/xiaozhi/src/audio-pipeline.ts:20` | P0a: bitrate 24k → 48k                                       |
| `extensions/xiaozhi/src/audio-pipeline.ts`    | P1b: `runAgentStreaming`, `speakChunk`, refactor `process()` |
| `~/.openclaw/agents/main/AGENTS.md`           | P1a: system prompt conciso (path da verificare)              |

---

## Ordine di implementazione

1. **P0a + P0b** insieme (2 righe, test immediato → ascoltare il TTS)
2. **P1a** (5 minuti, impatto immediato sulla lunghezza risposte)
3. **P1b** (sessione dedicata — refactor più grande, testate B10 dopo)

---

## Verifica

- P0a/P0b: riavviare gateway → parlare con device → audio non cracchia, ElevenLabs (quando configurato) non viene resamplinato
- P1a: chiedere "che ore sono?" → risposta 1-2 frasi
- P1b: nei log gateway deve apparire `tts:start` ~700ms dopo `listen:stop` invece di ~6s
  - Testare B10 durante streaming (press durante speaking) → deve interrompere correttamente
