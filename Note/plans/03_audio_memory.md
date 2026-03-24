# Memoria sessione audio — 2026-03-24

## Stato pipeline

Round-trip audio FUNZIONANTE ✅ — STT → Agent → TTS → device riproduce audio.

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

## Prossimi task

- VAD: capire perché non funziona (configurazione firmware BOX-3)
- Dialog mode: dopo tts:stop il device dovrebbe mandare listen:start automatico
- Wake word "goci goci": post-MVP (vedi `Note/plans/02_Audio_pipeline.md`)
