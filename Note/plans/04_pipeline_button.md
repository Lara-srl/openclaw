# Hold-to-Talk — Boot button XiaoZhi BOX-3

> Data: 2026-03-25

## Contesto

Il protocollo XiaoZhi supporta tre modalità di ascolto (`mode`):

| mode       | Comportamento                                                                          |
| ---------- | -------------------------------------------------------------------------------------- |
| `auto`     | VAD hardware — il device manda `listen:stop` quando rileva silenzio                    |
| `manual`   | Hold-to-talk — press = `listen:start mode=manual`, release = `listen:stop mode=manual` |
| `realtime` | Continuo (non usato)                                                                   |

## Boot button vs Touch button

Il touch button schermo **non è mappato** nel firmware XiaoZhi per BOX-3 — solo `BOOT_BUTTON_GPIO = GPIO_NUM_0` è configurato in `main/boards/esp-box-3/config.h`. Non genera né output seriale né messaggi WS.

La soluzione è modificare il **boot button** (laterale sinistro) da click-toggle a hold-to-talk.

|         | Boot button — prima (toggle)            | Boot button — dopo (hold-to-talk)         |
| ------- | --------------------------------------- | ----------------------------------------- |
| Press   | `listen:start mode=auto`                | `listen:start mode=manual`                |
| Release | **1006 disconnect** (non `listen:stop`) | `listen:stop mode=manual`                 |
| Flusso  | B8 → B9 (disconnect implicito)          | Clean start/stop nella stessa sessione WS |

## Modifiche firmware — `main/boards/esp-box-3/esp_box3_board.cc`

Funzione `InitializeButtons()` — sostituire `OnClick` con `OnPressDown` + `OnPressUp`:

```cpp
void InitializeButtons() {
    boot_button_.OnPressDown([this]() {
        auto& app = Application::GetInstance();
        if (app.GetDeviceState() == kDeviceStateStarting) {
            EnterWifiConfigMode();
            return;
        }
        app.SetListeningMode(kListeningModeManualStop);
        app.StartListening();
    });

    boot_button_.OnPressUp([this]() {
        auto& app = Application::GetInstance();
        if (app.GetDeviceState() == kDeviceStateListening) {
            app.StopListening();
        }
    });

#if CONFIG_USE_DEVICE_AEC
    boot_button_.OnDoubleClick([this]() {
        auto& app = Application::GetInstance();
        if (app.GetDeviceState() == kDeviceStateIdle) {
            app.SetAecMode(app.GetAecMode() == kAecOff ? kAecOnDeviceSide : kAecOff);
        }
    });
#endif
}
```

**Note:**

- `kListeningModeManualStop` → il firmware manda `mode=manual` nel `listen:start`
- `OnDoubleClick` AEC mantenuto (dentro `#if CONFIG_USE_DEVICE_AEC`)
- Il file `.bk` creato come backup non influenza il build (CMake ignora i file non dichiarati in `CMakeLists.txt`)

## Build e flash

```powershell
cd C:\esp\xiaozhi-esp32
idf.py -p COM8 build flash monitor
```

Se la build usa cache e non ricompila il file modificato, forzare una build pulita:

```powershell
idf.py fullclean
idf.py -p COM8 build flash monitor
```

Esci dal monitor seriale con `Ctrl+]`.

## Stato verifica (2026-03-25)

Primo flash: firmware mandava ancora `mode=auto` → build non ha ricompilato `esp_box3_board.cc`.
**Da fare:** verificare che il file sia salvato, poi `idf.py fullclean && idf.py -p COM8 build flash`.

Log atteso dopo fix:

```
[XZ bridge] listen state=start mode=manual
[XZ listen] start mode=manual
[XZ bridge] listen state=stop mode=manual
[XZ listen] stop — N frames mode=manual
```

## Modifiche OpenClaw implementate (2026-03-25)

### `types.ts`

- Aggiunto campo `mode?: "auto" | "manual" | "realtime"` a `XiaozhuMessage`

### `audio-pipeline.ts`

- `onListenStart(mode?: string)`: guard `isInjectingB9` blocca solo `mode !== "manual"` — un press manuale durante B9 è un interrupt legittimo
- `onListenStop(mode?: string)`: log include il mode
- `flushOnDisconnect()`: chiama `onListenStop("auto")` (B8 è sempre auto)

### `bridge.ts`

- Passa `msg.mode` a `pipeline.onListenStart/Stop`
- Log `[XZ bridge] listen state=... mode=...`

## State machine hold-to-talk (target)

```
IDLE
  ↓ [hold boot button] → listen:start mode=manual
LISTENING  (buffer Opus frame finché si tiene premuto)
  ↓ [rilascio] → listen:stop mode=manual
PROCESSING  (Whisper → Agent → TTS encode)
  ↓ tts:start inviato
SPEAKING  (rate-controlled 60ms/frame)
  ↓ tts:stop inviato
IDLE

INTERRUPT (B10):
  [hold durante processing/speaking] → listen:start mode=manual
    → tts:stop (se speaking) + generation++ → LISTENING
```

## Fallback

B8 e B9 rimangono invariati per edge cases (es. disconnect improvviso durante listening).
