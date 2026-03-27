# Ottimizzazioni Post-MVP — LaraGoci / XiaoZhi BOX-3

> Data: 2026-03-26 — Aggiornato: 2026-03-27 — Stato: P0 COMPLETATO ✅, P1 da fare

---

## Situazione attuale (osservata in produzione)

Il sistema funziona end-to-end con hold-to-talk. Le aree di miglioramento sono:

1. ~~**Audio cracchia**~~ — ✅ RISOLTO (bitrate 48k + pcm_24000 + peak normalization B11)
2. **Latenza percettibile** — gap tra rilascio bottone e risposta audio (~6-9s stimati)
3. **Nessuno streaming** — il device inizia a parlare solo dopo che LLM + TTS sono completamente finiti
4. **Risposte troppo lunghe** — l'agente non ha un prompt che lo spinge a essere conciso

Display: **lasciato perdere per ora** — comportamento firmware accettato.

---

## Priorità

### P0 — Audio crackling ✅ COMPLETATO

Tre fix applicati (tutti in produzione):

| Fix                              | Commit    | Dettaglio                                                                                 |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| Opus bitrate 24k → 48k           | 141799983 | `DOWNLOAD_BITRATE = 48_000` in `audio-pipeline.ts:20`                                     |
| ElevenLabs pcm_22050 → pcm_24000 | 141799983 | `src/tts/tts.ts:85` — elimina resample 22050→24000 Hz                                     |
| Peak normalization B11           | 16119ff96 | `normalizePcm(pcm, 0.85)` — cap picchi a −1.4 dBFS, elimina pre-echo Opus su vocali forti |

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

#### Dove si configura ciascun componente

| Componente       | Dove si configura  | Note                                                      |
| ---------------- | ------------------ | --------------------------------------------------------- |
| LLM → Gemini     | OpenClaw config ✅ | `openclaw config set agent.model google/gemini-2.5-flash` |
| TTS → ElevenLabs | OpenClaw config ✅ | `tts.provider elevenlabs` + `apiKey` + `modelId`          |
| STT → Groq       | Estensione xiaozhi | OpenClaw non ha astrazione STT — rimane nel codice        |

#### Streaming TTS — architettura

Il guadagno maggiore in latenza **percepita** viene dallo streaming.
`runEmbeddedPiAgent` accetta già `onPartialReply` — nessun bypass necessario.

**Flusso attuale (batch):**

```
listen:stop → Whisper full (~1.5s) → Agent full (~3s) → TTS full (~2s) → Opus encode → send
                                                                         ↑
                                                         device inizia a parlare (~6-9s dopo)
```

**Flusso target (streaming):**

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

#### Risposte brevi (system prompt)

Aggiungere al system prompt dell'agente (`~/.openclaw/agents/main/AGENTS.md`):

```
Rispondi sempre in modo conciso: 1-2 frasi se la domanda è semplice.
Usa frasi più lunghe solo per spiegazioni tecniche o richieste complesse.
Niente premesse, niente conclusioni ridondanti.
```

---

## Modifiche al codice per P1

| File                                       | Modifica                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `extensions/xiaozhi/src/audio-pipeline.ts` | STT Groq (~20 righe); streaming: `runAgentStreaming`, `speakChunk`, refactor `process()` |
| `~/.openclaw/agents/main/AGENTS.md`        | System prompt conciso (path da verificare)                                               |

---

## Roadmap

```
FATTO:
  ✅ P0a: DOWNLOAD_BITRATE 24k → 48k
  ✅ P0b: ElevenLabs telephony pcm_22050 → pcm_24000 (fix nel core)
  ✅ B11: peak normalization — elimina picchi su vocali forti

PROSSIMA SESSIONE:
  → P1a: system prompt conciso (5 min, impatto immediato)
  → P1b-STT: migrare Whisper a Groq (~20 righe, massimo guadagno immediato)
  → P1b-LLM: configurare Gemini 2.5 Flash (solo config, zero codice)
  → P1b-TTS: configurare ElevenLabs (solo config, zero codice)
  → P1b-STREAMING: runAgentStreaming + speakChunk (sessione dedicata)

VERIFICA DOPO MIGRAZIONE:
  → Misurare latenza per componente nei log (già loggato con timestamp)
  → Test qualità audio ElevenLabs vs OpenAI TTS
  → Test interrupt B10 con streaming attivo (edge case da verificare)
```
