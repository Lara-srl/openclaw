# Piano Fase 2 — LaraGoci / XiaoZhi (Ada)

## Contesto

Fase 1 completata: stack EU (Voxtral STT + Mistral LLM + Voxtral TTS), streaming TTS prefetch, gestione bottone, audio pipeline stabile. Fase 2 aggiunge **interfaccia visiva**, **tool hardware MCP** e **Bluetooth A2DP** al SenseCAP Watcher.

**Correzione importante**: il display del Watcher è **412x412** (non 320x320 come nella bozza iniziale). Tutti i layout LVGL e asset devono usare 412.

### Risorse esterne

- Asset generator: https://github.com/78/xiaozhi-assets-generator
- MCP protocol e integration: https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-usage.md
- MCP protocol device-side: https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-protocol.md
- Sorgenti firmware reference: `Note/main/` (librerie display, MCP, device)
- Board specifica: `Note/main/boards/sensecap-watcher/`

---

## Step 0 — Bug Fix Pre-Fase 2 (Quick Wins)

Due fix immediati che migliorano drasticamente l'esperienza dei tester. Solo modifiche TypeScript, nessun firmware.

### Bug 0A: Agente troppo prolisso

**Problema**: L'LLM risponde con troppe parole. Quando esegue azioni (es. modifica file), spiega cosa ha modificato, dove, quando e perché. Deve dare solo la risposta diretta.

**File**: `extensions/xiaozhi/src/audio-pipeline.ts` linea 21

**Modifica**: Riscrivere `VOICE_EXTRA_SYSTEM_PROMPT` con vincoli più stretti:

```typescript
const VOICE_EXTRA_SYSTEM_PROMPT = `MODALITÀ VOCALE — priorità assoluta su tutto il resto:
- Rispondi in MASSIMO 20-30 parole. Vai dritto al punto.
- Se l'utente chiede un approfondimento, puoi allungare fino a 4-5 frasi.
- Se esegui un'azione (modifica file, cerca, ecc.), rispondi SOLO con il risultato. NON spiegare cosa hai fatto, quale file hai toccato, o perché. Esempio: "Fatto, prova adesso" oppure "Ecco il risultato: ...".
- VIETATO usare markdown: niente **, *, \`, #, elenchi con - o numeri. Rispondi SOLO in prosa fluente.
- VIETATO premesse, intro, recap o riassunti — vai diretto alla risposta.
- Il tuo output viene letto ad alta voce da un sintetizzatore TTS. Scrivi come parleresti a voce.
- Se non sai qualcosa, dillo in una frase. Non elencare alternative.`;
```

**Cambiamenti chiave**:

- "MASSIMO 20-30 parole" (era "1-2 frasi" troppo vago)
- Regola esplicita: quando esegui azioni, NON spiegare — solo risultato
- Aggiunto "Fatto, prova adesso" come esempio di risposta corretta

### Bug 0B: TTS legge simboli (asterischi, markdown)

**Problema**: Nonostante il prompt vieti markdown, l'LLM a volte lo usa lo stesso. La funzione `sanitizeForTts()` esiste già (linea 173) ma potrebbe avere gap.

**File**: `extensions/xiaozhi/src/audio-pipeline.ts` linea 173

**Modifica**: Rafforzare `sanitizeForTts()` con pattern aggiuntivi:

````typescript
function sanitizeForTts(text: string): string {
  return (
    text
      // Bold/italic: **text** / *text* / __text__ / _text_
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
      // Stray asterisks/underscores non catturati sopra
      .replace(/[*_]/g, "")
      // Inline code: `text`
      .replace(/`([^`]+)`/g, "$1")
      // Code blocks: ```text```
      .replace(/```[\s\S]*?```/g, "")
      // Markdown headers: ## Header
      .replace(/^#{1,6}\s+/gm, "")
      // Markdown list items: - item / * item / 1. item
      .replace(/^[\s]*[-*]\s+/gm, "")
      .replace(/^[\s]*\d+\.\s+/gm, "")
      // Curly/smart quotes → straight
      .replace(/[""«»]/g, '"')
      .replace(/['']/g, "'")
      // Links: [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Horizontal rules: --- / ***
      .replace(/^[-*_]{3,}\s*$/gm, "")
      // HTML tags
      .replace(/<[^>]+>/g, "")
      // Stray markdown chars
      .replace(/[~>`]/g, "")
      // Collapse multiple spaces/newlines
      .replace(/\n+/g, " ")
      .replace(/ {2,}/g, " ")
      .trim()
  );
}
````

### Verifica Bug Fix

- Avviare gateway, fare conversazione vocale
- Chiedere "che ore sono" → risposta breve (tipo "Sono le 14 e 30")
- Chiedere qualcosa di complesso → risposta max 30 parole
- Chiedere di modificare qualcosa → "Fatto, prova adesso" (no spiegone)
- Verificare che TTS non legga "asterisco" o "cancelletto"

**Complessità: S** (due edit in un solo file)

---

## Sub-fasi e ordine di esecuzione

```
Step 0 (0A+0B) ── Bug Fix Pre-Fase 2 ────────── TypeScript only, ~0.5 giorni
Step 1 (2.1A)  ── Bridge UI State Protocol ───── TypeScript only, ~1 giorno
Step 2 (2.2A)  ── MCP Tool Registration ──────── Firmware C++, ~2 giorni
Step 3 (2.2B)  ── Bridge Tool Handlers ───────── TypeScript, ~1 giorno
Step 4 (2.1B)  ── Firmware UI State Machine ──── Firmware C++ LVGL, ~3 giorni
Step 5 (2.1C)  ── Asset Creation & Deploy ────── Creativo + integrazione, ~3 giorni
Step 6 (2.2C)  ── Power Management Fix ───────── Firmware, ~0.5 giorni
Step 7 (2.3)   ── Bluetooth A2DP ─────────────── Firmware, ~5 giorni (parallelizzabile con 4-6)
```

---

## Step 1 — 2.1A: Bridge UI State Protocol (TypeScript)

**Obiettivo**: il bridge invia `SET_UI` JSON al device nei punti chiave della pipeline. Testabile con mock client, nessuna modifica firmware.

### Protocollo JSON via WebSocket

Il Bridge invia pacchetti JSON brevi al Watcher per cambiare stato visivo:

```json
{
  "type": "SET_UI",
  "state": 300,
  "text": "Sto elaborando...",
  "icon": "mistral_icon",
  "brightness": 255
}
```

### File da creare

**`extensions/xiaozhi/src/ui-state.ts`**

```typescript
export const AdaUiState = {
  BOOT: 0,
  IDLE: 100,
  LISTENING: 200,
  THINKING: 300,
  ACTING: 400,
  SPEAKING: 500,
  COMPACTION: 600,
  SHUTDOWN: 900,
} as const;
export type AdaUiStateCode = (typeof AdaUiState)[keyof typeof AdaUiState];

export function buildUiState(
  state: AdaUiStateCode,
  opts: { text?: string; icon?: string; brightness?: number } = {},
): string {
  return JSON.stringify({
    type: "SET_UI",
    state,
    ...(opts.text !== undefined && { text: opts.text }),
    ...(opts.icon !== undefined && { icon: opts.icon }),
    brightness: opts.brightness ?? 255,
  });
}
```

**`extensions/xiaozhi/src/ui-state.test.ts`** — test con mock WS che verifica ordine frame SET_UI.

### File da modificare

**`extensions/xiaozhi/src/audio-pipeline.ts`** — 9 punti di inserimento:

| Pipeline seam                                  | SET_UI call                                             |
| ---------------------------------------------- | ------------------------------------------------------- |
| `onListenStart()` dopo `state = "listening"`   | `buildUiState(LISTENING)`                               |
| `onListenStop()` → inizio `process()`          | `buildUiState(THINKING, { text: "Sto elaborando..." })` |
| `sendPrefetchedChunk()` con `isFirst === true` | `buildUiState(SPEAKING)`                                |
| Fine `process()` / `buildTts("stop")`          | `buildUiState(IDLE)`                                    |
| `silentAck()`                                  | `buildUiState(IDLE)`                                    |
| `onAbort()`                                    | `buildUiState(IDLE)`                                    |
| Tool call futuri (tools.ts)                    | `buildUiState(ACTING, { icon: "..." })`                 |
| Inizio compaction (rotation)                   | `buildUiState(COMPACTION, { text: "Organizzo..." })`    |
| Fine compaction (rotation)                     | `buildUiState(IDLE)`                                    |

**Regola**: `SET_UI` va inviato PRIMA del corrispondente frame `tts` per far transizionare la faccia prima dell'audio.

**`extensions/xiaozhi/src/protocol.ts`** — re-export `buildUiState` e `AdaUiState`.

### Addendum — Stato COMPACTION (codice 600)

**Problema attuale**: durante la compaction/rotation della sessione, il codice invia `buildLlm("🔄 Sto organizzando i ricordi...")` al device via WebSocket, ma sullo schermo non compare niente. Il motivo è che `buildLlm()` invia un frame `{"type":"llm","text":"..."}` che il firmware interpreta come testo di risposta LLM — visibile solo durante lo stato SPEAKING o in un'area testo attiva. Senza un cambio di stato display esplicito, il device resta in IDLE e ignora il testo.

**Soluzione**: aggiungere lo stato `COMPACTION = 600` alla state machine UI. Quando il bridge avvia la rotation sessione, invia `SET_UI` con stato 600 prima del feedback testuale. A fine rotation, torna a IDLE (100).

#### Dove avviene la compaction nel codice

| File                                        | Funzione                      | Riga | Cosa fa                                                                            |
| ------------------------------------------- | ----------------------------- | ---- | ---------------------------------------------------------------------------------- |
| `extensions/xiaozhi/src/context-manager.ts` | `maybeRotateSession()`        | ~139 | Runner principale: debounce, legge token, chiama reset                             |
| `extensions/xiaozhi/src/context-manager.ts` | `maybeRotateSession()`        | ~181 | Feedback inizio: `buildLlm("🔄 Sto organizzando...")` (DA SOSTITUIRE con SET_UI)   |
| `extensions/xiaozhi/src/context-manager.ts` | `maybeRotateSession()`        | ~209 | Feedback fine OK: `buildLlm("✅ Ricordi organizzati!")` (DA SOSTITUIRE con SET_UI) |
| `extensions/xiaozhi/src/audio-pipeline.ts`  | `pendingCompaction`           | ~543 | Trigger B: fire compaction DOPO TTS stop (post-response)                           |
| `extensions/xiaozhi/src/audio-pipeline.ts`  | closure in `runAgent`         | ~829 | Crea la closure `pendingCompaction` con `maybeRotateSession`                       |
| `extensions/xiaozhi/src/bridge.ts`          | `startNightlyCompaction()`    | ~44  | Trigger A: schedula nightly rotation alle 3:00                                     |
| `extensions/xiaozhi/src/context-manager.ts` | `scheduleNightlyCompaction()` | ~394 | Timer setTimeout per trigger nightly                                               |

#### Come implementare (con SET_UI)

```typescript
// PRIMA (attuale — non funziona sul display):
ws!.send(buildLlm("🔄 Sto organizzando i ricordi...", "neutral"));
// ...rotation...
ws!.send(buildLlm("✅ Ricordi organizzati!", "happy"));

// DOPO (con SET_UI):
ws!.send(buildUiState(AdaUiState.COMPACTION, { text: "Organizzo i ricordi..." }));
// ...rotation...
ws!.send(buildUiState(AdaUiState.IDLE));
```

#### Rendering LVGL suggerito (stato 600)

- Icona cervello/memoria al centro (o animazione rotazione documenti)
- Testo sotto: "Organizzo i ricordi..." (dal campo `text` di SET_UI)
- Colore accent soft (viola/blu) — distingue da THINKING (spinner) che è per l'LLM
- Durata tipica: 5-15 secondi (dipende dalla velocità del summary LLM)

### Verifica

- Mock client (`bun scripts/xiaozhi-mock-client.ts`) riceve i frame SET_UI nel log
- Test unitario `ui-state.test.ts`
- Il firmware attuale ignora silenziosamente i `type: "SET_UI"` (tipo sconosciuto → log warning)

**Complessità: S**

---

## Step 2 — 2.2A: MCP Hardware Tool Registration (Firmware C++)

**Obiettivo**: registrare 3 nuovi MCP tool nel firmware SenseCAP Watcher, invocabili dall'LLM.

Riferimento protocollo MCP: https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-protocol.md

### Tool 1 — `self.led.set`

- Parametri: `hex_color` (string 6 char), `mode` (static/pulse/blink), `duration_ms` (int 0-60000)
- Implementazione: parse hex → `SingleLed::SetColor(r,g,b)` + `TurnOn()`/`StartContinuousBlink()`
- Usa API esistente in `Note/main/led/single_led.h`

### Tool 2 — `self.haptic.feedback`

- Parametri: `pattern` (short/double/long)
- **Il Watcher NON ha motore vibrazione** → simulare con speaker buzz via `Application::PlaySound()`
- Usa suoni placeholder esistenti (OGG_SUCCESS, OGG_EXCLAMATION); suoni custom in Step 5
- ~~NON usare PWM su pin motore vibrazione~~ (hardware assente)

### Tool 3 — `self.sensor.read`

- Nessun parametro
- Ritorna JSON: `battery_pct`, `charging`, `volume`
- Il Watcher non ha sensori ambientali I2C (no SHT/BME) — ritorna solo dati disponibili
- Camera `self.camera.take_photo` esiste già

### File da modificare

- `Note/main/boards/sensecap-watcher/sensecap_watcher.cc` — aggiungere `InitializeTools()` con i 3 tool, chiamarlo dal costruttore dopo `InitializeCamera()`

### Verifica

- Serial monitor: trigger tool call da LLM, verificare cambio LED
- `idf.py monitor` per log ESP_LOGI dei tool call

**Complessità: M**

---

## Step 3 — 2.2B: Bridge Tool Handlers (TypeScript)

**Obiettivo**: promuovere gli stub tool in `tools.ts` a implementazioni reali che comunicano col device.

Riferimento integrazione MCP: https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-usage.md

### Aggiunte a `extensions/xiaozhi/src/bridge.ts`

```typescript
// Nuovo: tracking sessione attiva per routing tool
private lastActiveDeviceId: string | undefined;
notifyAudioActivity(deviceId: string): void;

// Nuovo: invio comando diretto al device
sendToActiveSession(json: string): boolean;

// Nuovo: chiamata MCP JSON-RPC con risposta asincrona (per camera)
private mcpRequestId = 0;
private pendingMcpCalls = new Map<number, McpPendingCall>();
callDeviceMcp(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
```

Nel handler `ws.on("message")`: gestire risposte JSON-RPC (`jsonrpc: "2.0"` con `result`/`error`) → risolvere `pendingMcpCalls`.

### Promozione tool in `extensions/xiaozhi/src/tools.ts`

| Tool              | Implementazione                                                                    |
| ----------------- | ---------------------------------------------------------------------------------- |
| `laragoci_led`    | `bridge.sendToActiveSession(buildLedCmd(hex, mode))`                               |
| `laragoci_haptic` | `bridge.sendToActiveSession(buildHapticCmd(pattern))`                              |
| `laragoci_photo`  | `bridge.callDeviceMcp("tools/call", {name: "self.camera.take_photo", ...}, 10000)` |
| `laragoci_volume` | `bridge.sendToActiveSession(buildVolumeCmd(vol))`                                  |
| `laragoci_emoji`  | `bridge.sendToActiveSession(buildUiState(ACTING, {icon}))`                         |
| `laragoci_status` | Restituisce stato connessione (locale, no device call)                             |

### File da modificare

- `extensions/xiaozhi/src/bridge.ts`
- `extensions/xiaozhi/src/tools.ts`
- `extensions/xiaozhi/src/types.ts` — tipo `McpPendingCall`

### Verifica

- Chiedere all'LLM vocalmente "accendi il LED verde" → LED cambia colore
- "scatta una foto" → camera cattura e l'LLM descrive l'immagine

**Complessità: M**

---

## Step 4 — 2.1B: Firmware UI State Machine (C++ LVGL)

**Obiettivo**: il firmware riceve `SET_UI` e renderizza gli 8 stati di Ada sul display 412x412.

### Architettura firmware

- **Task UI (Low Priority)**: gestisce le animazioni degli occhi (loop di 2-3 frame)
- **Interrupt Task (High Priority)**: riceve il pacchetto WebSocket e aggiorna immediatamente gli oggetti LVGL
- **Thread safety critica**: `SetState()` viene chiamato dal task WS. Mai toccare oggetti LVGL fuori dal task LVGL. Usare `lv_async_call()` per postare `ApplyState()` al task LVGL.

### Gli 8 stati di Ada

| Codice | Stato      | Rendering LVGL                                  |
| ------ | ---------- | ----------------------------------------------- |
| 000    | BOOT       | Animazione apertura occhi + testo connessione   |
| 100    | IDLE       | Occhi che battono (lv_anim opacity, 3s periodo) |
| 200    | LISTENING  | Onda sonora (lv_arc animato)                    |
| 300    | THINKING   | Spinner (lv_spinner, 1s arco, 2s rotazione)     |
| 400    | ACTING     | Icona tool al centro (camera/WA/Google/BT)      |
| 500    | SPEAKING   | Equalizer 4 barre (lv_bar altezza animata)      |
| 600    | COMPACTION | Icona memoria/cervello + testo "Organizzo..."   |
| 900    | SHUTDOWN   | Occhi che si chiudono → deep sleep              |

### Design decision

`AdaUiManager` è **separato** da `DeviceStateMachine` (non lo estende). La state machine Ada è puramente cosmetica e pilotata dal bridge — non interferisce con la logica di stato del device.

### File da creare (firmware)

- **`Note/main/display/ada_ui_manager.h`** — singleton, `SetState()`, `Initialize(lv_obj_t* parent)`
- **`Note/main/display/ada_ui_manager.cc`** — implementazione con LVGL procedurale (prima iterazione senza asset PNG)

### File da modificare (firmware)

- `Note/main/protocols/websocket_protocol.cc` — aggiungere dispatch per `type: "SET_UI"`:
  ```cpp
  if (strcmp(type_str, "SET_UI") == 0) {
      AdaUiManager::GetInstance().SetState(state_code, text, icon, brightness);
      return;
  }
  ```
- `Note/main/boards/sensecap-watcher/sensecap_watcher.cc` — nel costruttore dopo display init:
  ```cpp
  AdaUiManager::GetInstance().Initialize(display_->GetRootObj());
  ```
- `Note/main/CMakeLists.txt` — aggiungere `display/ada_ui_manager.cc`

### Verifica

- Mock client invia `{"type":"SET_UI","state":300,"text":"Pensando..."}` → display cambia
- Conversazione vocale completa: verificare transizioni IDLE→LISTENING→THINKING→SPEAKING→IDLE

**Complessità: L**

---

## Step 5 — 2.1C: Asset Creation & Deploy

**Obiettivo**: asset grafici per gli 8 stati, convertiti in C-array LVGL.

### Pipeline asset

1. **Generazione**: https://github.com/78/xiaozhi-assets-generator o design manuale a **412x412**
2. **Conversione**: LVGL Image Converter → CF_TRUE_COLOR_ALPHA, 16-bit RGB565
3. **Output**: file `.c`/`.h` in `Note/main/display/assets/`

### Strategia raccomandata

**Prima iterazione (Step 4)**: LVGL procedurale (arc, bar, spinner, label) — zero asset, funziona subito.
**Seconda iterazione (Step 5)**: sostituire con PNG reali per face polished.

### Budget Flash

- 1 immagine 412x412 @ RGB565 = ~340 KB — troppo per animazioni
- Sotto-elementi (occhi, bocca) a 80x80 = ~13 KB ciascuno — sostenibile
- Boot/Shutdown: JPEG in LittleFS, decodificato a runtime

### Font

- Utilizzare un font Sans-Serif (es. Montserrat) pre-renderizzato in 3 dimensioni:
  - Small (per i sottotitoli)
  - Medium (per lo stato)
  - Large (per l'orologio o icone grandi)

### File da creare

- `Note/main/display/assets/ada_eye_open.c` (1 frame)
- `Note/main/display/assets/ada_eye_blink.c` (3 frame)
- `Note/main/display/assets/ada_wave.c` (8 frame)
- `Note/main/display/assets/ada_mouth_*.c` (4 frame)
- `Note/main/display/assets/ada_icon_*.c` (camera, WA, google, BT — 1 frame ciascuno)

### Suoni haptic

- 3 file OGG: `haptic_short.ogg`, `haptic_double.ogg`, `haptic_long.ogg`
- Generabili con Audacity (tono 200Hz, durata 50/200/500ms)

**Complessità: M** (lavoro creativo + integrazione S)

---

## Step 6 — 2.2C: Power Management Fix

**Obiettivo**: spegnimento/deep sleep affidabile per i tester. Senza un reset/power-off affidabile, il supporto tecnico ai tester diventerà un incubo.

### Problema attuale

- Long-press quando in carica → nessun feedback (solo log "charging")
- `PowerSaveTimer::OnShutdownRequest` in carica → solo spegne backlight, non entra in deep sleep

### Fix

1. **Long-press handler**: mostrare `AdaUiManager::SetState(kAdaUiShutdown)` + dopo 1.5s `esp_deep_sleep_start()`
2. **Deep sleep wakeup**: `BSP_KNOB_BTN` è su IO expander TCA9555 (non GPIO diretto) → usare pin INT dell'expander come wakeup source:
   ```cpp
   esp_sleep_enable_ext0_wakeup(GPIO_NUM_2, 0); // IO_EXPANDER_INT, active-low
   ```
   GPIO_NUM_2 è RTC-capable su ESP32-S3 → funziona con deep sleep.
3. **PowerSaveTimer shutdown**: aggiungere `esp_deep_sleep_start()` anche quando in carica

### File da modificare

- `Note/main/boards/sensecap-watcher/sensecap_watcher.cc` — handler `BUTTON_LONG_PRESS_START` + costruttore (wakeup config)

### Verifica

- Long-press 2s → animazione shutdown → device si spegne
- Premere bottone → device si riaccende
- Testare sia in carica che a batteria

**Complessità: S** (richiede test hardware)

---

## Step 7 — 2.3: Bluetooth A2DP Sink

**Obiettivo**: streaming audio TTS verso cuffie BT. Quando BT è connesso, sostituisce lo speaker interno.

### Architettura

- **A2DP Sink**: device riceve comandi di pairing, diventa ricevitore audio
- **Routing**: quando BT paired → audio va a BT; quando non paired → speaker interno
- **Ring buffer**: 200ms a 44100Hz stereo int16 = ~35KB (allocare in PSRAM)

### Task Management FreeRTOS

- `Task_Audio_BT`: priorità 22 (massima), gestisce il buffer audio verso le cuffie
- `Task_Comm_WiFi`: priorità standard, gestisce lo scambio dati con il cloud

### Coesistenza WiFi+BT

- ESP32-S3: antenna condivisa, time-division automatico via `esp_wifi_bt_coex_config`
- WiFi: `WIFI_PS_MIN_MODEM` (non `WIFI_PS_NONE`) per coesistenza
- Buffer 200ms copre gap DTIM (~100ms) con margine 2x

### Conversione audio

- Pipeline attuale: Opus 24kHz mono → PCM int16
- A2DP richiede: 44100Hz stereo int16
- `BtAudioSink::WritePcm()` fa resample + stereo duplicate

### File da creare

- `Note/main/audio/bt_audio_sink.h` + `bt_audio_sink.cc`

### Config

- `sdkconfig`: `CONFIG_BT_ENABLED=y`, `CONFIG_BT_CLASSIC_ENABLED=y`, `CONFIG_BT_A2DP_ENABLE=y`
- Gated dietro `CONFIG_ADA_BT_A2DP` Kconfig option (compilabile out)

### File da modificare

- `Note/main/boards/sensecap-watcher/sensecap_watcher.cc` — init BT nel costruttore
- `Note/main/CMakeLists.txt` — aggiungere bt_audio_sink.cc + componenti IDF `bt`, `bluedroid`
- `Note/main/Kconfig.projbuild` — opzione `CONFIG_ADA_BT_A2DP`

### Verifica

- Pairing cuffie BT con device
- Conversazione vocale → audio esce dalle cuffie
- WiFi stabile durante streaming BT (no disconnessioni WS)

**Complessità: XL** (massimo rischio, richiede test hardware estensivo)

---

## Rischi e mitigazioni

| Rischio                                  | Impatto           | Mitigazione                                 |
| ---------------------------------------- | ----------------- | ------------------------------------------- |
| LVGL thread safety (SetState da task WS) | Crash             | Usare `lv_async_call()` esclusivamente      |
| Display 412x412 vs 320x320 nel doc       | Layout sbagliato  | Corretto in questo piano                    |
| BT+WiFi glitch audio                     | Scatti audio      | Buffer 400ms se 200ms insufficiente         |
| Camera JPEG troppo grande per MCP reply  | Send fallisce     | Verificare WS buffer ≥128KB                 |
| Deep sleep wakeup via IO expander        | Non si riaccende  | Usare INT pin (GPIO_NUM_2) come ext0 wakeup |
| `PlaySound()` haptic asincrono           | Suoni sovrapposti | Flag `haptic_busy` in fase 3 se necessario  |
| Camera timeout MCP                       | Tool fallisce     | Timeout 10s per `laragoci_photo`            |

---

## File di riferimento (repo-relative)

### Esistenti (da modificare)

- `extensions/xiaozhi/src/protocol.ts`
- `extensions/xiaozhi/src/audio-pipeline.ts`
- `extensions/xiaozhi/src/bridge.ts`
- `extensions/xiaozhi/src/tools.ts`
- `extensions/xiaozhi/src/types.ts`
- `extensions/xiaozhi/src/context-manager.ts`

### Firmware reference (in Note/main/)

- `Note/main/protocols/websocket_protocol.cc`
- `Note/main/boards/sensecap-watcher/sensecap_watcher.cc`
- `Note/main/mcp_server.h/.cc`
- `Note/main/led/single_led.h`
- `Note/main/display/lcd_display.cc`
- `Note/main/device_state_machine.h/.cc`

### Da creare

- `extensions/xiaozhi/src/ui-state.ts`
- `extensions/xiaozhi/src/ui-state.test.ts`
- `Note/main/display/ada_ui_manager.h/.cc` (firmware ref)
- `Note/main/display/assets/` (C-array images)
- `Note/main/audio/bt_audio_sink.h/.cc` (firmware ref)
