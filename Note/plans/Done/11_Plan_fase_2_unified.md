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

**✅ FATTO — 2026-04-13** (3 commit: prompt vocale stretto, sanitizer TTS migliorato, instant router + meteo pattern disabilitati)

- [`c4f0ca8218`](https://github.com/openclaw/openclaw/commit/c4f0ca8218) fix(xiaozhi): tighten voice prompt and improve TTS sanitizer
- [`2083aca668`](https://github.com/openclaw/openclaw/commit/2083aca668) fix(xiaozhi): remove meteo instant-router pattern — LLM handles it better
- [`a28c420904`](https://github.com/openclaw/openclaw/commit/a28c420904) fix(xiaozhi): disable instant router — LLM handles all queries better

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

**✅ FATTO — 2026-04-13** (1 commit: protocollo SET_UI con 8 stati, 6 seam points in audio-pipeline, 2 in context-manager compaction)

- [`d40748147d`](https://github.com/openclaw/openclaw/commit/d40748147d) feat(xiaozhi): add SET_UI frame protocol for device display states

---

## Step 2 — 2.2A: MCP Hardware Tool Registration (Firmware C++)

**Obiettivo**: registrare 3 nuovi MCP tool nel firmware SenseCAP Watcher, invocabili dall'LLM.

Riferimento protocollo MCP: https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-protocol.md
Riferimenoto piano claude : /home/openclaw/.claude/plans/lucky-hopping-parnas.md

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

**✅ FATTO — 2026-04-14** (firmware compilato e flashato su SenseCAP Watcher, tool registrati e verificati nel serial monitor)

#### Modifiche applicate (nel progetto ESP-IDF sulla VM firmware, NON in Note/main/)

**File 1: `main/led/single_led.h`** — Resi public 6 metodi LED (erano private):

```cpp
// Spostati da private a public (dopo OnStateChanged):
void SetColor(uint8_t r, uint8_t g, uint8_t b);
void TurnOn();
void TurnOff();
void BlinkOnce();
void Blink(int times, int interval_ms);
void StartContinuousBlink(int interval_ms);
```

**File 2: `main/boards/sensecap-watcher/sensecap_watcher.cc`** — 4 modifiche:

1. **Include aggiunto** (dopo `#include "assets/lang_config.h"`):

```cpp
#include "mcp_server.h"
```

2. **Membro privato aggiunto** (dopo `SscmaCamera* camera_ = nullptr;`):

```cpp
esp_timer_handle_t led_duration_timer_ = nullptr;
```

3. **Metodo `InitializeTools()`** aggiunto nella sezione private — crea un `esp_timer` one-shot per auto-restore LED e registra 3 tool MCP:

- **`self.led.set`**: params `hex_color` (string 6 hex), `mode` (static/pulse/blink, default static), `duration_ms` (0-60000, default 0). Parse hex → `SetColor(r,g,b)` → static=`TurnOn()`, pulse=`StartContinuousBlink(500)`, blink=`StartContinuousBlink(200)`. Se duration>0, `esp_timer_start_once()` → al fire chiama `OnStateChanged()` (ripristina stato device).
- **`self.haptic.feedback`**: param `pattern` (short/double/long). Mapping: short→`OGG_VIBRATION`, double→`OGG_EXCLAMATION`, long→`OGG_SUCCESS`. Chiama `Application::GetInstance().PlaySound(sound)`.
- **`self.sensor.read`**: nessun param. Ritorna `cJSON*` con `battery_pct` (int), `charging` (bool), `volume` (int). Usa `GetBatteryLevel()` + `GetAudioCodec()->output_volume()`.

4. **Costruttore** — aggiunto `InitializeTools();` come ultima chiamata dopo `InitializeCamera();`.

#### Verifica serial monitor (log boot)

```
I (1841) MCP: Add tool: self.led.set
I (1841) SscmaCamera: SSCMA restarted detected
I (1851) MCP: Add tool: self.haptic.feedback
I (1851) MCP: Add tool: self.sensor.read
```

#### Nota

I tool sono registrati nel firmware MCP ma l'LLM non li invoca ancora — serve Step 3 (2.2B Bridge Tool Handlers) per il ponte gateway↔device via MCP JSON-RPC.

---

## Step 3 — 2.2B: Bridge Tool Handlers (TypeScript)

**Obiettivo**: promuovere gli stub tool in `tools.ts` a implementazioni reali che comunicano col device.

Riferimento integrazione MCP: https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-usage.md
riferimento plna openclaw: /home/openclaw/.claude/plans/wondrous-gathering-bengio.md

**✅ FATTO — 2026-04-16** (3 commit: MCP JSON-RPC bridge + tool handlers + singleton fix per routing tool)

- [`5630288dda`](https://github.com/openclaw/openclaw/commit/5630288dda) feat(xiaozhi): add MCP bridge tool handlers for device hardware control
- [`14f20a681f`](https://github.com/openclaw/openclaw/commit/14f20a681f) fix(xiaozhi): use module-level bridge singleton for tool execution
- [`24557757a0`](https://github.com/openclaw/openclaw/commit/24557757a0) fix(xiaozhi): use process-global bridge ref via Symbol.for

**Verificato funzionante** — L'LLM invoca i tool hardware (LED, haptic, sensor, volume, emoji, foto, status) e il device esegue i comandi correttamente. Il fix `Symbol.for` risolve il problema del bridge singleton tra bundle separati (entry.js / extensionAPI.js).

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

### Bug noti

#### Bug 3A: Effetti tool hardware legati al ciclo di vita della risposta LLM

**Problema**: tutti i comandi hardware (LED, haptic, volume, emoji) vengono resettati quando la risposta dell'LLM finisce, invece di persistere per la durata richiesta. Esempio: "tieni acceso il LED verde per 10 secondi" → il LED si accende ma si spegne a fine risposta (~2-3s), non dopo 10s.

**✅ FATTO — 2026-04-16** (4 commit: deferred execution post-IDLE, persist flag, hw effect restore, repeat parameter)

- [`1dda2d9529`](https://github.com/openclaw/openclaw/commit/1dda2d9529) fix(xiaozhi): decouple hardware effects from LLM turn lifecycle and add Pixtral vision to photo tool
- [`816772cfdc`](https://github.com/openclaw/openclaw/commit/816772cfdc) fix(xiaozhi): persist hardware effects across SET_UI state resets (Bug 3A) and restore photo question arg
- [`3e6ce7cf7e`](https://github.com/openclaw/openclaw/commit/3e6ce7cf7e) fix(xiaozhi): trigger hw effect restore from pipeline sendJson, not just bridge
- [`fde8e2d642`](https://github.com/openclaw/openclaw/commit/fde8e2d642) fix(xiaozhi): defer LED/haptic/play execution to post-IDLE and use agent pipeline for photo vision
- [`a9cdc02e00`](https://github.com/openclaw/openclaw/commit/a9cdc02e00) fix(xiaozhi): add repeat parameter to haptic and play tools

**Soluzione adottata**: mix di Opzione A + C. I tool hardware non eseguono più durante il turno LLM — vengono accodati come `DeferredHwAction` e eseguiti **dopo** che il device torna in IDLE (post-TTS). Gli effetti persistenti (LED) vengono ri-applicati dopo ogni `SET_UI IDLE` reset. Haptic/play sono fire-and-forget con `persist: false`. Il parametro `repeat` (1-20) permette all'LLM di specificare quante volte ripetere, con 400ms di delay tra azioni.

Guida architetturale: [`Note/plans/Guide/camera-vision-proxy.md`](Note/plans/Guide/camera-vision-proxy.md)

#### Bug 3B: Foto scattata ma LLM non può analizzarla (modello visione mancante)

**Problema**: il tool `laragoci_photo` scatta la foto con successo (il device esegue `self.camera.take_photo` e ritorna il JPEG), ma l'LLM risponde che non può analizzare l'immagine perché non ha un modello di visione configurato. Mistral `mistral-small-latest` non è multimodale.

**✅ FATTO — 2026-04-16** (3 commit: vision proxy HTTP endpoint, URL fix tunnel Cloudflare, multipart parser fix)

- [`1dda2d9529`](https://github.com/openclaw/openclaw/commit/1dda2d9529) fix(xiaozhi): decouple hardware effects from LLM turn lifecycle and add Pixtral vision to photo tool
- [`fde8e2d642`](https://github.com/openclaw/openclaw/commit/fde8e2d642) fix(xiaozhi): defer LED/haptic/play execution to post-IDLE and use agent pipeline for photo vision
- [`61d13c783e`](https://github.com/openclaw/openclaw/commit/61d13c783e) feat(xiaozhi): add vision proxy for camera photo analysis via Pixtral

**Soluzione adottata**: Opzione A — vision proxy HTTP. Il bridge invia l'URL `https://laragoci.lara-ai.eu/xiaozhi/vision` al firmware via MCP `initialize`. Il firmware cattura il JPEG, lo POSTa al proxy via tunnel Cloudflare. Il proxy (`vision-proxy.ts`) analizza l'immagine con `pixtral-large-latest` via `runEmbeddedPiAgent` e ritorna la descrizione testuale al firmware, che la passa come risultato MCP al gateway.

Bug risolti durante l'integrazione:

- URL vision: da `localhost:18789` a URL tunnel Cloudflare (device non raggiunge localhost)
- Campo multipart: firmware manda `name="file"`, proxy aspettava `name="image"`
- Regex greedy: `.*name=` matchava `filename=` invece del primo `name=` → fix con `.*?`
- Cache jiti: `/tmp/jiti/` cachava il vecchio codice transpilato dei plugin

Guida architetturale: [`Note/plans/Guide/camera-vision-proxy.md`](Note/plans/Guide/camera-vision-proxy.md)

### Verifica

- Chiedere all'LLM vocalmente "accendi il LED verde" → LED cambia colore
- "scatta una foto" → camera cattura e l'LLM descrive l'immagine

**Complessità: M**

---

## Ada peronnalita

plan per modifica personalita di Ada
~/.claude/plans/melodic-sparking-sunrise.md

## Step 4 — 2.1B: Firmware UI State Machine (C++ LVGL)

planmode : /home/openclaw/.claude/plans/replicated-sniffing-octopus.md

**Obiettivo**: il firmware riceve `SET_UI` e renderizza gli 8 stati di Ada sul display 412x412.

### Tool di design

**Scelto: LVGL Pro** (https://lvgl.io/pro) — editor visuale con live preview, timeline animations, export C code diretto. Desktop app o browser, zero setup. Free trial 30gg, free per repo pubblici.

- Workflow: design stati 412x412 nell'editor → preview animazioni live → export C → port nel firmware → test su device

**Alternativa: LVGL MCP Simulator** (https://github.com/jaklys/Lvgl-mcp-esp32) — simulatore headless Windows, utile per far generare codice LVGL a Claude (screenshot PNG + widget tree JSON). Complementare all'editor per iterazioni rapide via AI.

**Compatibilità versioni**: firmware XiaoZhi usa LVGL **9.4.0** (`~9.4.0` in `idf_component.yml`), MCP simulator usa v9.2 — entrambi v9.x, API compatibile.

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

### Progresso Step 4 — 2026-04-18

#### 4A: Stato IDLE (Astro Bot eyes) — LVGL Pro + firmware integration

**Design LVGL Pro completato** — progetto `Note/ada_ui/`:

- `globals.xml`: palette ridotta (`bg_dark` #000000, `ada_blue` #00AAFF) + costanti dimensioni occhio (`ada_ew=70`, `ada_eh=100`, `ada_er=35`, `ada_gap=60`). Prefisso `ada_` obbligatorio per evitare clash con include guard generati.
- `components/eye/eye.xml`: singolo `lv_obj` pill-shaped via `<style>` (NON attributi diretti su `<view>` — LVGL Pro non li accetta).
- `screens/screen_idle/screen_idle.xml`: sfondo nero 412x412, 2 eye centrati (x=106/236, y=156), timeline blink (height 100→6→100, 200ms).
- Screen `<view>` senza `extends="lv_obj"` — lo screen IS lo screen object.

**Codice C generato** da LVGL Pro export: `ada_ui*.c/h`, `eye_gen.c/h`, `screen_idle_gen.c/h`.

**Wrapper C++** manuale:

- `ada_ui_manager.h/cc` — singleton, chiama `ada_ui_init(NULL)` + `screen_idle_create()` + `lv_screen_load()`. Blink repeat via `esp_timer` ogni 3.5s che retrigga `screen_idle_get_timeline(BLINK)`.

**Integrazione firmware**: 3 patch (CMakeLists, sensecap_watcher.cc, application.cc SET_UI dispatch).

**Guida workflow**: `Note/plans/Guide/lvgl_pro_workflow.md`

**✅ COMPLETATO — 2026-04-18** — Occhi Astro Bot visibili sul display SenseCAP Watcher.

**Fix applicati durante l'integrazione**:

- `CONFIG_LV_USE_OBJ_NAME=y` abilitato in `sdkconfig` (era commentato, serviva per `lv_obj_set_name`/`lv_obj_find_by_name` del codice LVGL Pro generato)
- `AdaUiManager::Initialize()` va chiamato in `CustomLcdDisplay::SetupUI()` (non nel costruttore `SensecapWatcher`) — altrimenti `Application::Initialize()` sovrascrive lo screen con la UI chat standard
- Header/cc del manager aggiornati: usa codice LVGL Pro generato (`ada_ui_init()` + `screen_idle_create()` + `lv_screen_load()`) invece di creare LVGL objects manualmente

**Lezioni apprese LVGL Pro XML**:

1. `<view ... />` self-closing non valido → usare `<view>...</view>`
2. `bg_color`, `radius`, `bg_opa`, `border_width` NON sono attributi di `<view>` → vanno in `<style>`
3. Nomi costanti globali diventano `#define UPPER_CASE` → conflitto con include guard se nome = componente (es. `eye_h` → `EYE_H` = guard di `eye_gen.h`)
4. Screen `<view>` senza `extends` — NON è un `lv_obj`, è lo screen root

---

### 4B: Bug fix post-integrazione — 2026-04-18

paln : /home/openclaw/.claude/plans/rustling-launching-wilkes.md
Dopo l'integrazione degli occhi Ada (4A), 5 bug firmware + 2 bug bridge risolti in sessione.

#### Bug 4B-1: Handler SET_UI mancante (firmware)

**Problema**: `W Application: Unknown message type: SET_UI` — il firmware non gestiva il messaggio SET_UI dal bridge.
**Fix**: Aggiunto handler in `application.cc` → `OnIncomingJson()`, dispatch a `AdaUiManager::GetInstance().SetState()`.
**✅ FATTO** — verificato nel serial log: `AdaUI: State: 100 -> 200`

#### Bug 4B-2: Handler ping mancante (firmware)

**Problema**: `W Application: Unknown message type: ping` — keepalive dal bridge non gestito.
**Fix**: Aggiunto handler silenzioso in `application.cc` → `OnIncomingJson()`.
**✅ FATTO** — nessun warning nel log.

#### Bug 4B-3: AFE ringbuffer overflow (firmware)

**Problema**: `W AFE: Ringbuffer of AFE(FEED) is full` — backpressure dalla send queue (WiFi lento) bloccava il fetch dall'AFE.
**Root cause**: `PushTaskToEncodeQueue()` in `audio_service.cc` usava `wait()` bloccante → se la send queue era piena (WebSocket lento), il fetch dall'AFE si fermava → ringbuffer overflow → device si bloccava.
**Fix**: In `PushTaskToEncodeQueue()`, per `kAudioTaskTypeEncodeToSendQueue` → drop frame invece di bloccare. Il testing mode mantiene il wait bloccante.
**✅ FATTO** — testato con WiFi debole, nessun overflow.

#### Bug 4B-4: Tool `self.audio_player.play` non registrato (firmware)

**Problema**: `E MCP: tools/call: Unknown tool: self.audio_player.play` — il tool play non era registrato nel firmware.
**Fix**: Aggiunto Tool 4 in `sensecap_watcher.cc` → `InitializeTools()`. Mapping 5 suoni locali: success, vibration, exclamation, popup, welcome.
**✅ FATTO** — `sensecap_watcher: Playing sound: success`

#### Bug 4B-5: Blink timer non si ferma durante stati non-IDLE (firmware)

**Problema**: Gli occhi continuavano a lampeggiare durante LISTENING/THINKING/SPEAKING.
**Fix**: `SetState()` in `ada_ui_manager.cc` ora ferma il blink timer quando esce da IDLE e lo riavvia quando torna a IDLE. Blink ridotto da 3.5s a 2s.
**✅ FATTO** — occhi fissi aperti durante listening/speaking.

#### Bug 4B-6: STT silenzio al primo push-to-talk (bridge)

**Problema**: Il primo push-to-talk dopo connessione WS catturava solo silenzio (mic warmup). Il bridge mandava tts:start+stop vuoto → nessun feedback all'utente.
**Fix**: Quando STT ritorna null, il bridge inietta "Scusami non ho sentito, puoi ripetere?" come fallback vocale invece del silent ack.
**✅ FATTO** — commit [`f746fa4842`](https://github.com/openclaw/openclaw/commit/f746fa4842)

#### Bug 4B-7: LLM mandava URL invece di nomi suoni locali (bridge)

**Problema**: La description del tool `laragoci_play` diceva "Audio URL" → l'LLM mandava URL internet (es. mixkit.co/...) invece dei nomi locali.
**Fix**: Aggiornata description e parametro url → "Sound name: success, vibration, exclamation, popup, welcome."
**✅ FATTO** — commit [`faf4e623e4`](https://github.com/openclaw/openclaw/commit/faf4e623e4)

#### Preview foto su screen Ada — RIMANDATO

**Decisione**: la preview foto richiede un screen LVGL dedicato con decodifica JPEG. Meglio progettarlo in LVGL Pro insieme agli altri stati (LISTENING, THINKING, SPEAKING) piuttosto che hackerarlo nello screen idle attuale. Da fare dopo Step 4C (completamento stati visivi).

#### Commit riassunto sessione 4B

| Commit                                                                 | Descrizione                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`f746fa4842`](https://github.com/openclaw/openclaw/commit/f746fa4842) | fix(xiaozhi): voice fallback when STT returns silence instead of silent ack |
| [`faf4e623e4`](https://github.com/openclaw/openclaw/commit/faf4e623e4) | fix(xiaozhi): update play tool description to use local sound names         |
| [`8dbcccd53d`](https://github.com/openclaw/openclaw/commit/8dbcccd53d) | docs(notes): add Step 4B bug fixes to Plan 11 — 7 bugs resolved             |

Bug firmware (4B-1 → 4B-5) applicati direttamente sulla VM firmware, non tracciati in git repo OpenClaw.

---

### 4C: Boot/WiFi UX states — 2026-04-19

plan: /home/openclaw/.claude/plans/plan-boot-wifi-ux.md

**Obiettivo**: feedback visivo durante il boot. Prima di 4C il display saltava direttamente agli occhi (IDLE) senza mostrare stati intermedi.

**Design LVGL Pro** — 2 nuovi componenti + 1 nuovo screen:

- `components/boot_title/boot_title.xml` — `extends="lv_label"`, style: `bg_opa="0"`, `border_width="0"`, `text_color="#ada_blue"`, `width="412"`, `text_align="center"`
- `components/boot_status/boot_status.xml` — `extends="lv_label"`, style: `bg_opa="0"`, `border_width="0"`, `text_color="0x888888"`, `width="300"`, `text_align="center"`
- `screens/screen_boot/screen_boot.xml` — sfondo nero 412x412, `boot_title` (y=176) + `boot_status` (x=56, y=226)

**Lezione LVGL Pro**: `<label>` non è tag valido in `<view>` → servono **componenti** con `extends="lv_label"`. Aggiungere `bg_opa="0"` + `border_width="0"` per rimuovere il rettangolo background di default.

**Nuovi stati enum**:

```cpp
kAdaUiBoot           = 0     // "Ada" centrato (Montserrat 48, ADA_BLUE)
kAdaUiWifiConnecting = 10    // + "WiFi..."
kAdaUiWifiConfig     = 20    // + "Configura WiFi\nHotspot: ...\nIP: ..."
kAdaUiActivating     = 50    // + "Attivazione..."
```

**Modifiche firmware**:

| File                | Modifica                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ada_ui_gen.h`      | Include `boot_title_gen.h`, `boot_status_gen.h`, `screen_boot_gen.h`                                                                                                                                             |
| `ada_ui_manager.h`  | Nuovi stati enum + `boot_screen_` membro + `SetBootStatus()`                                                                                                                                                     |
| `ada_ui_manager.cc` | `Initialize()`: boot*screen* prima, idle*screen* dopo. `SetState()`: transizioni boot→idle. Font Montserrat 48 per titolo                                                                                        |
| `application.cc`    | `HandleStateChangedEvent()`: kDeviceStateIdle→kAdaUiIdle, kDeviceStateWifiConfiguring→kAdaUiWifiConfig. Network callback: Scanning/Connecting→kAdaUiWifiConnecting. HandleNetworkConnectedEvent→kAdaUiActivating |
| `wifi_board.cc`     | `StartWifiConfigMode()`: `SetBootStatus()` con SSID+IP                                                                                                                                                           |

**Config ESP-IDF**: `lv_font_montserrat_48` abilitata via menuconfig (Component config → LVGL → Font).

**Flusso boot verificato**:

```
Power on → "Ada" → "WiFi..." → "Attivazione..." → occhi con blink
WiFi non configurato → "Ada" → "Configura WiFi\nHotspot: Xiaozhi-XXXX\nIP: ..."
```

**✅ COMPLETATO — 2026-04-19** — Boot UX funzionante su SenseCAP Watcher.

---

### Step 4D — Stati attivi UI con `screen_state` (LVGL Pro XML)

**Obiettivo**: feedback testuale per tutti gli stati attivi (LISTENING, THINKING, ACTING, SPEAKING, COMPACTION, SHUTDOWN). Un solo screen nuovo `screen_state` con occhi + blink + label di stato, anziché screen separati per ogni stato.

**Approccio**: componente `state_label` riusabile (extends `lv_label`, stile centrato, bg trasparente) + `screen_state` con occhi Ada identici a `screen_idle` + label sotto a y=310.

**Scritte per stato**:

| Codice | Stato      | Testo               |
| ------ | ---------- | ------------------- |
| 200    | LISTENING  | Ti Ascolto          |
| 300    | THINKING   | Fammi Ragionare     |
| 400    | ACTING     | Cassetta attrezzi   |
| 500    | SPEAKING   | Ascoltami           |
| 600    | COMPACTION | Organizzo i ricordi |
| 900    | SHUTDOWN   | Spegnimento         |

Il firmware aggiunge dots animati via timer (`"Ti Ascolto"` → `"Ti Ascolto ."` → `"Ti Ascolto .."` → `"Ti Ascolto ..."` → ciclo).

**File creati**:

| File                                                   | Descrizione                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `Note/ada_ui/components/state_label/state_label.xml`   | Componente label riusabile (extends `lv_label`, bg_opa=0, centrato) |
| `Note/ada_ui/components/state_label/state_label_gen.c` | Codice C generato da LVGL Pro                                       |
| `Note/ada_ui/components/state_label/state_label_gen.h` | Header generato                                                     |
| `Note/ada_ui/screens/screen_state/screen_state.xml`    | Screen con occhi + blink + state_label                              |
| `Note/ada_ui/screens/screen_state/screen_state_gen.c`  | Codice C generato                                                   |
| `Note/ada_ui/screens/screen_state/screen_state_gen.h`  | Header generato                                                     |

**Integrazione firmware** (manuale):

1. `screen_state_create()` → carica lo screen
2. `lv_obj_get_child_by_name(screen, "status_text")` → trova la label
3. `lv_label_set_text(label, "...")` → imposta testo per lo stato corrente
4. Timer `esp_timer` ogni ~400ms per animazione dots
5. Su ritorno a IDLE → `screen_idle_create()` + `lv_screen_load()`

**File deprecati** (non cancellati): `screen_listening`, componenti `ear_*`, `listening_label` — sostituiti da `screen_state` + `state_label`.

**✅ COMPLETATO — 2026-04-23** — XML + codice generato per tutti e 6 gli stati attivi.

---

### Progresso stati UI Ada — riepilogo

| Codice | Stato           | Screen LVGL    | Status |
| ------ | --------------- | -------------- | ------ |
| 0      | BOOT            | `screen_boot`  | ✅ 4C  |
| 10     | WIFI_CONNECTING | `screen_boot`  | ✅ 4C  |
| 20     | WIFI_CONFIG     | `screen_boot`  | ✅ 4C  |
| 50     | ACTIVATING      | `screen_boot`  | ✅ 4C  |
| 100    | IDLE            | `screen_idle`  | ✅ 4A  |
| 200    | LISTENING       | `screen_state` | ✅ 4D  |
| 300    | THINKING        | `screen_state` | ✅ 4D  |
| 400    | ACTING          | `screen_state` | ✅ 4D  |
| 500    | SPEAKING        | `screen_state` | ✅ 4D  |
| 600    | COMPACTION      | `screen_state` | ✅ 4D  |
| 900    | SHUTDOWN        | `screen_state` | ✅ 4D  |

**✅ Tutti gli stati UI completati.** Step 5 (Asset Creation) è il prossimo step opzionale per sostituire il rendering procedurale con PNG reali.

┌────────────┬───────────┐  
 │ Stato │ Label │  
 ├────────────┼───────────┤
│ LISTENING │ Ascolto │
├────────────┼───────────┤
│ THINKING │ Ragiono │
├────────────┼───────────┤
│ ACTING │ Eseguo │
├────────────┼───────────┤
│ SPEAKING │ Parlo │
├────────────┼───────────┤
│ COMPACTION │ Memorizzo │
├────────────┼───────────┤
│ SHUTDOWN │ Dormo │

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
