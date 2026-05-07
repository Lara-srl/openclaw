# R5 — Implementare Power Off (Deep Sleep)

**Parent**: [12_Plan_Battery.md](./12_Plan_Battery.md)
**Dipende da**: [R2](./12_R2_ada_ui_states.md) (stato kAdaUiShutdown), [R3](./12_R3_longpress_progressive.md) (trigger da bottone)

## Stato attuale del power-off

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.cc`

### Path 1 — Long-press a 5s (righe 299-303)

```cpp
// Se non in carica: spegne LCD e sistema
self->IoExpanderSetLevel(BSP_PWR_LCD, 0);     // P1.1 LCD power off
self->IoExpanderSetLevel(BSP_PWR_SYSTEM, 0);  // P1.2 System power off
```

Problema: **non usa deep sleep**, solo taglia l'alimentazione via IO expander.

### Path 2 — PowerSaveTimer a 300s (righe 131-139)

```cpp
power_save_timer_->OnShutdownRequest([this]() {
    bool is_charging = (IoExpanderGetLevel(BSP_PWR_VBUS_IN_DET) == 0);
    if (is_charging) {
        GetBacklight()->SetBrightness(0);      // ❌ Solo dim, non spegne
    } else {
        IoExpanderSetLevel(BSP_PWR_SYSTEM, 0); // Power off
    }
});
```

Problema: **in carica non si spegne mai**, solo backlight off.

### Nessuno dei due usa `esp_deep_sleep_start()`

## Pin hardware

**File**: `Note/main/boards/sensecap-watcher/config.h`

### GPIO diretti ESP32-S3

| GPIO       | Funzione                                                        |
| ---------- | --------------------------------------------------------------- |
| GPIO_NUM_2 | **IO Expander INT** — RTC-capable, wakeup source per deep sleep |
| GPIO3      | ADC batteria (ADC_CHANNEL_2)                                    |
| GPIO8      | Backlight PWM                                                   |
| GPIO38     | Touch SCL                                                       |
| GPIO39     | Touch SDA                                                       |

### IO Expander TCA9555 (I2C address 0x21)

| Pin  | Simbolo               | Dir | Funzione                       |
| ---- | --------------------- | --- | ------------------------------ |
| P0.0 | `BSP_PWR_CHRG_DET`    | IN  | Rilevamento carica             |
| P0.2 | `BSP_PWR_VBUS_IN_DET` | IN  | USB collegato (0=carica)       |
| P0.3 | `BSP_KNOB_BTN`        | IN  | Bottone knob                   |
| P0.5 | `BSP_TOUCH_GPIO_INT`  | IN  | Touch interrupt                |
| P1.1 | `BSP_PWR_LCD`         | OUT | Alimentazione LCD              |
| P1.2 | `BSP_PWR_SYSTEM`      | OUT | **Hold alimentazione sistema** |
| P1.3 | `BSP_PWR_AI_CHIP`     | OUT | Alimentazione camera AI        |
| P1.4 | `BSP_PWR_CODEC_PA`    | OUT | Alimentazione audio PA         |

### Catena wakeup

```
Bottone premuto
    → IO Expander TCA9555 P0.3 (BSP_KNOB_BTN) cambia stato
    → TCA9555 genera interrupt su pin INT
    → GPIO_NUM_2 (ESP32-S3) va LOW
    → RTC controller rileva edge → wakeup da deep sleep
    → Boot completo (come accensione da zero)
```

## Implementazione `EnterDeepSleep()`

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.cc` (nuovo metodo)

```cpp
void EnterDeepSleep() {
    ESP_LOGI(TAG, "Entering deep sleep...");

    // 1. Mostra "Spegnimento..." (gia fatto da R3)
    AdaUiManager::GetInstance().SetState(kAdaUiShutdown);

    // 2. Attendi che l'utente veda il messaggio
    vTaskDelay(pdMS_TO_TICKS(1500));

    // 3. Spegni periferiche via IO expander (risparmio pre-sleep)
    IoExpanderSetLevel(BSP_PWR_LCD, 0);       // LCD off
    IoExpanderSetLevel(BSP_PWR_AI_CHIP, 0);   // Camera off
    IoExpanderSetLevel(BSP_PWR_CODEC_PA, 0);  // Audio off

    // 4. Configura wakeup source: GPIO2 (IO expander INT), active-low
    esp_sleep_enable_ext0_wakeup(GPIO_NUM_2, 0);

    // 5. Opzionale: timeout di sicurezza (24h)
    // esp_sleep_enable_timer_wakeup(24ULL * 60 * 60 * 1000000);

    // 6. Deep sleep — non ritorna, al wakeup fa boot completo
    esp_deep_sleep_start();
}
```

### Note sulla configurazione RTC GPIO

`esp_sleep_enable_ext0_wakeup()` su ESP32-S3 configura automaticamente il pin come RTC input. Non serve chiamare `rtc_gpio_init()` separatamente (lo fa la funzione internamente).

**GPIO_NUM_2 e' RTC-capable su ESP32-S3** — confermato dalla documentazione Espressif. Puo essere usato con `ext0_wakeup`.

## Comportamento in carica

### Problema attuale

In carica, `OnShutdownRequest()` non spegne il sistema — solo dim backlight.

### Fix

Il deep sleep funziona anche in carica. L'USB mantiene il PMU alimentato, ma la CPU va in deep sleep. Al wakeup (bottone), boot completo.

```cpp
void EnterDeepSleep() {
    // Non serve controllare is_charging — deep sleep funziona in entrambi i casi
    // L'USB power mantiene il PMU, il bottone sveglia comunque
    esp_deep_sleep_start();
}
```

Se si vuole un comportamento diverso in carica (es. non spegnerti, vai solo in sleep):

```cpp
void EnterDeepSleep() {
    bool is_charging = (IoExpanderGetLevel(BSP_PWR_VBUS_IN_DET) == 0);
    if (is_charging) {
        ESP_LOGI(TAG, "Charging — entering display sleep instead of deep sleep");
        EnterSleepMode();  // R4 — solo display off
        return;
    }
    // ... deep sleep sequence ...
    esp_deep_sleep_start();
}
```

**Raccomandazione**: deep sleep anche in carica. L'utente ha premuto 13s+ intenzionalmente. Se vuole solo sleep, rilascia a 7-12s.

## Rimuovere auto-shutdown da PowerSaveTimer

In R4 abbiamo gia proposto di cambiare:

```cpp
// Prima:
power_save_timer_ = new PowerSaveTimer(-1, 60, 300);
// Dopo:
power_save_timer_ = new PowerSaveTimer(-1, 30, -1);  // -1 = no auto-shutdown
```

Lo shutdown viene gestito **solo** dal bottone long-press (R3).

## Membro nel header

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.h`

Nessun nuovo membro necessario — `EnterDeepSleep()` e' un'azione one-shot, non un stato da tracciare.

Aggiungere solo la dichiarazione del metodo:

```cpp
void EnterDeepSleep();
```

## File coinvolti

| File                                 | Modifica                                                                |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `sensecap_watcher.cc` (nuovo metodo) | `EnterDeepSleep()` — spegni periferiche + config wakeup + deep sleep    |
| `sensecap_watcher.h`                 | Dichiarazione `EnterDeepSleep()`                                        |
| `sensecap_watcher.cc:131-139`        | Rimuovere/semplificare `OnShutdownRequest` (auto-shutdown disabilitato) |

## Verifica

- [x] Long-press 10s anteprima + 11s auto power-off → "Spegnimento..." 1.5s → deep sleep (rst:0x5 DSLEEP)
- [x] Long-press >=10s + rilascio → EnterDeepSleep via bottone
- [x] Premere bottone dopo power-off → device si riaccende (boot completo)
- [x] WiFi disconnesso dopo deep sleep (full reboot confermato)
- [x] Power-off **a batteria** (senza USB) — testare senza cavo seriale
- [ ] Consumo in deep sleep < 100uA (verificare con multimetro)

## Complessita: S

Un metodo nuovo con sequenza lineare. Il rischio e' solo hardware (wakeup pin corretto).
