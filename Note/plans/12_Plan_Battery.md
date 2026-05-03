# Plan 12 — Power Management (SenseCAP Watcher)

**Device target**: SenseCAP Watcher (il BOX-3 resta invariato — alimentato USB, no batteria)
**Obiettivo**: gestione batteria affidabile per i tester — sleep, power-off, no factory reset accidentale.

## Riferimenti

| Risorsa                 | Path                                                    |
| ----------------------- | ------------------------------------------------------- |
| Firmware sorgente       | `Note/main/`                                            |
| LVGL / Ada UI           | `Note/ada_ui/`                                          |
| Guide sviluppo          | `Note/plans/Guide/`                                     |
| Gestione bottone (done) | `Note/plans/Done/04_pipeline_button.md`                 |
| Boot/WiFi UX (done)     | `Note/plans/Done/11_Plan_fase_2_unified.md`             |
| Board file principale   | `Note/main/boards/sensecap-watcher/sensecap_watcher.cc` |

---

## Riepilogo requisiti

### R1 — Disabilitare factory reset fisico - Fatto

Il long-press attuale cancella le SSID salvate. **Deve essere rimosso completamente dal bottone.**
Factory reset disponibile solo via HTTP request remoto (endpoint da esporre sul web server locale del device).

### R2 — Sleep mode (light sleep / screen-off con WiFi attivo)

- WiFi + WebSocket **restano connessi** (LLM puo agire via MCP)
- Schermo mostra **"Dormo..."**
- **Auto**: 30s di inattivita (qualsiasi evento resetta il timer: bottone, audio, touch, WS message)
- **Manuale**: long-press bottone, rilascio tra 7-12s (vedi R4)
- **Wake da bottone**: press → wake immediato
- **Wake da WS**: messaggio dal gateway → wake completo + esegui comando, poi torna in sleep dopo 30s

### R3 — Power off (deep sleep)

- Tutto spento (WiFi, RAM, schermo)
- `esp_deep_sleep_start()` — consumo minimo
- **Trigger**: long-press bottone ≥13s (vedi R4)
- **Wakeup source**: pin INT dell'IO expander TCA9555 → `esp_sleep_enable_ext0_wakeup(GPIO_NUM_2, 0)` (RTC-capable su ESP32-S3)
- Al risveglio: boot completo (come accensione da zero)

### R4 — UX bottone progressivo (un solo gesto)

| Durata press                  | Evento                               | Schermo                             |
| ----------------------------- | ------------------------------------ | ----------------------------------- |
| 0–6s                          | niente (click singolo = talk toggle) | invariato                           |
| 7s                            | anteprima sleep                      | mostra **"Dormo..."**               |
| rilascio 7–12s                | **entra in sleep**                   | resta "Dormo..."                    |
| 13s                           | anteprima power-off                  | cambia in **"Spegnimento..."**      |
| rilascio ≥13s oppure auto 15s | **power off** (deep sleep)           | "Spegnimento..." poi schermo spento |

Se l'utente rilascia prima di 7s → nessuna azione (gesto annullato).

### ~~R5 — Wake da touch screen~~ RIMOSSO

Touch I2C bus non inizializzato nel firmware. Wake solo via bottone e WS message.

---

## Nuovi stati Ada UI

| Enum             | Valore | Label schermo    | Contesto                               |
| ---------------- | ------ | ---------------- | -------------------------------------- |
| `kAdaUiSleeping` | 60     | "Dormo..."       | device in sleep, schermo dimmed/spento |
| `kAdaUiShutdown` | 70     | "Spegnimento..." | countdown prima di deep sleep          |

(valori dopo `kAdaUiActivating=50` definiti in Plan 11)

---

## Step di implementazione

### Step 1 — Rimuovere factory reset dal bottone → [R1](./12_R1_factory_reset_disable.md) - Fatto

- Eliminare la logica `cnt > 250` / cancellazione SSID dal handler `BUTTON_LONG_PRESS_HOLD`
- 4 path analizzati: solo il button hold va rimosso, gli altri sono safe
- **Complessita: XS** — rimuovere 4 righe

### Step 2 — Aggiungere stati Ada UI (kAdaUiSleeping, kAdaUiShutdown) → [R2](./12_R2_ada_ui_states.md) - Fatto

- `kAdaUiShutdown` gia presente (900), aggiungere solo `kAdaUiSleeping = 800`
- Riuso `boot_screen_` (come WifiConnecting/Activating) — nessun nuovo schermo XML
- 2 nuovi case in `SetState()`: "Dormo..." e "Spegnimento..."
- **Complessita: XS** — 1 enum + 2 case

### Step 3 — Long-press progressivo → [R3](./12_R3_longpress_progressive.md) - Fatto

- Riscrittura completa di 3 handler + nuovo `BUTTON_LONG_PRESS_UP`
- Timing finale: sleep a 5s, shutdown a 10s, auto off a 11s
- `LongPressZone` enum per tracciare stato, rilascio esegue azione della zona corrente
- Wake da sleep: click bottone → wake + ascolto immediato
- Charging guard: USB collegato → backlight off invece di system off
- **Complessita: M** — 4 handler, logica a stati, test hardware

### Step 4 — Implementare sleep mode (WiFi attivo) → [R4](./12_R4_sleep_mode.md) - Fatto

- **Display Sleep** (non ESP32 light sleep) — spegni display, WiFi resta attivo
- `EnterSleepMode()` / `ExitSleepMode()` metodi unificati nel board
- Modificare `CanEnterSleepMode()` per permettere sleep con WS connesso
- WiFi modem sleep opzionale (`WIFI_PS_MIN_MODEM`) per risparmiare ~20mA
- PowerSaveTimer aggiornato: 30s auto-sleep, no auto-shutdown
- **Complessita: M-L** — nuovo subsystem sleep, test WiFi/WS

### Step 5 — Implementare power off (deep sleep) → [R5](./12_R5_power_off.md)

- `EnterDeepSleep()`: spegni periferiche + `esp_sleep_enable_ext0_wakeup(GPIO_NUM_2, 0)` + `esp_deep_sleep_start()`
- Wakeup via IO expander TCA9555 INT → bottone → GPIO2 (RTC-capable)
- Funziona sia in carica che a batteria (fix bug attuale)
- Auto-shutdown rimosso da PowerSaveTimer (gestito solo da bottone)
- **Complessita: S** — sequenza lineare, rischio solo hardware

### Step 6 — Timer inattivita (auto-sleep a 30s) → [R6](./12_R6_inactivity_timer.md)

- PowerSaveTimer gia esiste — cambiare timeout 60→30, rimuovere auto-shutdown
- Aggiungere `WakeUp()` su WS message (bottone/audio gia coperti)
- Conversazione attiva blocca sleep via `CanEnterSleepMode()` (R4)
- **Complessita: S** — parametri + 2 punti di WakeUp

### ~~Step 7 — Wake da touch screen~~ RIMOSSO

- Touch I2C bus non inizializzato nel firmware, controller non attivo
- Wake da sleep solo via **bottone fisico** (click) e **WS message** (Step 8)

### Step 8 — Wake da WS message → [R8](./12_R8_wake_ws_message.md)

- `Board::WakeUpFromSleep()` virtual method + override nel Watcher
- Filtro selettivo: wake solo per tts(start), mcp, system, alert
- Chiamato in `Application::OnIncomingJson()` prima del dispatch
- **Complessita: S-M** — metodo virtuale + filtro + override

### Step 9 — Factory reset via HTTP → [R9](./12_R9_factory_reset_http.md)

- `POST /api/factory-reset` con token = MAC address del device
- ESP-IDF `esp_http_server` — pattern gia usato nel board Otto Robot
- `nvs_flash_erase()` + `esp_restart()` — stesso effetto del vecchio button reset
- **Complessita: S-M** — server HTTP nuovo, un endpoint

---

## Verifica per ogni step

| Test                            | Risultato atteso                                |
| ------------------------------- | ----------------------------------------------- |
| Click singolo                   | talk toggle (invariato)                         |
| Long-press 7s + rilascio        | schermo "Dormo...", entra in sleep, WiFi attivo |
| Long-press 13s + rilascio       | schermo "Spegnimento...", device si spegne      |
| Long-press 15s (senza rilascio) | auto power-off                                  |
| 30s inattivita                  | auto-sleep                                      |
| Bottone press durante sleep     | wake immediato                                  |
| WS message durante sleep        | wake + esegui + re-sleep                        |
| Long-press qualsiasi durata     | **nessun factory reset**                        |
| HTTP factory reset              | reset SSID + reboot                             |
| Power-off in carica             | funziona (non solo backlight off)               |
| Power-off a batteria            | funziona                                        |
| Press bottone dopo power-off    | device si riaccende (boot completo)             |

---

## Note tecniche (da approfondire nell'analisi dei file)

- **Light sleep vs screen-off**: su ESP32-S3, light sleep puo mantenere WiFi solo con `esp_wifi_set_ps(WIFI_PS_MIN_MODEM)`. Da verificare se il WS client sopravvive o serve un approccio diverso (solo screen-off + CPU idle).
- **GPIO_NUM_2 wakeup**: confermato RTC-capable su ESP32-S3. E' il pin INT dell'IO expander TCA9555 collegato al bottone. Funziona per deep sleep wakeup.
- **Touch**: I2C bus #1 non inizializzato nel firmware, controller non attivo. Wake solo via bottone/WS.
- **Charging detection**: il firmware attuale ha un path "charging" che blocca lo shutdown. Va rimosso/modificato.

  ┌───────────────────────────────┬───────────────────────────────────────────┬─────────────┬────────────┐  
  │ Step │ File │ Complessita │ Dipendenze │
  ├───────────────────────────────┼───────────────────────────────────────────┼─────────────┼────────────┤  
  │ R1 — Rimuovere factory reset │ Note/plans/12_R1_factory_reset_disable.md │ XS │ nessuna │  
  ├───────────────────────────────┼───────────────────────────────────────────┼─────────────┼────────────┤
  │ R2 — Stati Ada UI │ Note/plans/12_R2_ada_ui_states.md │ XS │ nessuna │
  ├───────────────────────────────┼───────────────────────────────────────────┼─────────────┼────────────┤
  │ R3 — Long-press progressivo │ Note/plans/12_R3_longpress_progressive.md │ M │ R1, R2 │
  ├───────────────────────────────┼───────────────────────────────────────────┼─────────────┼────────────┤
  │ R4 — Sleep mode (WiFi attivo) │ Note/plans/12_R4_sleep_mode.md │ M-L │ R2, R3 │
  ├───────────────────────────────┼───────────────────────────────────────────┼─────────────┼────────────┤
  │ R5 — Power off (deep sleep) │ Note/plans/12_R5_power_off.md │ S │ R2, R3 │
  ├───────────────────────────────┼───────────────────────────────────────────┼─────────────┼────────────┤
  │ R6 — Timer inattivita 30s │ Note/plans/12_R6_inactivity_timer.md │ S │ R4 │
  ├───────────────────────────────┼───────────────────────────────────────────┼─────────────┼────────────┤
  │ ~~R7~~ — Touch wake │ RIMOSSO │ - │ - │
  ├───────────────────────────────┼───────────────────────────────────────────┼─────────────┼────────────┤
  │ R8 — Wake da WS message │ Note/plans/12_R8_wake_ws_message.md │ S-M │ R4 │
  ├───────────────────────────────┼───────────────────────────────────────────┼─────────────┼────────────┤
  │ R9 — Factory reset HTTP │ Note/plans/12_R9_factory_reset_http.md │ S-M │ R1 │
  └───────────────────────────────┴───────────────────────────────────────────┴─────────────┴────────────┘

  Ordine di implementazione consigliato: R1 → R2 → R3 → R5 → R4 → R6 → R8 → R9
