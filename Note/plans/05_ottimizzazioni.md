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

d
Committed "docs(xiaozhi): 05_ottimizzazioni — piano P0 bitrate, P1 streaming Groq+Gemini+ElevenLabs" with 1 files

● Fatto — 94db3c797. Il piano è documentato con il punto critico dello streaming marcato come "da verificare" prima di toccare qualsiasi cosa.

Prossimo passo concreto: P0 — cambiare il bitrate da 24k a 48k. Vuoi farlo adesso?

❯ è corretto che questi paramenti si mettano direttamente nell'esteszione e non nelle conf di openclaw? alla fine attualemente claude è coonfigurato nelle cconfig di openclaw

● Ottima domanda architetturale. Verifichiamo cosa fa già il runtime.

● Searched for 7 patterns (ctrl+o to expand)

● Risposta precisa per ciascun componente:

TTS → ElevenLabs ✅ già nel core OpenClaw
TtsProvider = "elevenlabs" | "openai" | "edge" — è già supportato, configurabile via:
openclaw config set tts.provider elevenlabs
openclaw config set tts.elevenlabs.apiKey <key>
openclaw config set tts.elevenlabs.modelId eleven_turbo_v2_5
textToSpeechTelephony lo usa automaticamente. Zero modifiche all'estensione.

LLM → Gemini — da verificare
Dipende da quali provider LLM OpenClaw supporta. Se Gemini è supportato, basta cambiare il modello in config come già si fa con Claude.

STT → Groq ❌ non nel core
OpenClaw non ha un'astrazione STT per upload file. L'estensione chiama già OpenAI direttamente — Groq è lo stesso pattern, URL diverso. Questo deve stare nell'estensione.

---

Nota sul formato ElevenLabs telephony: ho visto che il core mappa elevenlabs telephony a pcm_22050 (22kHz), non 24kHz. Se la pipeline XiaoZhi aspetta 24kHz, c'è un mismatch — verifichiamo prima di attivarlo
via config.

Aggiorno il file 05 con queste info?

✻ Sautéed for 1m 5s

❯ verifica questo LLM → Gemini — da verificare  
 Dipende da quali provider LLM OpenClaw supporta. Se Gemini è supportato, basta cambiare il modello in config come già si fa con Claude.

● Searched for 5 patterns, read 1 file (ctrl+o to expand)

● ✅ Gemini è supportato nativamente in OpenClaw.

● Searched for 2 patterns (ctrl+o to expand)

● Risposta definitiva:

Gemini ✅ supportato nativamente in OpenClaw — ha provider google con API key, e c'è già applyGoogleGeminiModelDefault nel codebase.

Per migrare il LLM basta:
openclaw login # scegli Google/Gemini, inserisci API key
openclaw config set agent.model google/gemini-2.5-flash

Zero modifiche all'estensione — esattamente come Claude ora.

Riepilogo architetturale definitivo:

┌──────────────────┬────────────────────┬─────────────────────────────────────────────────────────┐
│ Componente │ Dove si configura │ Note │
├──────────────────┼────────────────────┼─────────────────────────────────────────────────────────┤
│ LLM → Gemini │ OpenClaw config ✅ │ openclaw config set agent.model google/gemini-2.5-flash │
├──────────────────┼────────────────────┼─────────────────────────────────────────────────────────┤
│ TTS → ElevenLabs │ OpenClaw config ✅ │ tts.provider elevenlabs + apiKey + modelId │
├──────────────────┼────────────────────┼─────────────────────────────────────────────────────────┤
│ STT → Groq │ Estensione xiaozhi │ OpenClaw non ha astrazione STT — rimane nel codice │
└──────────────────┴────────────────────┴─────────────────────────────────────────────────────────┘

Solo STT tocca il codice dell'estensione. Tutto il resto è configurazione.

✻ Crunched for 43s

❯ che cos'è evelenlabs telefony ? che effetti colllateraili può avere fai una verifica

● Searched for 1 pattern, read 1 file (ctrl+o to expand)

● Trovato il problema. Risultato della verifica:

Cos'è telephony: è la modalità TTS pensata per voice call/telefonia — restituisce PCM raw (non MP3/Opus) a basso sample rate, pronto per essere inviato al dispositivo voce.

Il problema concreto con ElevenLabs:

TELEPHONY_OUTPUT = {
openai: { format: "pcm", sampleRate: 24000 } ← esatto per XiaoZhi
elevenlabs: { format: "pcm_22050", sampleRate: 22050 } ← ⚠️ mismatch!
}

Con OpenAI: 24kHz → resamplePcm è no-op (stessa frequenza) → nessun artefatto

Con ElevenLabs via config: 22050 Hz → resamplePcm converte 22050→24000 Hz con interpolazione lineare (qualità bassa, ratio non intero 0.918) → introduce artefatti audio

Ovvero: attivare ElevenLabs via tts.provider elevenlabs potrebbe suonare PEGGIO di OpenAI, nonostante la voce sia migliore.

Opzioni per risolvere:

┌────────────────────────────────────────────────────────────────┬────────┬───────────────────────────────────────────────────────────────────────┐
│ Opzione │ Effort │ Note │
├────────────────────────────────────────────────────────────────┼────────┼───────────────────────────────────────────────────────────────────────┤
│ Chiamare ElevenLabs direttamente nell'estensione con pcm_24000 │ basso │ ElevenLabs supporta pcm_24000 natively — bypass il telephony del core │
├────────────────────────────────────────────────────────────────┼────────┼───────────────────────────────────────────────────────────────────────┤
│ Modificare TELEPHONY_OUTPUT.elevenlabs nel core a pcm_24000 │ minimo │ Fix corretto per tutti i canali voice, ma tocca il core │
├────────────────────────────────────────────────────────────────┼────────┼───────────────────────────────────────────────────────────────────────┤
│ Migliorare il resampler (Lanczos invece di lineare) │ medio │ Fix generale, utile anche per altri casi │
