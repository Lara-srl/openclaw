# R4 — Implementare Sleep Mode (WiFi attivo)

**Parent**: [12_Plan_Battery.md](./12_Plan_Battery.md)
**Dipende da**: [R2](./12_R2_ada_ui_states.md) (stato kAdaUiSleeping), [R3](./12_R3_longpress_progressive.md) (trigger da bottone)

## Problema critico scoperto

`Application::CanEnterSleepMode()` (`Note/xiaozhi-esp32/main/application.cc:1052-1067`) **blocca lo sleep** se:

1. Device state != `kDeviceStateIdle`
2. WebSocket audio channel e' aperto (`protocol_->IsAudioChannelOpened()`)
3. Audio service non e' idle

Il nostro requisito dice: **WiFi + WS devono restare connessi durante sleep**. Quindi non possiamo usare il path standard di `CanEnterSleepMode()`.

## Architettura attuale del PowerSaveTimer

**File**: `Note/main/boards/common/power_save_timer.cc`

```
PowerSaveTimer(-1, 60, 300)
    │
    ├── cpu_max_freq_ = -1  → modem sleep DISABILITATO
    ├── seconds_to_sleep_ = 60
    └── seconds_to_shutdown_ = 300

PowerSaveCheck() [ogni 1s]:
    │
    ├── CanEnterSleepMode()? NO → reset ticks   ← BLOCCA SE WS ATTIVO
    │
    ├── ticks >= 60 → OnEnterSleepMode()
    │   ├── SetPowerSaveMode(true)  [vuoto per SenseCAP]
    │   └── SetBrightness(10)       [dim LCD al 10%]
    │
    └── ticks >= 300 → OnShutdownRequest()
        ├── Se charging → SetBrightness(0)
        └── Se batteria → IoExpanderSetLevel(BSP_PWR_SYSTEM, 0)
```

### Cosa fa oggi lo "sleep" del SenseCAP

Solo **dim del display** (brightness 10%). Nessun risparmio energetico reale:

- NO modem sleep (cpu_max_freq=-1)
- NO `esp_wifi_set_ps()` (usato solo dal Surfer-C3)
- NO `esp_light_sleep_start()` (usato solo dallo SleepTimer su altri board)
- Display `SetPowerSaveMode()` e' **vuoto** (solo log)

## Strategia di implementazione

### Approccio: "Display Sleep" (non ESP32 light sleep)

Per mantenere WiFi + WS attivi, **non** usiamo `esp_light_sleep_start()` (spegne WiFi). Facciamo:

1. **Spegnere display** completamente (brightness 0, non 10)
2. **Mostrare "Dormo..." prima di spegnere** (1s visibile, poi display off)
3. **WiFi modem sleep** opzionale: `esp_wifi_set_ps(WIFI_PS_MIN_MODEM)` — riduce consumo WiFi mantenendo connessione (il STA si sveglia per beacon interval)
4. **WS resta connesso** — il server OpenClaw manda ping, il client risponde
5. **Al wake**: display on, brightness restore, modem sleep off

### Perche' non ESP32 light sleep

|                | Display Sleep                            | ESP32 Light Sleep |
| -------------- | ---------------------------------------- | ----------------- |
| WiFi           | attivo (o modem sleep)                   | **spento**        |
| WS             | connesso                                 | **disconnesso**   |
| MCP da gateway | funziona                                 | **no**            |
| CPU            | attiva (idle)                            | **sospesa**       |
| Risparmio      | ~50-60% (display e' il consumo maggiore) | ~90%              |
| Wake time      | immediato                                | ~10ms             |

Il display del SenseCAP Watcher e' il componente che consuma di piu. Spegnerlo e' sufficiente per il target battery life.

## Modifiche richieste

### 1. Nuovo metodo `EnterSleepMode()` nel board

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.cc`

```cpp
void EnterSleepMode() {
    if (is_sleeping_) return;
    is_sleeping_ = true;

    // 1. Mostra "Dormo..." per 1s (gia fatto da R3 al trigger)
    AdaUiManager::GetInstance().SetState(kAdaUiSleeping);

    // 2. Dopo 1s, spegni display
    vTaskDelay(pdMS_TO_TICKS(1000));
    GetBacklight()->SetBrightness(0);

    // 3. WiFi modem sleep (opzionale — risparmia ~20mA)
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);

    // 4. Disabilita audio codec (risparmia energia)
    auto& app = Application::GetInstance();
    // ... disable audio input if applicable

    ESP_LOGI(TAG, "Entered sleep mode (display off, WiFi active)");
}
```

### 2. Nuovo metodo `ExitSleepMode()`

```cpp
void ExitSleepMode() {
    if (!is_sleeping_) return;
    is_sleeping_ = false;

    // 1. WiFi full power
    esp_wifi_set_ps(WIFI_PS_NONE);

    // 2. Display on
    GetBacklight()->RestoreBrightness();

    // 3. Torna a idle
    AdaUiManager::GetInstance().SetState(kAdaUiIdle);

    // 4. Reset timer inattivita
    power_save_timer_->WakeUp();

    ESP_LOGI(TAG, "Exited sleep mode");
}
```

### 3. Membro `is_sleeping_`

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.h`

```cpp
bool is_sleeping_ = false;
```

### 4. Aggiornare PowerSaveTimer

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.cc` riga 121

Cambiare i tempi:

```cpp
// Prima:
power_save_timer_ = new PowerSaveTimer(-1, 60, 300);

// Dopo:
power_save_timer_ = new PowerSaveTimer(-1, 30, -1);
// 30s = auto-sleep (requisito)
// -1 = nessun auto-shutdown (gestito solo da bottone R3/R5)
```

### 5. Aggiornare callback OnEnterSleepMode

```cpp
power_save_timer_->OnEnterSleepMode([this]() {
    EnterSleepMode();  // Usa il nuovo metodo unificato
});

power_save_timer_->OnExitSleepMode([this]() {
    ExitSleepMode();  // Usa il nuovo metodo unificato
});
```

### 6. Bypassare `CanEnterSleepMode()` per il timer 30s

Il check `CanEnterSleepMode()` blocca se WS e' aperto. Due opzioni:

Modificare `CanEnterSleepMode()`\*\* (in `application.cc`):

```cpp
bool Application::CanEnterSleepMode() {
    // Permettere sleep anche con WS connesso
    // Bloccare solo se audio e' attivo
    if (GetDeviceState() == kDeviceStateListening ||
        GetDeviceState() == kDeviceStateSpeaking) {
        return false;
    }
    if (!audio_service_.IsIdle()) {
        return false;
    }
    return true;
}
```

## WebSocket keepalive

**File**: `Note/xiaozhi-esp32/main/protocols/protocol.cc:81-90`

Il WS ha timeout di **120s** senza dati. Durante sleep il gateway OpenClaw puo mandare messaggi (MCP tools, TTS). Se nessun messaggio per >120s, il WS scade.

**Soluzione**: il gateway OpenClaw gia manda ping periodici (gestiti a livello WS library). Verificare che `esp_websocket_client` risponda automaticamente ai ping. Se non lo fa, aggiungere un ping periodico lato firmware (ogni 60s).

## Interazione con R3 (bottone) e R6 (timer inattivita)

Lo sleep puo essere attivato da:

1. **Bottone long-press 5-10s** → R3 chiama `EnterSleepMode()` direttamente
2. **Timer inattivita 30s** → PowerSaveTimer chiama `OnEnterSleepMode()` → `EnterSleepMode()`
3. **WS command** (futuro) → gateway puo mandare comando sleep

Lo sleep viene disattivato da:

1. **Bottone press** → R3/SINGLE_CLICK chiama `ExitSleepMode()`
2. **Touch screen 3s** → R7 chiama `ExitSleepMode()`
3. **WS message** → R8, handler WS chiama `ExitSleepMode()`

## Consumo energetico stimato

| Stato               | Display  | WiFi  | CPU  | Consumo stimato |
| ------------------- | -------- | ----- | ---- | --------------- |
| Attivo              | ON (75%) | Full  | Full | ~300mA          |
| Sleep (display off) | OFF      | Modem | Idle | ~80-100mA       |
| Deep sleep (R5)     | OFF      | OFF   | OFF  | ~10uA           |

Con batteria ~400mAh del Watcher: sleep = ~4-5 ore, deep sleep = settimane.

## File coinvolti

| File                          | Modifica                                                   |
| ----------------------------- | ---------------------------------------------------------- |
| `sensecap_watcher.cc:121`     | Cambiare tempi PowerSaveTimer (30, -1)                     |
| `sensecap_watcher.cc:123-141` | Aggiornare callback sleep con EnterSleepMode/ExitSleepMode |
| `sensecap_watcher.cc` (nuovo) | Metodi `EnterSleepMode()`, `ExitSleepMode()`               |
| `sensecap_watcher.h`          | Aggiungere `bool is_sleeping_`                             |
| `application.cc:1052-1067`    | Modificare `CanEnterSleepMode()` (Opzione A)               |

## Verifica

- [x] Dopo 30s inattivita → display si spegne, "Dormo..." visibile ~800ms prima
- [x] WiFi resta connesso durante sleep (WiFi PS:1, connessione mantenuta)
- [x] WebSocket resta connesso
- [x] Bottone press durante sleep → display si riaccende, torna idle (no flash "Dormo...")
- [x] Long-press 5s + rilascio → EnterSleepMode via bottone
- [x] Charging: sleep funziona anche con USB collegato

## Complessita: M-L

Nuovi metodi sleep/wake, modifica `CanEnterSleepMode()`, integrazione con PowerSaveTimer. Richiede test WiFi + WS durante sleep.
