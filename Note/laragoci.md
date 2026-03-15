# LaraGoci - Guida Progetto per Claude

> Documento di riferimento per Claude Code e agenti AI.
> Contiene vision, architettura, protocollo, stato avanzamento, decisioni e risultati di ricerca.
> **Ultimo aggiornamento:** 2026-02-19

---

## Finalita'

Costruire delle RESTful API per la gestione del LaraGoci. OpenClaw deve scrivere un MCP server
per utilizzare il LaraGoci. OpenClaw deve utilizzare il LaraGoci come il suo corpo fisico.

### Funzionalita' (priorita')

| Funzionalita'                | Priorita' | Note                                       |
| ---------------------------- | --------- | ------------------------------------------ |
| **Ascoltare**                | TOP       | Audio in continuo ascolto con wake word    |
| **Parlare**                  | TOP       | TTS cloud → speaker ESP32                  |
| **Emoji sullo schermo**      | TOP       | Display LCD 320x240, feedback visivo stati |
| **Connettersi al Bluetooth** | Media     | A2DP audio, pairing vocale senza app       |
| **Riprodurre audio**         | Media     | Playback musica/notifiche/alert            |

### Concetto fondamentale

LaraGoci e' un **nodo OpenClaw** connesso tramite WebSocket (WSS).
OpenClaw usa LaraGoci come il suo corpo: i LED sono i suoi occhi, lo speaker la sua voce,
il microfono le sue orecchie, la vibrazione il suo modo di "toccare".

---

## Strategia di Integrazione: XiaoZhi + OpenClaw

### Il problema

XiaoZhi ha il suo backend completo (Python+Java+Vue, Docker). Se usato cosi' com'e',
**bypassa completamente OpenClaw** — l'ESP32 parlerebbe con un LLM generico,
NON con l'agente LaraGoci personalizzato (con memoria, Google Workspace, WhatsApp, personalita').

```
SBAGLIATO:  ESP32 → XiaoZhi Server (Docker) → LLM generico  (bypassa OpenClaw!)
CORRETTO:   ESP32 → OpenClaw Gateway (bridge) → Agente LaraGoci (Claude + tools + memoria)
```

### La soluzione

Da XiaoZhi prendiamo solo il **firmware** (gestione hardware: mic, speaker, display, wake word).
Il backend XiaoZhi (Python/Java/Vue) **NON lo usiamo** — OpenClaw lo sostituisce completamente.

Nel gateway OpenClaw costruiamo un **bridge** che "parla la lingua" del firmware XiaoZhi:
cioe' implementiamo le regole di comunicazione (protocollo) che il firmware si aspetta.
Non copiamo il server — copiamo solo il **formato dei messaggi**.

### I 3 livelli di comunicazione

```
┌─────────────────────────────────────────────────────┐
│  AGENTE LaraGoci (Claude + memoria + tools)         │
│                                                      │
│  Ha personalita', ricorda tutto, ha Google Calendar,  │
│  WhatsApp, Brave Search. Usa il device come corpo.   │
│                                                      │
│  Quando vuole fare qualcosa sul device, usa MCP:     │
│  → laragoci.speak("testo da dire")                   │
│  → laragoci.emoji("😀")                              │
│  → laragoci.volume(50)                               │
│  → laragoci.status()                                 │
└──────────────────┬──────────────────────────────────┘
                   │ Livello 3: OpenClaw MCP (tool calls)
                   │ L'agente controlla il device come suo corpo.
                   │ Usato nel heartbeat, notifiche WhatsApp,
                   │ promemoria calendario, iniziativa proattiva.
                   ▼
┌─────────────────────────────────────────────────────┐
│  BRIDGE (nel gateway OpenClaw, Node.js)             │
│                                                      │
│  Parla DUE lingue:                                   │
│  - Capisce i tool MCP dall'agente (livello 3)        │
│  - Parla il protocollo XiaoZhi col device (livelli   │
│    1 e 2)                                            │
│                                                      │
│  Traduce in entrambe le direzioni:                   │
│  MCP laragoci.speak → protocollo XiaoZhi tts+Opus   │
│  Audio Opus dal device → Whisper → testo → agente   │
└──────────────────┬──────────────────────────────────┘
                   │ Livello 1: Protocollo XiaoZhi voce
                   │   (hello, listen, stt, tts, llm/emotion,
                   │    abort + frame binari Opus)
                   │
                   │ Livello 2: Protocollo XiaoZhi MCP device
                   │   (type:"mcp", JSON-RPC 2.0 per volume,
                   │    LED, status — comandi hardware)
                   │
                   │ Tutto su una singola connessione WebSocket
                   ▼
┌─────────────────────────────────────────────────────┐
│  ESP32-S3-BOX-3 (firmware XiaoZhi)                  │
│                                                      │
│  Parla SOLO protocollo XiaoZhi.                      │
│  Sa fare: mic, speaker, display, wake word, BLE.     │
│  Non sa niente di OpenClaw, Claude, Google, ecc.     │
│  E' il corpo: orecchie, bocca, occhi.                │
└─────────────────────────────────────────────────────┘
```

### Spiegazione dei 3 livelli

**Livello 1 — Voce (protocollo XiaoZhi core)**
Il canale per parlare e ascoltare. Succede automaticamente quando l'utente parla:

```
Francesco dice "che appuntamenti ho domani?"
→ Device: {"type":"listen","state":"start"} + frame Opus
→ Bridge: Opus → Whisper → "che appuntamenti ho domani?"
→ Agente: consulta Google Calendar → risposta
→ Bridge: TTS → Opus → {"type":"tts","state":"start"} + frame Opus
→ Device: riproduce sullo speaker
```

**Livello 2 — Controllo device (protocollo XiaoZhi MCP)**
Per comandare l'hardware (volume, LED, reboot). Messaggi `type:"mcp"` con JSON-RPC 2.0.

**Livello 3 — Agente (OpenClaw MCP)**
L'agente LaraGoci usa tool MCP per agire **di sua iniziativa**:

```
Heartbeat ore 14:50 → laragoci.speak("Tra 10 min hai l'avvocato")
WhatsApp da Jona   → laragoci.speak("Jona: compra il latte") + laragoci.emoji("🛒")
Di notte           → laragoci.volume(10)
```

### Cosa deve implementare OpenClaw

**Approccio:** Build from source + estensione `extensions/xiaozhi/`

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw && pnpm install && pnpm ui:build && pnpm build
pnpm openclaw onboard --install-daemon
pnpm gateway:watch  # Dev loop con auto-reload
```

**1 sola modifica al core** (file `src/gateway/server-http.ts`):
Aggiungere nel WS upgrade handler un check: se path `/xiaozhi/v1/` → passa al bridge XiaoZhi.

**Tutto il resto e' nell'estensione** `extensions/xiaozhi/`:

```
extensions/xiaozhi/
├── openclaw.plugin.json        # Manifesto plugin
├── package.json                # Dipendenze (@discordjs/opus)
├── index.ts                    # registerChannel + registerTool + registerService + registerHttpRoute
└── src/
    ├── channel.ts              # ChannelPlugin "xiaozhi" (routing risposte all'agente)
    ├── bridge.ts               # WebSocket bridge (gestisce connessioni device)
    ├── protocol.ts             # Parser protocollo XiaoZhi (JSON + Opus binary)
    ├── ota.ts                  # Handler HTTP /xiaozhi/ota/
    ├── audio-pipeline.ts       # Opus→Whisper→agente→TTS→Opus
    └── tools.ts                # Tool agente: laragoci.speak, .emoji, .volume
```

**API plugin utilizzate:**

| API                                          | Uso                                                |
| -------------------------------------------- | -------------------------------------------------- |
| `registerHttpRoute("/xiaozhi/ota/")`         | Endpoint OTA (il firmware chiede dove connettersi) |
| `registerChannel({ plugin: xiaozhiPlugin })` | Canale "xiaozhi" per routing messaggi              |
| `registerTool("laragoci.speak", ...)`        | Tool MCP per l'agente (livello 3)                  |
| `registerTool("laragoci.emoji", ...)`        | Tool MCP per emoji display                         |
| `registerService("xiaozhi-bridge")`          | Servizio background bridge WebSocket               |
| `registerGatewayMethod("xiaozhi.status")`    | Metodi RPC per controllo device                    |

**Modello di riferimento:** L'estensione `voice-call/` fa la stessa cosa
(audio streaming WS → STT → agente → TTS → audio) ma con Twilio/Telnyx.

**Come il bridge si innesta nell'agent loop:**

```
1. ESP32 invia audio Opus via WebSocket
2. Bridge decodifica Opus → Whisper API → testo
3. Bridge chiama agentCommand({
     message: testo,
     sessionKey: "main",           ← SESSIONE MAIN (stesso contesto di WhatsApp)
     messageChannel: "xiaozhi",    ← identifica la sorgente (per rispondere via audio)
   })
4. Agente processa (Claude + tools + memoria + Calendar...)
5. Agente genera risposta
6. Bridge intercetta → TTS → Opus encode → invia al device
7. Bridge invia anche {"type":"llm","emotion":"happy"} per emoji
```

**Sessione: il device usa la sessione MAIN**

LaraGoci e' il corpo dell'agente. Quando Francesco parla al device, e' la stessa
conversazione di quando scrive su WhatsApp. Un agente, una memoria, piu' interfacce.

| Sorgente            | Session key           | Risposta via              |
| ------------------- | --------------------- | ------------------------- |
| WhatsApp DM         | `main`                | WhatsApp testo            |
| Browser dashboard   | `main`                | Browser testo             |
| **Device LaraGoci** | **`main`**            | **Device audio + emoji**  |
| Gruppo WhatsApp     | `whatsapp:group:<id>` | WhatsApp gruppo           |
| Heartbeat/Cron      | `isolated`            | Dipende (device/WhatsApp) |

Il `messageChannel: "xiaozhi"` dice all'agente DA DOVE arriva il messaggio,
cosi' risponde con il mezzo giusto (audio sul device, non testo su WhatsApp).
Ma il contesto conversazionale, la memoria e i tool sono gli stessi.

### Stima lavoro: ~10-14 giorni

| Componente                                 | Complessita' | Stima      |
| ------------------------------------------ | ------------ | ---------- |
| Setup build from source + dev environment  | Bassa        | 0.5 giorni |
| Patch WS upgrade handler (1 modifica core) | Bassa        | 0.5 giorni |
| Extension scaffold + plugin manifest       | Bassa        | 0.5 giorni |
| WebSocket bridge + protocollo XiaoZhi      | Media        | 2-3 giorni |
| Opus decode/encode (@discordjs/opus)       | Media        | 1 giorno   |
| VAD (WebRTC VAD o Silero)                  | Media        | 1-2 giorni |
| Audio pipeline (Whisper + TTS + Opus)      | Media        | 2 giorni   |
| Integrazione agentCommand() + channel      | Media-Alta   | 2-3 giorni |
| Tool MCP (speak, emoji, volume, status)    | Media        | 1 giorno   |
| Endpoint OTA HTTP                          | Bassa        | 0.5 giorni |
| Testing end-to-end                         | Media        | 2-3 giorni |

---

## Protocollo XiaoZhi (tradotto dal cinese)

> Fonte originale: https://my.feishu.cn/wiki/M0XiwldO9iJwHikpXD5cEx71nKh
> Specifica WebSocket: https://github.com/78/xiaozhi-esp32/blob/main/docs/websocket.md
> Protocollo MCP: https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-protocol.md

### Connessione WebSocket

**URL:** `wss://laragoci.lara-ai.eu/xiaozhi/v1/` (da configurare)
**Configurabile:** Si, via NVS, Kconfig (`CONFIG_WEBSOCKET_URL`), o risposta OTA

**Header HTTP della connessione:**

| Header             | Descrizione         | Valore                                               |
| ------------------ | ------------------- | ---------------------------------------------------- |
| `Authorization`    | Token di accesso    | `Bearer <token>`                                     |
| `Protocol-Version` | Versione protocollo | `3`                                                  |
| `Device-Id`        | MAC address         | MAC della scheda di rete                             |
| `Client-Id`        | UUID software       | UUID generato dal firmware, si resetta con NVS erase |

### Handshake

**1. Device invia `hello`:**

```json
{
  "type": "hello",
  "version": 3,
  "features": { "mcp": true },
  "transport": "websocket",
  "audio_params": {
    "format": "opus",
    "sample_rate": 16000,
    "channels": 1,
    "frame_duration": 60
  }
}
```

**2. Server risponde `hello`:**

```json
{
  "type": "hello",
  "transport": "websocket",
  "session_id": "abc123",
  "audio_params": {
    "format": "opus",
    "sample_rate": 24000,
    "channels": 1,
    "frame_duration": 60
  }
}
```

**Timeout:** 10 secondi per risposta hello, altrimenti errore di rete.
**Verifica:** Il device controlla che `transport` sia `"websocket"`.

### Messaggi JSON: Device → Server

**`listen` — Stato ascolto:**

```json
{
  "session_id": "xxx",
  "type": "listen",
  "state": "start", // "start" | "stop" | "detect"
  "mode": "auto" // "auto" | "manual" | "realtime"
}
```

- `start`: Inizia registrazione + invio frame Opus dal microfono
- `stop`: Fine registrazione
- `detect`: Wake word rilevata (include `"text": "parola_sveglia"`)

**`abort` — Interruzione:**

```json
{
  "session_id": "xxx",
  "type": "abort",
  "reason": "wake_word_detected"
}
```

Interrompe TTS corrente. Device torna a Idle o Listening.

**`mcp` — Controllo IoT (JSON-RPC 2.0):**

```json
{
  "session_id": "xxx",
  "type": "mcp",
  "payload": {
    "jsonrpc": "2.0",
    "id": 1,
    "result": { "content": [{ "type": "text", "text": "true" }], "isError": false }
  }
}
```

### Messaggi JSON: Server → Device

**`stt` — Risultato speech-to-text:**

```json
{ "session_id": "xxx", "type": "stt", "text": "Testo riconosciuto" }
```

**`llm` — Emozione/espressione (controlla display emoji):**

```json
{ "session_id": "xxx", "type": "llm", "emotion": "happy", "text": "😀" }
```

**`tts` — Controllo sintesi vocale:**

```json
{"session_id": "xxx", "type": "tts", "state": "start"}
{"session_id": "xxx", "type": "tts", "state": "sentence_start", "text": "Frase corrente"}
{"session_id": "xxx", "type": "tts", "state": "stop"}
```

Tra `start` e `stop`, il server invia frame binari Opus.

**`mcp` — Comandi IoT verso device:**

```json
{
  "session_id": "xxx",
  "type": "mcp",
  "payload": {
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": { "name": "self.audio_speaker.set_volume", "arguments": { "volume": 50 } },
    "id": 1
  }
}
```

**`system` — Comandi di sistema:**

```json
{ "session_id": "xxx", "type": "system", "command": "reboot" }
```

### Audio Binario (Frame WebSocket)

Stessa connessione WebSocket, frame binari separati dai JSON testuali.

**Versione 1 (default):** Frame Opus raw, nessun header.

**Versione 3 (consigliata, header 4 byte):**

```c
struct BinaryProtocol3 {
    uint8_t  type;           // 0=OPUS, 1=JSON
    uint8_t  reserved;
    uint16_t payload_size;   // big-endian
    uint8_t  payload[];
} __attribute__((packed));
```

### Parametri Audio

| Parametro           | Upload (device→server) | Download (server→device) |
| ------------------- | ---------------------- | ------------------------ |
| **Codec**           | Opus                   | Opus                     |
| **Sample rate**     | 16000 Hz               | 24000 Hz                 |
| **Canali**          | 1 (mono)               | 1 (mono)                 |
| **Frame duration**  | 60 ms                  | 60 ms                    |
| **Bitrate encode**  | Determinato da encoder | 24 kbps                  |
| **Opus complexity** | —                      | 10 (massima qualita')    |

### Macchina a Stati del Device

```
Unknown → Starting → WifiConfiguring → Activating → Idle
                                                      ↕
                                              Connecting → Listening ↔ Speaking
                                                      ↕
                                                  Upgrading
```

**Modalita' auto:** Dopo TTS stop → torna a Listening (loop continuo)
**Modalita' manual:** Dopo TTS stop → torna a Idle
**Timeout inattivita':** 120 secondi (configurabile)

### Flusso Conversazione Completo

```
DEVICE                                     SERVER (OpenClaw bridge)
  |                                            |
  |--- WebSocket Connect (headers) ---------->|
  |--- {"type":"hello",...} ----------------->|
  |<-- {"type":"hello","session_id":"..."} ---|
  |                                            |
  |--- {"type":"listen","state":"start"} ---->|
  |--- [Frame Opus 60ms] ------------------->|  ← mic audio
  |--- [Frame Opus 60ms] ------------------->|
  |--- [Frame Opus 60ms] ------------------->|
  |                                            |  (VAD rileva fine voce)
  |                                            |  (Opus→PCM→Whisper→testo)
  |<-- {"type":"stt","text":"..."} -----------|
  |                                            |  (Claude LLM processa)
  |<-- {"type":"llm","emotion":"happy"} ------|  ← emoji sul display
  |<-- {"type":"tts","state":"start"} --------|
  |<-- {"type":"tts","state":"sentence_start",|
  |     "text":"Frase..."} -------------------|  ← testo sul display
  |<-- [Frame Opus 60ms] --------------------|  ← audio TTS
  |<-- [Frame Opus 60ms] --------------------|
  |<-- {"type":"tts","state":"stop"} ---------|
  |                                            |
  |   [Auto: torna a Listening]               |
  |--- {"type":"abort"} -------------------->|  ← utente interrompe
  |<-- {"type":"tts","state":"stop"} ---------|
```

### Protocollo MCP su Device (IoT)

Il device espone tool MCP via JSON-RPC 2.0 incapsulati nel messaggio `type: "mcp"`.

**Inizializzazione:** Server invia `initialize` → device risponde con `capabilities` e `serverInfo`
**Scoperta tool:** Server invia `tools/list` → device risponde con lista tool registrati
**Invocazione:** Server invia `tools/call` → device esegue e risponde con risultato

**Tool registrabili nel firmware (C++):**

```cpp
mcp_server.AddTool("self.audio_speaker.set_volume", "Set speaker volume",
    PropertyList({{"volume", PropertyType::INT, 0, 100}}),
    [](const PropertyList& args) -> ReturnValue { /* ... */ return true; });
```

**Naming convention:** `self.namespace.action` (es. `self.light.set_rgb`, `self.chassis.go_forward`)

### Endpoint OTA (prerequisito)

Il firmware fa `POST /xiaozhi/ota/` al primo avvio per ottenere la config WebSocket.

**Request headers:** `Device-Id`, `Client-Id`, `Activation-Version`, `User-Agent`

**Response minima necessaria:**

```json
{
  "server_time": { "timestamp": 1234567890, "timezone_offset": "+1" },
  "websocket": {
    "url": "wss://laragoci.lara-ai.eu/xiaozhi/v1/",
    "token": "hmac-signature.timestamp"
  }
}
```

**Auth token:** HMAC-SHA256 con formato `"{signature}.{timestamp}"`
**Signature:** `HMAC-SHA256(secret, "{client_id}|{username}|{timestamp}")`
**Scadenza:** 30 giorni

### Come Cambiare il Server (3 modi)

1. **Compile-time:** Cambiare `CONFIG_OTA_URL` nel Kconfig (menuconfig)
2. **Runtime NVS:** Scrivere `websocket_url` e `websocket_token` nelle settings NVS
3. **Risposta OTA:** Il server OTA indica al device quale WebSocket usare

**Il firmware NON richiede modifiche al codice sorgente** — solo riconfigurazione dell'URL OTA.

---

## Modello Acquistato: ESP32-S3-BOX-3

- **Hardware overview:** https://github.com/espressif/esp-box/blob/master/docs/hardware_overview/esp32_s3_box_3/hardware_overview_for_box_3.md
- **Getting started:** https://github.com/espressif/esp-box/blob/master/docs/getting_started.md#continuous-speech-recognition
- **Esempi di codice:** https://github.com/espressif/esp-box/tree/master/examples

### Specifiche tecniche chiave

| Componente      | Spec                                                        |
| --------------- | ----------------------------------------------------------- |
| **SoC**         | ESP32-S3 dual-core 240MHz, 512KB SRAM                       |
| **Flash**       | 16 MB Quad Flash                                            |
| **PSRAM**       | 16 MB Octal PSRAM                                           |
| **Mic ADC**     | ES7210 via I2S (GPIO16), 2 microfoni digitali, 16-bit 16kHz |
| **Speaker DAC** | ES8311 via I2S (GPIO15), 16-bit 48kHz                       |
| **I2S Bus**     | LRCLK GPIO45, BCLK GPIO17, MCLK GPIO2                       |
| **Display**     | 2.4" LCD SPI ILI9xxx, 320x240, touchscreen                  |
| **Display SPI** | CLK GPIO7, MOSI GPIO6, CS GPIO5, DC GPIO4, backlight GPIO47 |
| **WiFi**        | 802.11 b/g/n 2.4GHz                                         |
| **Bluetooth**   | 5.0 LE + A2DP (audio classico)                              |
| **USB**         | Type-C (alimentazione + debug + download)                   |
| **Sensori**     | Giroscopio 3 assi, accelerometro 3 assi                     |
| **Espansione**  | Connettore PCIe, 16 GPIO, 3 pulsanti                        |

### Versione V1: solo main board (WiFi)

Prima versione: funzionalita' base parla/ascolta/emoji. Niente 4G, niente batteria esterna.

---

## Firmware XiaoZhi: Struttura Interna

### Architettura (~94 board supportate, C++ su ESP-IDF v5.4+)

```
main/
├── application.cc        # Singleton, event loop (FreeRTOS Event Groups, 13 bit flags)
├── device_state_machine  # FSM con 11 stati e transizioni validate
├── ota.cc                # OTA updates + attivazione + config server
├── mcp_server.cc         # Model Context Protocol IoT
├── protocols/
│   ├── websocket_protocol.cc  # Implementazione WebSocket
│   └── mqtt_protocol.cc       # Alternativa MQTT+UDP
├── audio/
│   ├── audio_service.cc  # 3 task FreeRTOS per pipeline audio
│   ├── codecs/box_audio_codec.cc  # Codec ES7210+ES8311 per BOX-3
│   ├── processors/afe_audio_processor.cc  # Noise reduction, AEC
│   └── wake_words/esp_wake_word.cc  # Wake word on-device (ESP-SR)
├── display/
│   ├── lcd_display.cc    # Display LCD (SPI)
│   ├── lvgl_display/     # Framework LVGL + emoji
│   └── emoji_collection  # Asset GIF/JPG per emoji
└── boards/               # ~94 board + HAL comune
```

### Wake Word: completamente on-device (ESP-SR)

- 3 implementazioni: ESP Wakenet, AFE-enhanced, Custom multi-net
- Sensibilita' configurabile (1-99%)
- Wake word personalizzabili via Kconfig
- L'audio del wake word viene encodato Opus e inviato al server

### Display e Emoji

- Framework **LVGL** con temi switchabili
- Emoji renderizzate come **font UTF-8** o **immagini PNG/GIF**
- Il server controlla le emoji con `{"type":"llm","emotion":"happy"}`
- 31+ lingue supportate (incluso **italiano**)
- Chat UI: stile WeChat con bolle oppure testo scrollabile

### Come il firmware ottiene l'URL del server

```cpp
// websocket_protocol.cc - OpenAudioChannel()
std::string url = settings.GetString("websocket_url");   // Da NVS (via risposta OTA)
std::string token = settings.GetString("websocket_token");
```

L'URL **non e' hardcoded** — viene dalla risposta OTA e salvato in NVS.

---

## Architettura Completa

```
ESP32-S3-BOX-3 (firmware XiaoZhi)
    │
    ├── Mic (I2S ES7210) → Opus 16kHz mono 60ms
    ├── Speaker (I2S ES8311) ← Opus 24kHz mono 60ms
    ├── Display LCD (LVGL) ← Emoji/testo via JSON
    ├── Wake word (ESP-SR, on-device, offline)
    │
    └── WiFi/4G ──WSS──> OpenClaw XiaoZhi Bridge (Node.js)
                              │
                              ├── Opus decode → PCM → Whisper STT
                              ├── Testo → Agent Session (Claude + tools + memoria)
                              ├── Risposta → OpenAI TTS → PCM → Opus encode
                              ├── Emoji → JSON {"type":"llm","emotion":"happy"}
                              │
                              └── OpenClaw Agent Loop
                                    ├── Google Workspace (Calendar/Gmail/Drive)
                                    ├── WhatsApp / VoIP
                                    ├── Brave Search
                                    ├── Memoria (MEMORY.md + memory/*.md)
                                    ├── Personalita' (SOUL.md + IDENTITY.md)
                                    └── MCP Server LaraGoci (tool per controllare device)
```

### Bridge Node.js: Componenti necessari

| Componente         | Libreria npm suggerita                          |
| ------------------ | ----------------------------------------------- |
| WebSocket server   | `ws`                                            |
| Opus decode/encode | `@discordjs/opus` o `opusscript`                |
| VAD                | `node-vad` (WebRTC VAD) o Silero via subprocess |
| Audio conversion   | `ffmpeg` se necessario                          |
| ASR                | OpenAI Whisper API (gia' in OpenClaw)           |
| LLM                | Claude API (gia' modello primario)              |
| TTS                | OpenAI TTS Nova (gia' configurato)              |

---

## Protocollo WebSocket OpenClaw (dall'app Android)

> Riferimento: https://github.com/openclaw/openclaw/tree/main/apps/android

**Nota:** Il protocollo OpenClaw nativo e' diverso da quello XiaoZhi. Il bridge traduce tra i due.
In futuro si potrebbe valutare di far parlare il firmware direttamente il protocollo OpenClaw
(richiederebbe modifiche al firmware XiaoZhi).

### Struttura frame OpenClaw

```json
{"type": "req", "id": "uuid", "method": "nome.metodo", "params": {...}}
{"type": "res", "id": "uuid", "ok": true, "payload": {...}}
{"type": "event", "event": "nome.evento", "payload": {...}, "seq": 42}
```

### Auth OpenClaw: Ed25519

- Coppia chiavi Ed25519, `deviceId` = SHA-256 della public key
- Firma: `"v2|deviceId|clientId|mode|role|scopes|timestampMs|token|nonce"`
- Pairing via `openclaw devices approve`

### Confronto protocolli

| Aspetto       | XiaoZhi                  | OpenClaw                                        |
| ------------- | ------------------------ | ----------------------------------------------- |
| **Auth**      | Bearer token HMAC-SHA256 | Ed25519 challenge-response                      |
| **Handshake** | hello/hello              | challenge/connect/helloOk                       |
| **Audio**     | Opus binary frames       | Non implementato (Android usa SpeechRecognizer) |
| **Messaggi**  | 7 tipi JSON fissi        | Frame req/res/event generici                    |
| **Display**   | JSON emotion/chat        | Node invoke commands                            |
| **IoT/MCP**   | JSON-RPC 2.0 incapsulato | Node invoke + capabilities                      |

**Decisione:** Per V1, il bridge parla **protocollo XiaoZhi** verso il device (zero modifiche firmware)
e **traduce internamente** per l'agent loop OpenClaw.

---

## MCP Server LaraGoci (da sviluppare)

OpenClaw deve avere un MCP server dedicato per controllare LaraGoci come suo corpo.

### Tool MCP previsti

| Tool                         | Descrizione                                | Tipo          |
| ---------------------------- | ------------------------------------------ | ------------- |
| `laragoci.listen`            | Attiva ascolto e ritorna trascrizione      | Audio input   |
| `laragoci.speak`             | Invia testo da pronunciare via TTS         | Audio output  |
| `laragoci.play`              | Riproduci file audio/URL sullo speaker     | Audio output  |
| `laragoci.emoji`             | Mostra emoji/immagine sul display LCD      | Display       |
| `laragoci.text`              | Mostra testo sul display LCD               | Display       |
| `laragoci.status`            | Ritorna stato device (batteria, WiFi, GPS) | Sensori       |
| `laragoci.bluetooth.pair`    | Avvia pairing Bluetooth                    | Connettivita' |
| `laragoci.bluetooth.connect` | Connetti a device gia' paired              | Connettivita' |

---

## Esempi ESP-BOX Rilevanti

| Esempio          | Descrizione                                    | Rilevanza      |
| ---------------- | ---------------------------------------------- | -------------- |
| **chatgpt_demo** | Assistente vocale con OpenAI/ChatGPT via cloud | **MOLTO ALTA** |
| **factory_demo** | Demo fabbrica: LVGL + ESP-SR + Rainmaker       | **MOLTO ALTA** |
| **mp3_demo**     | Riproduzione audio MP3                         | Media          |

---

## Ambiente di Sviluppo

### Valutazione completa

| Approccio            | Adatto?          | Perche'                                      |
| -------------------- | ---------------- | -------------------------------------------- |
| **XiaoZhi firmware** | **SI' (scelto)** | Pronto per BOX-3, protocollo semplice, MIT   |
| **ESP-IDF nativo**   | Backup           | Controllo totale ma 2-4 settimane in piu'    |
| **ESPHome**          | **NO**           | No WebSocket client, legato a Home Assistant |
| **Arduino puro**     | **NO**           | Manca supporto audio BOX-3                   |

**ESP-IDF:** https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/index.html
**Versione richiesta:** >= v5.3, stabile: v5.5.3

---

## Infrastruttura

### Server (Hetzner VPS)

- **IP:** 77.42.93.2
- **OpenClaw:** v2026.2.26
- **Gateway:** porta 18789, `ws://127.0.0.1:18789`

### SSL/TLS ✅

- **Dominio:** `lara-ai.eu` — **Endpoint:** `laragoci.lara-ai.eu`
- **Soluzione:** Cloudflare Tunnel (`cloudflared`) — zero porte in ingresso, SSL gestito da Cloudflare
- **Tunnel:** `de42f123-16bd-410c-83ee-e26094793a7a`, 4 connessioni su edge Frankfurt
- **Servizio:** `cloudflared.service` (systemd, enabled, auto-restart)
- **Ingress:** `laragoci.lara-ai.eu` → `http://127.0.0.1:18789`
- **Verificato:** `curl https://laragoci.lara-ai.eu/xiaozhi/ota/` → `{"url":"wss://laragoci.lara-ai.eu/xiaozhi/v1/","token":""}` ✅
- **Status:** **COMPLETATO** ✅ 2026-03-15

### Integrazioni attive

- **AI:** Claude Sonnet 4 + Haiku 4.5 fallback
- **STT:** OpenAI Whisper API
- **TTS:** OpenAI Nova
- **Google:** Gmail, Calendar, Drive, Docs, Sheets, Places, Routes
- **WhatsApp, Brave Search, Microsoft 365 su lara-ai.eu**

---

## Business Model

| Voce             | Costo/mese  |
| ---------------- | ----------- |
| VM OpenClaw      | €5-10       |
| Google Workspace | €6          |
| AI API           | €10-50      |
| VoIP + WhatsApp  | €3-12       |
| SIM 4G IoT       | €3-10       |
| **Totale**       | **€30-110** |

**Hardware:** €85-113 (prototipo), €80-120 (produzione)
**Pricing consumer:** €200-400 device + €50-100/mese
**Opportunita' Stack EU:** Galene.AI (https://galene.ai/) — GDPR, AI Act compliant

### Licenze: Stack 100% vendibile commercialmente

| Componente           | Licenza    | Uso commerciale                           |
| -------------------- | ---------- | ----------------------------------------- |
| **OpenClaw**         | **MIT**    | SI' — fork, modifica, rivendi liberamente |
| **XiaoZhi firmware** | **MIT**    | SI' — stesso                              |
| **ESP-IDF**          | Apache 2.0 | SI'                                       |
| **LVGL**             | MIT        | SI'                                       |
| **Opus codec**       | BSD        | SI'                                       |

**Nessun copyleft, nessuna royalty, nessun permesso richiesto.**
Unico obbligo: includere le notice delle licenze (file NOTICES nel prodotto).
Le modifiche possono restare **proprietarie** (closed source).
Il costo reale sono le API AI (Claude, Whisper, TTS) — incluse nell'abbonamento utente.

### Strategia go-to-market

- **Beta:** 50 utenti a €19/mese (sconto 60%) + device a prezzo di costo
- **Lancio:** Prezzo pieno €50-100/mese + device €200-400
- **Validazione:** 50-100 utenti paganti = product-market fit per funding
- **Funding EU:** EIC Accelerator (fino a €2.5M grant + €15M equity), CDP Venture Capital

---

## Roadmap

### FASE 1: Prototipo (WiFi only) — 2-3 settimane

| #    | Task                                                            | Status                                           |
| ---- | --------------------------------------------------------------- | ------------------------------------------------ |
| 1.0  | ~~Decidere approccio~~ → **XiaoZhi firmware + OpenClaw bridge** | **DECISO**                                       |
| 1.1  | SSL/TLS su laragoci.lara-ai.eu                                  | **COMPLETATO** ✅ 2026-03-15 — Cloudflare Tunnel |
| 1.2  | Clone + build OpenClaw da sorgente (VM dedicata)                | **COMPLETATO** ✅ — v2026.2.26, build OK         |
| 1.3  | Flash firmware XiaoZhi sulla BOX-3                              | TODO                                             |
| 1.4  | Test audio con server XiaoZhi Docker (validazione hardware)     | TODO                                             |
| 1.5  | Creare estensione `extensions/xiaozhi/` (scaffold + manifest)   | TODO                                             |
| 1.6  | Patch WS upgrade handler per path `/xiaozhi/v1/`                | TODO                                             |
| 1.7  | Implementare bridge WebSocket (protocollo XiaoZhi)              | TODO                                             |
| 1.8  | Audio pipeline: Opus→Whisper→agentCommand→TTS→Opus              | TODO                                             |
| 1.9  | Emoji display via JSON emotion                                  | TODO                                             |
| 1.10 | Tool MCP agente (laragoci.speak, .emoji, .volume)               | TODO                                             |
| 1.11 | Endpoint OTA HTTP (`/xiaozhi/ota/`)                             | TODO                                             |

### FASE 2: Integrazione completa — 2-3 settimane

| #   | Task                                      | Status |
| --- | ----------------------------------------- | ------ |
| 2.1 | MCP tools su device (volume, status, etc) | TODO   |
| 2.2 | Bluetooth A2DP (pairing vocale)           | TODO   |
| 2.3 | Power management (deep sleep + wake word) | TODO   |
| 2.4 | Modulo 4G SIM7600G-H                      | TODO   |
| 2.5 | GPS via SIM7600G-H                        | TODO   |
| 2.6 | OTA updates firmware                      | TODO   |

### FASE 3: Prodotto — 1-2 mesi

| #   | Task                          | Status |
| --- | ----------------------------- | ------ |
| 3.1 | PCB custom design             | TODO   |
| 3.2 | Case AirPods-like (stampa 3D) | TODO   |
| 3.3 | Multi-utente: 1 device = 1 VM | TODO   |
| 3.4 | Go-to-market                  | TODO   |

---

## Stato avanzamento

### Completato

- [x] Concept e vision
- [x] Hardware acquistato (ESP32-S3-BOX-3)
- [x] Documentazione progetto (Google Drive)
- [x] Business model
- [x] Dominio lara-ai.eu + email Microsoft 365
- [x] DNS (laragoci.lara-ai.eu → Cloudflare Tunnel CNAME, 2026-03-15)
- [x] SSL/TLS via Cloudflare Tunnel — OTA endpoint verificato ✅
- [x] Claude Sonnet 4 + Whisper + TTS
- [x] Google Workspace + WhatsApp
- [x] Ricerca ESPHome (scartato)
- [x] Ricerca protocollo OpenClaw Android
- [x] **Scoperta e analisi XiaoZhi (firmware + protocollo + server)**
- [x] **Traduzione completa protocollo XiaoZhi dal cinese**
- [x] **Decisione: XiaoZhi firmware + OpenClaw bridge**

### In corso

- [ ] SSL/TLS Let's Encrypt wildcard
- [x] Clone + build OpenClaw da sorgente su VM dedicata (`ubuntu-8gb-hel1-1`, v2026.2.26 build OK)

### Da fare

- [ ] Flash firmware XiaoZhi sulla BOX-3
- [ ] Test hardware con server XiaoZhi Docker
- [ ] Creare estensione `extensions/xiaozhi/` (modello: voice-call)
- [ ] Patch WS upgrade handler (`server-http.ts`, 1 modifica)
- [ ] Bridge WebSocket (protocollo XiaoZhi)
- [ ] Audio pipeline (Opus→Whisper→agentCommand→TTS→Opus)
- [ ] Tool MCP agente (speak, emoji, volume, status)
- [ ] Endpoint OTA HTTP
- [ ] Knowledge layer (GraphDB skill)

---

## Decisioni architetturali

| #   | Decisione                          | Data       | Motivazione                                       |
| --- | ---------------------------------- | ---------- | ------------------------------------------------- |
| 1   | "Stupid device, smart cloud"       | 2026-02-08 | Riduce complessita' firmware                      |
| 2   | ESP32-S3-BOX-3                     | 2026-02-14 | Audio+display integrati                           |
| 3   | REST API > CGI                     | 2026-02-19 | Leggero, stateless                                |
| 4   | SSL via lara-ai.eu                 | 2026-02-16 | Dominio esistente, Let's Encrypt gratis           |
| 5   | Device first, knowledge parallel   | 2026-02-12 | Device vendibile                                  |
| 6   | Push-to-talk + wake word           | 2026-02-08 | Risparmio batteria                                |
| 7   | ESPHome scartato                   | 2026-02-19 | No WebSocket client                               |
| 8   | Nodo OpenClaw                      | 2026-02-19 | Come app Android                                  |
| 9   | XiaoZhi firmware + OpenClaw bridge | 2026-02-19 | Firmware pronto, protocollo semplice              |
| 10  | NON usare backend XiaoZhi          | 2026-02-19 | Bypassa OpenClaw, perde agent/memoria/tools       |
| 11  | Build OpenClaw from source         | 2026-02-19 | Permette di creare estensione xiaozhi nel gateway |
| 12  | Estensione `extensions/xiaozhi/`   | 2026-02-19 | Modello voice-call, 1 sola patch al core          |

---

## FAQ XiaoZhi (da docs server)

> Fonte: https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/main/docs/FAQ.md

| Problema                               | Soluzione                                                       |
| -------------------------------------- | --------------------------------------------------------------- |
| Riconosce caratteri coreani/giapponesi | Scaricare modello `SenseVoiceSmall/model.pt`                    |
| TTS error "file not found"             | Installare `libopus` e `ffmpeg` via conda                       |
| TTS timeout frequenti                  | Disabilitare proxy; EdgeTTS gratuito ha limiti                  |
| WiFi ok ma 4G non connette             | **SSL obbligatorio per 4G** — configurare certificati           |
| Risposta lenta                         | Usare ASR streaming (XunfeiStreamASR) + LLM veloce (qwen-flash) |
| Interrompe durante pause               | Aumentare `min_silence_duration_ms` VAD (es. 1000ms)            |

---

## Librerie necessarie

### Bridge Node.js (OpenClaw)

| Funzionalita'     | Libreria                  |
| ----------------- | ------------------------- |
| WebSocket server  | `ws`                      |
| Opus codec        | `@discordjs/opus`         |
| VAD               | `node-vad` o `silero-vad` |
| HTTP server (OTA) | Express o built-in        |

### Firmware (gia' incluse in XiaoZhi/ESP-IDF)

| Funzionalita' | Libreria               |
| ------------- | ---------------------- |
| WebSocket     | `esp_websocket_client` |
| JSON          | `cJSON`                |
| Audio I2S     | `driver/i2s`           |
| Display       | `esp_lcd` + LVGL       |
| Opus          | `libopus`              |
| Wake word     | ESP-SR (Wakenet)       |
| NVS storage   | `nvs_flash`            |
| BSP BOX-3     | `espressif/esp-box-3`  |

---

## Rischi

| Rischio                 | Impatto | Mitigazione                               |
| ----------------------- | ------- | ----------------------------------------- |
| Latency audio           | Alto    | Opus codec, server EU, pre-buffer 5 frame |
| Battery drain ascolto   | Alto    | Wake word on-device, deep sleep           |
| RAM ESP32 (512KB)       | Medio   | Buffer circolari, streaming parser        |
| AI API costs            | Alto    | Budget cap, modelli fallback              |
| BLE + Audio conflitti   | Medio   | Non usare BLE durante streaming           |
| SSL obbligatorio per 4G | Alto    | Let's Encrypt su lara-ai.eu (in corso)    |

---

## Link e Riferimenti

### Progetto

- [plans/2026-02-16-laragoci-project.md](plans/2026-02-16-laragoci-project.md)
- [plans/2026-02-16-ssl-setup.md](plans/2026-02-16-ssl-setup.md)
- [ROADMAP.md](ROADMAP.md)
- Google Drive `/laragoci/` — project-brief, updated, compact

### Hardware

- **BOX-3 hardware:** https://github.com/espressif/esp-box/blob/master/docs/hardware_overview/esp32_s3_box_3/hardware_overview_for_box_3.md
- **Getting started:** https://github.com/espressif/esp-box/blob/master/docs/getting_started.md#continuous-speech-recognition
- **Esempi:** https://github.com/espressif/esp-box/tree/master/examples
- **ESP-BOX repo:** https://github.com/espressif/esp-box
- **ESP-IDF:** https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/index.html
- **BSP component:** https://components.espressif.com/components/espressif/esp-box-3

### XiaoZhi

- **Firmware:** https://github.com/78/xiaozhi-esp32
- **Server:** https://github.com/xinnan-tech/xiaozhi-esp32-server
- **Server docs:** https://github.com/xinnan-tech/xiaozhi-esp32-server/tree/main/docs
- **Server FAQ:** https://github.com/xinnan-tech/xiaozhi-esp32-server/blob/main/docs/FAQ.md
- **Protocollo WS:** https://github.com/78/xiaozhi-esp32/blob/main/docs/websocket.md
- **Protocollo MCP:** https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-protocol.md
- **Dev portal:** https://xiaozhi.dev/en/docs/development/
- **Architettura DeepWiki:** https://deepwiki.com/xinnan-tech/xiaozhi-esp32-server
- **Protocollo (cinese):** https://my.feishu.cn/wiki/M0XiwldO9iJwHikpXD5cEx71nKh
- **Server C++ alternativo:** https://github.com/daxpot/xiaozhi-cpp-server

### OpenClaw

- **App Android:** https://github.com/openclaw/openclaw/tree/main/apps/android
- **Docs locali:** `~/.local/share/pnpm/global/5/.pnpm/openclaw@2026.2.2-3_*/node_modules/openclaw/docs/`
- **Config:** `~/.openclaw/openclaw.json`
- **Workspace:** `~/.openclaw/workspace/`

### Servizi

- **ESPHome (scartato):** https://esphome.io/
- **Let's Encrypt:** https://letsencrypt.org/
- **Galene.AI:** https://galene.ai/
- **Home Assistant:** https://www.home-assistant.io/
- **OwnTracks:** https://owntracks.org/
- **DNS:** https://www.register.it

### Memorie agente

- `~/.openclaw/workspace/memory/2026-02-08.md` — Nascita concept
- `~/.openclaw/workspace/memory/2026-02-09.md` — Galene.AI, Bluetooth
- `~/.openclaw/workspace/memory/2026-02-12.md` — Ontologia, device-first
- `~/.openclaw/workspace/memory/2026-02-14.md` — Selezione BOX-3
- `~/.openclaw/workspace/memory/2026-02-16.md` — SSL, business
- `~/.openclaw/workspace/memory/2026-02-19.md` — REST vs CGI, architettura

---

## Note per Claude

### Quando pianifichi lavoro su LaraGoci

1. Leggi sempre questo file come punto di partenza
2. Il firmware e' **XiaoZhi** — parla il **protocollo XiaoZhi** (non OpenClaw nativo)
3. Il bridge traduce protocollo XiaoZhi ↔ agent loop OpenClaw
4. ESPHome e' **scartato**
5. Il backend XiaoZhi (Python/Java/Vue) **NON va usato** — OpenClaw lo sostituisce
6. L'audio pipeline e il bridge WebSocket **non esistono ancora** — sono da creare
7. Il MCP Server LaraGoci **non esiste ancora** — e' da creare

### Quando fai deep search

- **Protocollo XiaoZhi:** docs/websocket.md nel repo firmware, Feishu wiki
- **Firmware:** xiaozhi-esp32 repo, struttura main/, boards/
- **Audio:** Opus encode/decode Node.js, WebSocket binary frames
- **Display emoji:** LVGL, messaggio JSON `type: "llm"` con `emotion`
- **VAD:** Silero VAD, WebRTC VAD, dual-threshold con isteresi

### Priorita' operative

1. **SSL/TLS setup** — Prerequisito (anche FAQ XiaoZhi conferma: SSL obbligatorio per 4G)
2. **Flash firmware XiaoZhi** sulla BOX-3 + test con server Docker (validazione hardware)
3. **Bridge Node.js** — Endpoint OTA + WebSocket XiaoZhi protocol + audio pipeline
4. **MCP Server LaraGoci** — Tool per controllare il device dall'agente

### Roadmap operativa per task

Vedi **[road_map_laragoci.md](road_map_laragoci.md)** — task dettagliati con dipendenze, file da creare/modificare, parametri tecnici.
