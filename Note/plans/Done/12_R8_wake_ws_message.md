# R8 — Wake da WS Message

**Parent**: [12_Plan_Battery.md](./12_Plan_Battery.md)
**Dipende da**: [R4](./12_R4_sleep_mode.md) (ExitSleepMode)

## Flusso attuale dei messaggi WS

```
WS data ricevuto [network task]
    ↓
WebsocketProtocol::OnData()         websocket_protocol.cc:112-166
    ├── binary → on_incoming_audio_()    (audio TTS)
    └── text   → parse JSON → on_incoming_json_()
                                    ↓
Application::OnIncomingJson()       application.cc:521-607
    ├── "tts"    → SetDeviceState(kDeviceStateSpeaking)
    ├── "stt"    → display transcription
    ├── "llm"    → display emotion
    ├── "mcp"    → McpServer::ParseMessage()
    ├── "system" → reboot, OTA, etc.
    ├── "alert"  → display alert
    └── "custom" → display custom payload
```

### Problema

Quando il device e' in sleep (display off, R4), un messaggio WS arriva ma:

- Il display e' spento → l'utente non vede nulla
- L'audio e' potenzialmente disabilitato
- Il `PowerSaveTimer` non viene svegliato

## Strategia: wake selettivo per tipo messaggio

Non tutti i messaggi devono svegliare il device:

| Tipo                        | Wake?  | Motivo                                           |
| --------------------------- | ------ | ------------------------------------------------ |
| `tts` (state=start)         | **SI** | Richiede audio playback                          |
| `mcp`                       | **SI** | Tool execution con side effects (es. LED, occhi) |
| `system`                    | **SI** | Comandi critici (reboot, OTA)                    |
| `alert`                     | **SI** | Notifica user-visible                            |
| `tts` (state=stop/sentence) | no     | Metadata, non serve audio                        |
| `stt`                       | no     | Solo display transcription                       |
| `llm`                       | no     | Solo display emotion                             |
| `custom`                    | no     | Display-only                                     |

## Implementazione

### Approccio: Board::WakeUpFromSleep() + filtro in Application

#### 1. Nuovo metodo virtuale in Board

**File**: `Note/xiaozhi-esp32/main/boards/common/board.h`

```cpp
class Board {
public:
    // ... existing methods ...
    virtual void WakeUpFromSleep() {} // default: no-op
};
```

#### 2. Override nel SenseCAP Watcher

**File**: `Note/main/boards/sensecap-watcher/sensecap_watcher.cc`

```cpp
void WakeUpFromSleep() override {
    if (is_sleeping_) {
        ExitSleepMode();  // R4 — display on, WiFi full, stato idle
    }
    power_save_timer_->WakeUp();  // Reset timer inattivita
}
```

#### 3. Chiamare da Application::OnIncomingJson()

**File**: `Note/xiaozhi-esp32/main/application.cc` riga ~521

Aggiungere filtro prima del dispatch esistente:

```cpp
protocol_->OnIncomingJson([this, display](const cJSON* root) {
    auto type = cJSON_GetObjectItem(root, "type");
    if (!type || !cJSON_IsString(type)) return;

    // Wake da sleep per messaggi che richiedono azione
    if (ShouldWakeForMessage(root)) {
        Board::GetInstance().WakeUpFromSleep();
    }

    // ... dispatch esistente (tts, stt, mcp, etc.) ...
});
```

#### 4. Funzione filtro

```cpp
bool Application::ShouldWakeForMessage(const cJSON* root) {
    auto type = cJSON_GetObjectItem(root, "type");
    const char* t = type->valuestring;

    if (strcmp(t, "mcp") == 0 || strcmp(t, "system") == 0 || strcmp(t, "alert") == 0) {
        return true;
    }

    if (strcmp(t, "tts") == 0) {
        auto state = cJSON_GetObjectItem(root, "state");
        return state && cJSON_IsString(state) && strcmp(state->valuestring, "start") == 0;
    }

    return false;
}
```

## Thread safety

- `WebsocketProtocol::OnData()` gira su network task
- `on_incoming_json_()` viene schedulato nel main event loop via `Schedule()`
- `Board::WakeUpFromSleep()` e' safe: `PowerSaveTimer::WakeUp()` resetta solo `ticks_` e `in_sleep_mode_` (atomici o sotto lock)
- `ExitSleepMode()` (R4) cambia display e WiFi mode — safe dal main loop

## Flusso completo con wake

```
Device in sleep (display off, WiFi attivo)
    ↓
Gateway manda messaggio WS (es. {"type":"tts","state":"start"})
    ↓
WebsocketProtocol::OnData() → parse JSON
    ↓
Application::OnIncomingJson()
    ├── ShouldWakeForMessage() → true
    ├── Board::WakeUpFromSleep()
    │   ├── ExitSleepMode() [R4]: display ON, WiFi full, stato idle
    │   └── power_save_timer_->WakeUp(): ticks=0
    │
    └── dispatch "tts" → SetDeviceState(kDeviceStateSpeaking)
        → audio playback
        → ... conversazione ...
        → idle
        → 30s → auto-sleep (R6)
```

## File coinvolti

| File                  | Modifica                                                      |
| --------------------- | ------------------------------------------------------------- |
| `board.h`             | Aggiungere `virtual void WakeUpFromSleep() {}`                |
| `sensecap_watcher.cc` | Override `WakeUpFromSleep()` → `ExitSleepMode()` + `WakeUp()` |
| `sensecap_watcher.h`  | Dichiarazione override                                        |
| `application.cc:521`  | Aggiungere filtro + `Board::WakeUpFromSleep()`                |
| `application.h`       | Dichiarare `ShouldWakeForMessage()` (private)                 |

## Verifica

- [ ] Device in sleep → gateway manda TTS → device si sveglia, riproduce audio
- [ ] Device in sleep → gateway manda MCP (es. SET_EYE_COLOR) → device esegue
- [ ] Device in sleep → gateway manda "stt" → device **non** si sveglia
- [ ] Dopo wake da WS → timer inattivita riparte (30s)
- [ ] Se nessun altro evento per 30s → torna in sleep

## Complessita: S-M

Nuovo metodo virtuale in Board + filtro in Application + override nel Watcher. Codice pulito, thread-safe.
