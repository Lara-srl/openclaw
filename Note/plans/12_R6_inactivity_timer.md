# R6 — Timer inattivita (auto-sleep a 30s)

**Parent**: [12_Plan_Battery.md](./12_Plan_Battery.md)
**Dipende da**: [R4](./12_R4_sleep_mode.md) (EnterSleepMode)

## Meccanismo attuale

**File**: `Note/main/boards/common/power_save_timer.cc`

Il `PowerSaveTimer` ha gia un timer a 1Hz che conta i secondi di inattivita:

```
PowerSaveCheck() [ogni 1s]:
    ticks_++
    se CanEnterSleepMode() == false → ticks_ = 0 (reset)
    se ticks_ >= seconds_to_sleep_ → OnEnterSleepMode()
    se ticks_ >= seconds_to_shutdown_ → OnShutdownRequest()
```

`WakeUp()` resetta `ticks_ = 0` e esce da sleep se attivo.

### Cosa resetta il timer oggi

`power_save_timer_->WakeUp()` viene chiamato in:

| Punto di chiamata              | File                      | Evento              |
| ------------------------------ | ------------------------- | ------------------- |
| `BUTTON_SINGLE_CLICK`          | `sensecap_watcher.cc:277` | Click bottone       |
| `Application::OnAudioInput()`  | `application.cc`          | Audio ricevuto      |
| `Application::OnAudioOutput()` | `application.cc`          | TTS in riproduzione |

### Cosa manca

Per il requisito "qualsiasi evento resetta il timer" serve aggiungere:

1. **WS message ricevuto** — quando arriva un messaggio dal gateway
   (Touch screen rimosso — I2C bus non inizializzato, controller non attivo)

## Modifiche richieste

### 1. Cambiare timeout a 30s

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.cc` riga 121

```cpp
// Prima:
power_save_timer_ = new PowerSaveTimer(-1, 60, 300);
// Dopo:
power_save_timer_ = new PowerSaveTimer(-1, 30, -1);
```

### 2. Aggiungere WakeUp su WS message

**File**: `Note/xiaozhi-esp32/main/protocols/websocket_protocol.cc`

Nel callback `OnData` (riga ~112):

```cpp
websocket_->OnData([this](const char* data, size_t len, bool binary) {
    last_incoming_time_ = std::chrono::steady_clock::now();
    // Aggiungere: reset inactivity timer
    auto& board = Board::GetInstance();
    if (board.GetPowerSaveTimer()) {
        board.GetPowerSaveTimer()->WakeUp();
    }
});
```

Alternativa: gestire questo in R8 (wake da WS), dove il WS message fa `ExitSleepMode()` che chiama `WakeUp()`.

### 4. Modificare `CanEnterSleepMode()` (gia in R4)

Come descritto in R4, il check va modificato per permettere sleep con WS connesso.

### 5. Collegare OnEnterSleepMode a EnterSleepMode()

Gia descritto in R4:

```cpp
power_save_timer_->OnEnterSleepMode([this]() {
    EnterSleepMode();
});
```

## Flusso completo

```
Evento (bottone/audio/touch/WS)
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
Evento wake (bottone/touch/WS)
    → ExitSleepMode() [R4]
    → power_save_timer_->WakeUp()  [ticks_ = 0]
    → timer riparte da 0
```

## Interazione con conversazione attiva

`CanEnterSleepMode()` (modificato in R4) blocca sleep se:

- Device sta ascoltando (`kDeviceStateListening`)
- Device sta parlando (`kDeviceStateSpeaking`)
- Audio service non e' idle

Quindi **durante una conversazione il timer si resetta continuamente** perche':

1. Audio input → `WakeUp()`
2. Audio output → `WakeUp()`
3. State != idle → `CanEnterSleepMode()` ritorna false → ticks reset

Solo quando tutto e' fermo per 30s si entra in sleep.

## File coinvolti

| File                                   | Modifica                                   |
| -------------------------------------- | ------------------------------------------ |
| `sensecap_watcher.cc:121`              | Timeout 60→30, rimuovere auto-shutdown     |
| `sensecap_watcher.cc:123-129`          | Collegare a EnterSleepMode/ExitSleepMode   |
| `websocket_protocol.cc:112` (o via R8) | Aggiungere WakeUp() su WS message          |
| `application.cc:1052-1067`             | Modificare CanEnterSleepMode() (gia in R4) |

## Verifica

- [ ] 30s senza toccare → device entra in sleep
- [ ] Click bottone durante countdown → reset timer (non entra in sleep)
- [ ] Touch schermo durante countdown → reset timer
- [ ] Conversazione attiva → timer non scade mai
- [ ] WS message durante countdown → reset timer
- [ ] Dopo wake da sleep → timer riparte da 0

## Complessita: S

Modifica parametri + aggiunta WakeUp() in 2 punti. Logica gia esistente nel PowerSaveTimer.
