# Memoria sessione audio — aggiornata 2026-03-25

## Stato pipeline

Round-trip audio FUNZIONANTE ✅ — STT → Agent → TTS → device riproduce audio.
**B10 IMPLEMENTATO ✅** — interrupt mid-session: bottone durante processing/speaking funziona.

## Device

- MAC: `b4:3a:45:f3:96:30`
- Comportamento bottone: click 1 = listen:start, click 2 = 1006 disconnect (non manda listen:stop)
- VAD hardware non funziona (no listen:stop automatico su silenzio)
- Il device si riconnette automaticamente dopo ogni interazione

## Bug risolti in questa sessione

### B8 — Device disconnette (1006) invece di mandare listen:stop ✅

**Fix:** `flushOnDisconnect()` in `AudioPipeline` — se state=listening con frame bufferizzati al close, triggera `onListenStop()` implicito. STT + agent girano, TTS silently no-op (WS chiusa).

### B9 — TTS perso su WS già chiusa ✅

**Fix:** in `speak()`, se `ws.readyState !== OPEN` dopo encode → chiama `onTtsReady(frames)`. Bridge salva in `pendingTts = Map<deviceId, Buffer[]>`. Al prossimo reconnect → `injectTts(pending)` invia i frame sulla nuova WS (state→speaking → blocca listen:start → tts:stop → idle).

### Whisper lingua ✅

Rimosso lock `language: "it"` → auto-detect multilingua.

### API key doppia ✅

Due chiavi su account diversi. Chiave corretta (crediti attivi): `sk-ant-api03-gjSc...` in `~/.bashrc`. Gateway deve essere avviato con key esplicita (vedi `Note/comandi.md`).

## File modificati

- `extensions/xiaozhi/src/audio-pipeline.ts` — flushOnDisconnect, injectTts, onTtsReady callback, Whisper auto-detect
- `extensions/xiaozhi/src/bridge.ts` — pendingTts Map, injectTts al connect, callback B9

### B10 — onListenStart guard: no interrupt mid-session ✅ (2026-03-25)

**Fix parte 1:** rimossa guard `if (state !== "idle") return`. `onListenStart()` ora interrompe da qualsiasi stato: manda `tts:stop` se speaking, `generation++` cancella tutto in volo.

**Fix parte 2:** flag `isInjectingB9` blocca `onListenStart()` durante B9 injection (il device manda 2× `listen:start` automatici su ogni connect — non sono veri press utente). Flag pulito dopo inject o su `onAbort()`.

**File modificati:** `extensions/xiaozhi/src/audio-pipeline.ts` — solo `onListenStart()`, `injectTts()`, `onAbort()`.

## Prossimi task

- **Test interrupt:** premi bottone durante processing → log `interrupt (era: processing)`; premi durante speaking → log `interrupt (era: speaking)` + tts:stop al device
- VAD: capire perché non funziona (configurazione firmware BOX-3)
- Dialog mode: dopo tts:stop il device dovrebbe mandare listen:start automatico (già previsto)
- Wake word "goci goci": post-MVP (vedi `Note/plans/02_Audio_pipeline.md`)
