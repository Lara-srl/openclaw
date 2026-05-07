# R8 — Wake da WS Message ✅ COMPLETATO

**Parent**: [12_Plan_Battery.md](./12_Plan_Battery.md)
**Dipende da**: [R4](./12_R4_sleep_mode.md) (ExitSleepMode), [R6](./12_R6_inactivity_timer.md) (ResetInactivityTimer)

## Risultato

Il device si sveglia dal display sleep quando riceve messaggi WS actionable.
Comandi MCP (LED, suoni, eye color) funzionano anche durante lo sleep.

## Implementazione

### Firmware — filtro wake in `application.cc`

Aggiunto filtro inline all'inizio di `OnIncomingJson()` (riga ~532):

```cpp
// Wake from sleep for actionable messages (R8)
bool should_wake = false;
if (strcmp(type->valuestring, "tts") == 0) {
    auto state = cJSON_GetObjectItem(root, "state");
    if (state && cJSON_IsString(state) && strcmp(state->valuestring, "start") == 0) {
        should_wake = true;
    }
} else if (strcmp(type->valuestring, "mcp") == 0 ||
           strcmp(type->valuestring, "system") == 0 ||
           strcmp(type->valuestring, "alert") == 0 ||
           strcmp(type->valuestring, "SET_UI") == 0 ||
           strcmp(type->valuestring, "SET_EYE_COLOR") == 0) {
    should_wake = true;
}
if (should_wake) {
    Board::GetInstance().ResetInactivityTimer();
}
```

Riutilizza `ResetInactivityTimer()` (R6) che chiama `power_save_timer_->WakeUp()` →
se in sleep, esegue `ExitSleepMode()` (display on, WiFi full) e resetta ticks a 0.

**Nota:** `SET_EYE_COLOR` e `SET_UI` aggiunti al filtro perche chiamano LVGL.
Senza wake, LVGL `lv_obj_invalidate` su display spento causa watchdog timeout.

### Gateway — MCP immediato quando pipeline idle

**File**: `extensions/xiaozhi/src/bridge.ts`

Problema: i tool MCP (`laragoci_led`, `laragoci_play`, ecc.) usavano
`queueDeferredHwAction()` che eseguiva solo dopo un turno vocale (speaking → idle).
Se il pipeline e idle (nessun turno), le azioni restavano in coda per sempre.

Fix: `queueDeferredHwAction()` ora controlla `activePipeline.isIdle`:

- **Pipeline idle** → microtask flush via `executeDeferredHwActions()` (con delay 400ms)
- **Pipeline attivo** → deferred come prima (eseguito a fine turno)

```typescript
if (this.activePipeline?.isIdle && !this.immediateFlushScheduled) {
  this.immediateFlushScheduled = true;
  queueMicrotask(() => {
    this.immediateFlushScheduled = false;
    void this.executeDeferredHwActions();
  });
}
```

Il microtask batching evita di mandare N richieste MCP nello stesso millisecondo
(il device non gestisce piu di 1-2 MCP contemporanei → timeout 5000ms).

**File**: `extensions/xiaozhi/src/audio-pipeline.ts`

- Aggiunto `get isIdle(): boolean` pubblico

### Tipi di messaggio WS

| Tipo                        | Wake?  | Motivo                             |
| --------------------------- | ------ | ---------------------------------- |
| `tts` (state=start)         | **SI** | Richiede audio playback            |
| `mcp`                       | **SI** | Tool execution (LED, haptic, ecc.) |
| `system`                    | **SI** | Comandi critici (reboot, OTA)      |
| `alert`                     | **SI** | Notifica user-visible              |
| `SET_UI`                    | **SI** | Cambia stato UI LVGL               |
| `SET_EYE_COLOR`             | **SI** | Cambia colore occhi LVGL           |
| `tts` (state=stop/sentence) | no     | Metadata                           |
| `stt`                       | no     | Solo display transcription         |
| `llm`                       | no     | Solo display emotion               |
| `ping`                      | no     | Keepalive gateway                  |

## Limitazioni

- **Solo display sleep** (R4): WiFi + WS attivi → MCP funziona ✅
- **Deep sleep** (R5): WiFi + WS morti → nessun messaggio arriva ❌ (solo bottone fisico)
- **Azioni deferred durante deep sleep**: se il device e disconnesso, le azioni
  vanno in coda deferred. Al reconnect + primo turno vocale vengono eseguite.
  Azioni con stessa key (es. LED) si sovrascrivono (ultimo vince).

## Verifica

- [x] Device in display sleep → web UI manda LED → MCP immediato, LED si accende
- [x] Device in display sleep → web UI manda play → suono eseguito
- [x] Device in display sleep → web UI manda eye_color → colore cambia
- [x] Pipeline idle → `R8 immediate flush` nei log
- [x] Pipeline attivo → `deferred hw action queued` (eseguito a fine turno)
- [x] Multi-play batching: delay 400ms tra azioni (no timeout)
- [ ] Firmware R8 flashato → display si accende su MCP (da verificare)

## Complessita: M

Firmware: filtro inline in OnIncomingJson (no nuovi metodi/classi).
Gateway: `activePipeline` tracking + microtask flush in bridge.
