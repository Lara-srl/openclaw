# R2 — Aggiungere stati Ada UI (kAdaUiSleeping, kAdaUiShutdown)

**Parent**: [12_Plan_Battery.md](./12_Plan_Battery.md)

## Stato attuale dell'enum

**File**: `Note/main/display/ada_ui_manager.h` righe 7-19

```c
enum AdaUiStateCode {
    kAdaUiBoot           = 0,
    kAdaUiWifiConnecting = 10,
    kAdaUiWifiConfig     = 20,
    kAdaUiActivating     = 50,
    kAdaUiIdle           = 100,
    kAdaUiListening      = 200,
    kAdaUiThinking       = 300,
    kAdaUiActing         = 400,
    kAdaUiSpeaking       = 500,
    kAdaUiCompaction     = 600,
    kAdaUiShutdown       = 900,      // ← GIA' PRESENTE
};
```

**`kAdaUiShutdown` esiste gia (valore 900).** Serve solo aggiungere `kAdaUiSleeping`.

## Architettura schermi Ada UI

Il sistema ha **due tier di schermi**:

| Tier        | Schermi        | Stati                                                   | Caratteristiche             |
| ----------- | -------------- | ------------------------------------------------------- | --------------------------- |
| Boot (0-50) | `boot_screen_` | Boot, WifiConnecting, WifiConfig, Activating            | Titolo "aDa" + label status |
| Idle (100+) | `idle_screen_` | Idle, Listening, Thinking, Acting, Speaking, Compaction | Occhi animati + label stato |

**Manager**: singleton `AdaUiManager` con:

- `Initialize()` — crea entrambi gli schermi, boot caricato per primo
- `SetState()` — switch tra schermi + aggiorna label/animazioni
- `SetBootStatus()` — aggiorna testo status su boot*screen*
- `blink_timer_` — animazione occhi ogni 3.5s (attivo solo su kAdaUiIdle)

## Decisione: quale schermo per Sleep e Shutdown?

### Opzione A — Riusare `boot_screen_` (RACCOMANDATO)

- Sleep e Shutdown mostrano solo testo ("Dormo...", "Spegnimento...")
- Stessa struttura di WifiConnecting/Activating: titolo + label
- **Zero nuovi file**, solo nuovi case in `SetState()`
- Lo schermo spento/dimmed dopo il testo non richiede grafica complessa

### Opzione B — Creare `screen_sleeping`

- Nuovo XML + componenti + generazione LVGL Pro
- Utile solo se si vogliono animazioni specifiche (es. occhi chiusi, moon icon)
- Overhead: 3+ nuovi file, aggiornare `ada_ui_gen.h`

**Scelta: Opzione A** — coerente con gli altri stati boot-tier, minimo effort.

## Modifiche richieste

### 1. Aggiungere enum `kAdaUiSleeping`

**File**: `Note/main/display/ada_ui_manager.h` riga 18

```c
enum AdaUiStateCode {
    kAdaUiBoot           = 0,
    kAdaUiWifiConnecting = 10,
    kAdaUiWifiConfig     = 20,
    kAdaUiActivating     = 50,
    kAdaUiIdle           = 100,
    kAdaUiListening      = 200,
    kAdaUiThinking       = 300,
    kAdaUiActing         = 400,
    kAdaUiSpeaking       = 500,
    kAdaUiCompaction     = 600,
    kAdaUiSleeping       = 800,      // ← NUOVO
    kAdaUiShutdown       = 900,
};
```

### 2. Aggiungere case in `SetState()`

**File**: `Note/main/display/ada_ui_manager.cc` dentro `SetState()` (righe 64-131)

Aggiungere dopo i case boot-tier esistenti (WifiConnecting, WifiConfig, Activating):

```cpp
case kAdaUiSleeping: {
    lv_obj_t* title = lv_obj_find_by_name(boot_screen_, "title_label");
    lv_obj_t* status = lv_obj_find_by_name(boot_screen_, "status_label");
    if (title) {
        lv_label_set_text(title, "aDa");
    }
    if (status) {
        lv_label_set_text(status, "Dormo...");
        lv_obj_remove_flag(status, LV_OBJ_FLAG_HIDDEN);
    }
    if (lv_screen_active() != boot_screen_) {
        lv_screen_load(boot_screen_);
    }
    break;
}

case kAdaUiShutdown: {
    lv_obj_t* title = lv_obj_find_by_name(boot_screen_, "title_label");
    lv_obj_t* status = lv_obj_find_by_name(boot_screen_, "status_label");
    if (title) {
        lv_label_set_text(title, "aDa");
    }
    if (status) {
        lv_label_set_text(status, "Spegnimento...");
        lv_obj_remove_flag(status, LV_OBJ_FLAG_HIDDEN);
    }
    if (lv_screen_active() != boot_screen_) {
        lv_screen_load(boot_screen_);
    }
    break;
}
```

### 3. Gestione blink timer

In `SetState()` (righe 126-130), il blink timer si ferma gia quando si esce da `kAdaUiIdle`:

```cpp
if (prev == kAdaUiIdle && state != kAdaUiIdle && blink_timer_)
    esp_timer_stop(blink_timer_);
```

Questo funziona automaticamente per Sleep e Shutdown — il timer si ferma quando si transita da Idle.

### 4. Transizione Sleep → Idle (wake)

Quando il device esce da sleep (bottone, touch, WS message):

```cpp
AdaUiManager::GetInstance().SetState(kAdaUiIdle);
```

Questo ricarica `idle_screen_` e riavvia il blink timer automaticamente.

## File coinvolti

| File                                         | Modifica                          |
| -------------------------------------------- | --------------------------------- |
| `Note/main/display/ada_ui_manager.h:18`      | Aggiungere `kAdaUiSleeping = 800` |
| `Note/main/display/ada_ui_manager.cc:64-131` | Aggiungere 2 case in `SetState()` |

Nessun nuovo file XML/componente necessario (riuso boot*screen*).

## Dipendenze

- Nessuna dipendenza da altri step (puo essere fatto subito)
- Step 3 (long-press) e Step 4-6 (sleep/power-off) chiameranno `SetState()` con questi nuovi valori

## Verifica

- [ ] `SetState(kAdaUiSleeping)` → schermo mostra "aDa" + "Dormo..."
- [ ] `SetState(kAdaUiShutdown)` → schermo mostra "aDa" + "Spegnimento..."
- [ ] Da sleep → `SetState(kAdaUiIdle)` → torna a occhi con blink
- [ ] Blink timer si ferma in sleep/shutdown
- [ ] Blink timer riparte al ritorno in idle

## Complessita: XS

Aggiungere 1 valore enum + 2 case nello switch. Nessun nuovo schermo/componente.
