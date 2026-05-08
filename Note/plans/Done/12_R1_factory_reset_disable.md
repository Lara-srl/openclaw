# R1 — Disabilitare Factory Reset dal Bottone

**Parent**: [12_Plan_Battery.md](./12_Plan_Battery.md)

## Analisi codice sorgente

### Trigger trovati nel firmware

Ci sono **4 path** che eseguono factory reset / NVS erase:

---

### 1. Button Long Press Hold (DA RIMUOVERE)

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.cc`
**Righe**: 308-320 (dentro `InitializeButton`)

```cpp
// BUTTON_LONG_PRESS_HOLD — ogni 20ms incrementa contatore
self->long_press_cnt_++;  // riga 312
// 长按10s 恢复出厂设置: 5+0.02*250 = 10
if (self->long_press_cnt_ > 250) {   // riga 314
    ESP_LOGI(TAG, "Factory reset");   // riga 315
    nvs_flash_erase();                // riga 316
    esp_restart();                     // riga 317
}
```

**Meccanismo**: `long_press_time = 5000` (5s) + 250 \* 20ms (5s) = **10s totali** di hold.
Cancella tutto NVS (WiFi SSID, config, settings) e riavvia.

**Azione**: rimuovere il blocco `if (self->long_press_cnt_ > 250)`. Il contatore `long_press_cnt_` servira per la nuova logica progressiva (Step 3).

---

### 2. Console Command `factory_reset` (DA MANTENERE → spostare su HTTP in Step 9)

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.cc`
**Righe**: 504-516 (dentro `InitializeCmd`)

```cpp
const esp_console_cmd_t cmd4 = {
    .command = "factory_reset",
    .help = "factory reset and reboot the device",
    .func_w_context = [](void* context, int argc, char** argv) -> int {
        nvs_flash_erase();
        esp_restart();
        return 0;
    },
};
```

**Azione**: mantenere il comando seriale (utile per debug). In Step 9 aggiungere anche endpoint HTTP.

---

### 3. SystemReset class generica (NON ATTIVA nel Watcher)

**File**: `Note/main/boards/common/system_reset.cc` + `system_reset.h`

Classe riusabile con `CheckButtons()` su GPIO dedicati. Il SenseCAP Watcher **non la usa** (non e' istanziata in `sensecap_watcher.cc`).

**Azione**: nessuna modifica necessaria.

---

### 4. Boot safety — NVS auto-erase su corruzione

**File**: `Note/main/main.cc` righe 17-22

```cpp
esp_err_t ret = nvs_flash_init();
if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_LOGW(TAG, "Erasing NVS flash to fix corruption");
    ESP_ERROR_CHECK(nvs_flash_erase());
    ret = nvs_flash_init();
}
```

**Azione**: nessuna modifica — e' un safety net automatico, non user-triggered.

---

## Riepilogo path

| #   | Path                    | Trigger                 | User-facing    | Azione        |
| --- | ----------------------- | ----------------------- | -------------- | ------------- |
| 1   | Button hold 10s         | `long_press_cnt_ > 250` | SI             | **RIMUOVERE** |
| 2   | Console `factory_reset` | comando seriale         | NO (service)   | Mantenere     |
| 3   | SystemReset class       | GPIO dedicati           | NO (non usata) | Nessuna       |
| 4   | Boot NVS corruption     | automatico              | NO             | Nessuna       |

## Modifiche richieste

### sensecap_watcher.cc — `BUTTON_LONG_PRESS_HOLD` handler

**Prima** (righe 308-320):

```cpp
case BUTTON_LONG_PRESS_HOLD: {
    self->long_press_cnt_++;
    // 长按10s factory reset
    if (self->long_press_cnt_ > 250) {
        ESP_LOGI(TAG, "Factory reset");
        nvs_flash_erase();
        esp_restart();
    }
    break;
}
```

**Dopo**:

```cpp
case BUTTON_LONG_PRESS_HOLD: {
    self->long_press_cnt_++;
    // Factory reset rimosso dal bottone (Plan 12 R1)
    // Il contatore viene usato per sleep/power-off progressivo (R3)
    break;
}
```

## Verifica

- [V] Long-press qualsiasi durata → **nessun factory reset**
- [V] NVS (WiFi SSID, config) intatte dopo long-press
- [N/A] Console `factory_reset` ancora funzionante (porta seriale) — _non verificabile: con device collegato via seriale il bottone power-off non funziona (il seriale mantiene il device attivo)_
- [V] Click singolo (talk toggle) invariato

## Complessita: XS

Modifica singola: rimuovere 4 righe da un handler. Nessun rischio di regressione su altri path.
