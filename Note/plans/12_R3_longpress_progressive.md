# R3 — Long-press progressivo (sleep a 7s, power-off a 13s)

**Parent**: [12_Plan_Battery.md](./12_Plan_Battery.md)
**Dipende da**: [R1](./12_R1_factory_reset_disable.md) (rimozione factory reset), [R2](./12_R2_ada_ui_states.md) (nuovi stati UI)

## Stato attuale del button handler

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.cc` righe 254-321

### Timing

```
long_press_time = 5000ms → BUTTON_LONG_PRESS_START si attiva a 5s
BUTTON_LONG_PRESS_HOLD → ogni ~20ms dopo i 5s (incrementa long_press_cnt_)
```

### Calcolo contatore → tempo reale

| `long_press_cnt_` | Tempo totale        | Azione (nuova)                  |
| ----------------- | ------------------- | ------------------------------- |
| 0                 | 5s                  | LONG_PRESS_START — init counter |
| 100               | 7s (5s + 100×20ms)  | Mostra "Dormo..."               |
| 400               | 13s (5s + 400×20ms) | Mostra "Spegnimento..."         |
| 500               | 15s (5s + 500×20ms) | Auto power-off                  |

### Handler attuale — PROBLEMI

```cpp
// BUTTON_LONG_PRESS_START (riga 293-306)
// ❌ A 5s: spegne LCD e SYSTEM immediatamente (se non in carica)
self->IoExpanderSetLevel(BSP_PWR_LCD, 0);    // LCD off
self->IoExpanderSetLevel(BSP_PWR_SYSTEM, 0); // System off

// BUTTON_LONG_PRESS_HOLD (riga 308-320)
// ❌ A 10s (cnt>250): factory reset + nvs erase
```

**Entrambi vanno riscritti.**

## API bottone disponibili

**File**: `Note/xiaozhi-esp32/managed_components/espressif__button/include/iot_button.h`

```c
typedef enum {
    BUTTON_PRESS_DOWN = 0,
    BUTTON_PRESS_UP,
    BUTTON_SINGLE_CLICK,
    BUTTON_LONG_PRESS_START,     // a long_press_time (5000ms)
    BUTTON_LONG_PRESS_HOLD,      // ogni ~20ms dopo START
    BUTTON_LONG_PRESS_UP,        // ← RILASCIO dopo long-press (DISPONIBILE!)
    BUTTON_PRESS_END,
    // ...
} button_event_t;
```

`BUTTON_LONG_PRESS_UP` e' **disponibile e non ancora registrato**. Fondamentale per il rilascio.

## Charging detection

```cpp
bool is_charging = (IoExpanderGetLevel(BSP_PWR_VBUS_IN_DET) == 0); // active-low
```

- Se in carica: power-off **non deve** spegnere il sistema (come attualmente)
- Sleep: funziona sia in carica che a batteria

## Modifiche richieste

### 1. Aggiungere variabile di stato per la soglia raggiunta

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.h` (o nel .cc)

```cpp
enum LongPressZone {
    kLongPressNone = 0,
    kLongPressSleep = 1,      // cnt >= 100 (7s)
    kLongPressShutdown = 2,   // cnt >= 400 (13s)
};
LongPressZone long_press_zone_ = kLongPressNone;
```

### 2. Riscrivere BUTTON_LONG_PRESS_START

**Prima** (righe 293-306):

```cpp
// Spegne LCD + System a 5s
self->IoExpanderSetLevel(BSP_PWR_LCD, 0);
self->IoExpanderSetLevel(BSP_PWR_SYSTEM, 0);
```

**Dopo**:

```cpp
iot_button_register_cb(btns, BUTTON_LONG_PRESS_START, nullptr,
    [](void* button_handle, void* usr_data) {
        auto self = static_cast<SensecapWatcher*>(usr_data);
        self->long_press_cnt_ = 0;
        self->long_press_zone_ = kLongPressNone;
        // Nessuna azione visiva a 5s — il feedback parte a 7s
        ESP_LOGI(TAG, "Long press started");
    }, this);
```

### 3. Riscrivere BUTTON_LONG_PRESS_HOLD

**Prima** (righe 308-320):

```cpp
self->long_press_cnt_++;
if (self->long_press_cnt_ > 250) {  // factory reset a 10s
    nvs_flash_erase();
    esp_restart();
}
```

**Dopo**:

```cpp
iot_button_register_cb(btns, BUTTON_LONG_PRESS_HOLD, nullptr,
    [](void* button_handle, void* usr_data) {
        auto self = static_cast<SensecapWatcher*>(usr_data);
        self->long_press_cnt_++;

        // 7s (cnt=100): anteprima sleep
        if (self->long_press_cnt_ == 100) {
            self->long_press_zone_ = kLongPressSleep;
            AdaUiManager::GetInstance().SetState(kAdaUiSleeping);
            ESP_LOGI(TAG, "Long press: sleep preview (7s)");
        }
        // 13s (cnt=400): anteprima power-off
        else if (self->long_press_cnt_ == 400) {
            self->long_press_zone_ = kLongPressShutdown;
            AdaUiManager::GetInstance().SetState(kAdaUiShutdown);
            ESP_LOGI(TAG, "Long press: shutdown preview (13s)");
        }
        // 15s (cnt=500): auto power-off
        else if (self->long_press_cnt_ >= 500) {
            ESP_LOGI(TAG, "Long press: auto shutdown (15s)");
            self->EnterDeepSleep();  // vedi R5
        }
    }, this);
```

### 4. Aggiungere BUTTON_LONG_PRESS_UP (NUOVO)

```cpp
iot_button_register_cb(btns, BUTTON_LONG_PRESS_UP, nullptr,
    [](void* button_handle, void* usr_data) {
        auto self = static_cast<SensecapWatcher*>(usr_data);

        switch (self->long_press_zone_) {
            case kLongPressShutdown:
                // Rilascio >=13s → power off
                ESP_LOGI(TAG, "Long press release: shutdown");
                self->EnterDeepSleep();  // vedi R5
                break;

            case kLongPressSleep:
                // Rilascio 7-12s → entra in sleep
                ESP_LOGI(TAG, "Long press release: sleep");
                self->EnterSleepMode();  // vedi R4
                break;

            case kLongPressNone:
                // Rilascio <7s → annulla, torna a stato precedente
                ESP_LOGI(TAG, "Long press release: cancelled (<7s)");
                AdaUiManager::GetInstance().SetState(kAdaUiIdle);
                break;
        }

        self->long_press_zone_ = kLongPressNone;
        self->long_press_cnt_ = 0;
    }, this);
```

## Interazione con PowerSaveTimer

Il `PowerSaveTimer` attuale gestisce:

- **Auto-sleep a 60s** → `OnEnterSleepMode()` (dim LCD)
- **Auto-shutdown a 300s** → `OnShutdownRequest()` (system off)

Questi **restano attivi** come timeout automatici separati, ma i tempi vanno aggiornati:

- `seconds_to_sleep`: 60 → **30** (come da requisito R6)
- `seconds_to_shutdown`: 300 → rimuovere oppure lasciare come safety net

Il bottone long-press e' un **override manuale** che bypassa il timer.

## Flusso completo

```
PRESS_DOWN
    |
    5s → LONG_PRESS_START: init cnt=0, zone=None
    |
    +20ms → HOLD: cnt++
    |
    7s (cnt=100) → zone=Sleep, schermo "Dormo..."
    |
    ...cnt++ ogni 20ms...
    |
    13s (cnt=400) → zone=Shutdown, schermo "Spegnimento..."
    |
    15s (cnt=500) → auto EnterDeepSleep()
    |
RELEASE → LONG_PRESS_UP:
    zone=None → annulla, torna Idle
    zone=Sleep → EnterSleepMode()
    zone=Shutdown → EnterDeepSleep()
```

## File coinvolti

| File                          | Modifica                                                    |
| ----------------------------- | ----------------------------------------------------------- |
| `sensecap_watcher.cc:264`     | `long_press_time` resta 5000 (OK)                           |
| `sensecap_watcher.cc:293-306` | Riscrivere LONG_PRESS_START (rimuovere LCD/system off)      |
| `sensecap_watcher.cc:308-320` | Riscrivere LONG_PRESS_HOLD (soglie progressive)             |
| `sensecap_watcher.cc` (nuovo) | Aggiungere LONG_PRESS_UP handler                            |
| `sensecap_watcher.h`          | Aggiungere `LongPressZone` enum + `long_press_zone_` membro |

## Verifica

- [V] Press < 5s → click singolo (talk toggle) invariato
- [V] Hold 5s → schermo mostra "Dormo..." (timing finale: 5s non 7s)
- [V] Rilascio tra 5-10s → entra in sleep (display off, WiFi attivo)
- [V] Hold 10s → schermo cambia in "Spegnimento..." (timing finale: 10s non 13s)
- [V] Rilascio >=10s → power off
- [V] Hold 11s senza rilascio → auto power off (timing finale: 11s non 15s)
- [V] **Nessun factory reset** in nessun caso
- [V] In carica (USB): backlight off invece di system off

## Timing finale (diverso dal piano iniziale)

| cnt   | Tempo totale | Evento                          |
| ----- | ------------ | ------------------------------- |
| START | 5s           | "Dormo...", zone=Sleep          |
| 250   | 10s          | "Spegnimento...", zone=Shutdown |
| 300   | 11s          | auto power off                  |

## Note implementative

- Wake da sleep: `BUTTON_SINGLE_CLICK` chiama `SetPowerSaveMode(false)` + `RestoreBrightness()` + `SetState(kAdaUiIdle)` prima di StartListening → wake immediato + ascolto contestuale (comportamento desiderato)
- Charging guard: `IoExpanderGetLevel(BSP_PWR_VBUS_IN_DET) == 0` → backlight off invece di system off quando USB collegato

## Complessita: M

Riscrittura completa di 3 handler + aggiunta 1 nuovo. Logica a stati con timing preciso. Richiede test hardware.

## Stato: FATTO
