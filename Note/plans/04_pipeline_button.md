# Hold-to-Talk — Bottone schermo XiaoZhi BOX-3

> Data: 2026-03-25

## Contesto

Il protocollo XiaoZhi supporta tre modalità di ascolto (`mode`):

| mode       | Comportamento                                                                          |
| ---------- | -------------------------------------------------------------------------------------- |
| `auto`     | VAD hardware — il device manda `listen:stop` quando rileva silenzio                    |
| `manual`   | Hold-to-talk — press = `listen:start mode=manual`, release = `listen:stop mode=manual` |
| `realtime` | Continuo (non usato)                                                                   |

## Boot button vs Touch button

|         | Boot button (laterale sinistro)         | Touch button (schermo)                            |
| ------- | --------------------------------------- | ------------------------------------------------- |
| Press   | `listen:start`                          | `listen:start mode=manual` (se firmware supporta) |
| Release | **1006 disconnect** (non `listen:stop`) | `listen:stop mode=manual`                         |
| Flusso  | B8 → B9 (disconnect implicito)          | Clean start/stop nella stessa sessione WS         |

## Verifica serial monitor (2026-03-25)

Il touch button **non genera output sulla seriale** durante le prove.
Il firmware potrebbe già inviare i messaggi `mode=manual` sul WebSocket senza loggare su seriale.

Per verificare a runtime: guardare i log del gateway (filtro `XZ bridge`):

```bash
tail -f /tmp/openclaw-gateway.log | grep --line-buffered "XZ bridge.*listen"
```

Se il bottone schermo funziona in hold-to-talk si vedrà:

```
[XZ bridge] listen state=start mode=manual
[XZ bridge] listen state=stop mode=manual
```

Se invece il firmware è ancora in modalità toggle si vedrà solo:

```
[XZ bridge] listen state=start
```

seguito da una disconnessione 1006.

## State machine hold-to-talk (target)

```
IDLE
  ↓ [hold screen button] → listen:start mode=manual
LISTENING  (buffer Opus frame finché si tiene premuto)
  ↓ [rilascio] → listen:stop mode=manual
PROCESSING  (Whisper → Agent → TTS encode)
  ↓ tts:start inviato
SPEAKING  (rate-controlled 60ms/frame)
  ↓ tts:stop inviato
IDLE  (→ dialog mode: device manda listen:start auto se configurato)

INTERRUPT (B10):
  [hold durante processing/speaking] → listen:start mode=manual
    → tts:stop (se speaking) + generation++ → LISTENING
```

## Modifiche implementate (2026-03-25)

### `types.ts`

- Aggiunto campo `mode?: "auto" | "manual" | "realtime"` a `XiaozhuMessage`

### `audio-pipeline.ts`

- `onListenStart(mode?: string)`: guard `isInjectingB9` ora SALTA solo se `mode !== "manual"`.
  Un press manuale (mode=manual) durante B9 è un interrupt legittimo.
- `onListenStop(mode?: string)`: aggiunto log del mode
- `flushOnDisconnect()`: chiama `onListenStop("auto")` (B8 è sempre auto)

### `bridge.ts`

- `pipeline.onListenStart(msg.mode)` e `pipeline.onListenStop(msg.mode)`: passa il mode
- Log `[XZ bridge] listen state=... mode=...` include il campo mode se presente

## Fallback

B8 e B9 rimangono invariati: se il touch button genera ancora un 1006 disconnect
invece di `listen:stop`, il flusso B8/B9 continua a funzionare come prima.

## Prossimi step (se il firmware non supporta mode=manual)

1. Abilitare hold-to-talk nel firmware XiaoZhi:
   - Config `wakenet_mode` o equivalente in `sdkconfig`
   - Oppure aggiornare il firmware a una versione più recente che supporta il bottone schermo in mode=manual
2. Alternativa euristica: se `listen:stop` arriva entro 30s dalla stessa sessione WS → trattarlo come manual
