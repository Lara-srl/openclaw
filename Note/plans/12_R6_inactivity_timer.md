# R6 — Timer inattivita (auto-sleep a 30s) ✅ COMPLETATO

**Parent**: [12_Plan_Battery.md](./12_Plan_Battery.md)
**Dipende da**: [R4](./12_R4_sleep_mode.md) (EnterSleepMode)

## Stato

La maggior parte di R6 era gia implementata in R4:

- ✅ Timeout 30s (`PowerSaveTimer(-1, 30, -1)`)
- ✅ `OnEnterSleepMode` → `EnterSleepMode()`
- ✅ `OnExitSleepMode` → `ExitSleepMode()`
- ✅ `CanEnterSleepMode()` blocca sleep durante conversazione
- ✅ Button click → `WakeUp()`
- ✅ Knob rotate → `WakeUp()`
- ✅ Audio input/output → `WakeUp()` (via Application)

Unica aggiunta R6: **WakeUp su WS message**

## Implementazione WS WakeUp

Aggiunto metodo virtuale `ResetInactivityTimer()` a `Board` base class,
overridden in `SensecapWatcher` per chiamare `power_save_timer_->WakeUp()`.
Chiamato in `websocket_protocol.cc` OnData callback.

### File modificati

| File                        | Modifica                                                 |
| --------------------------- | -------------------------------------------------------- |
| `board.h`                   | `virtual void ResetInactivityTimer() {}`                 |
| `sensecap_watcher.cc`       | override → `power_save_timer_->WakeUp()`                 |
| `websocket_protocol.cc:166` | `Board::GetInstance().ResetInactivityTimer()` nel OnData |

## Flusso completo

```
Evento (bottone/audio/knob/WS message)
    → power_save_timer_->WakeUp()  [ticks_ = 0]
    │
    ... 30s senza eventi ...
    │
    → PowerSaveCheck(): ticks_ >= 30
    → CanEnterSleepMode()? SI (device idle, audio idle)
    → OnEnterSleepMode()
    → EnterSleepMode() [R4]
    │
    ... sleep (display off, WiFi attivo) ...
    │
Evento wake (bottone/WS)
    → ExitSleepMode() [R4]
    → power_save_timer_->WakeUp()  [ticks_ = 0]
    → timer riparte da 0
```

## Verifica

- [x] 30s senza toccare → device entra in sleep
- [x] Click bottone durante countdown → reset timer
- [x] Conversazione attiva → timer non scade mai
- [x] WS message durante countdown → reset timer
- [x] Dopo wake da sleep → timer riparte da 0

## Complessita: S
