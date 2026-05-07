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

### Infrastruttura aggiunta

Aggiunto metodo virtuale `ResetInactivityTimer()` a `Board` base class,
overridden in `SensecapWatcher` per chiamare `power_save_timer_->WakeUp()`.

| File                  | Modifica                                 |
| --------------------- | ---------------------------------------- |
| `board.h`             | `virtual void ResetInactivityTimer() {}` |
| `sensecap_watcher.cc` | override → `power_save_timer_->WakeUp()` |

### WS WakeUp — tentato e rimosso

Inizialmente aggiunto `Board::GetInstance().ResetInactivityTimer()` nel
callback OnData di `websocket_protocol.cc`. **Rimosso** perche il gateway
invia keepalive ping ogni 8s (`bridge.ts:382-386`) che resettava ticks\_
a 0 continuamente, impedendo al timer di raggiungere 30s.

Il WakeUp su WS message non serve: gli eventi che contano (audio in/out,
bottone, knob) gia chiamano WakeUp(). Il keepalive ping non e interazione
utente e non deve resettare il timer.

### Rimosso anche SetPowerSaveMode()

Rimosse 3 chiamate a `GetDisplay()->SetPowerSaveMode()` in
`sensecap_watcher.cc` — superflue (display off/dimmed direttamente)
e rischiose (LVGL operations nel contesto del timer callback).

## Flusso completo

```
Evento (bottone/audio/knob)
    → power_save_timer_->WakeUp()  [ticks_ = 0]
    │
    ... 30s senza eventi ...
    │
    → PowerSaveCheck(): ticks_ >= 30
    → CanEnterSleepMode()? SI (device idle, audio idle)
    → OnEnterSleepMode()
    → EnterSleepMode() [R4]
    │
    ... sleep (display off o 5%, WiFi attivo) ...
    │
Evento wake (bottone/knob)
    → ExitSleepMode() [R4]
    → power_save_timer_->WakeUp()  [ticks_ = 0]
    → timer riparte da 0
```

## Verifica

- [x] 30s senza toccare → device entra in sleep
- [x] Click bottone durante countdown → reset timer
- [x] Conversazione attiva → timer non scade mai
- [x] Dopo wake da sleep → timer riparte da 0
- [x] Secondo ciclo sleep funziona (bug keepalive risolto)

## Complessita: S
