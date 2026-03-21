# Roadmap LaraGoci — Task per Claude

> Roadmap sintetica e operativa. Per dettagli tecnici, protocollo e architettura vedi [laragoci.md](laragoci.md)
> **Data:** 2026-02-19 — **Ultimo aggiornamento:** 2026-03-20 (analisi serial monitor, bug fix identificati, decisioni wake word)

> **⏭ Prossimo step: Fase 2 — fix bug B1-B4 poi audio pipeline (2.1 → 2.7)**
> Piano dettagliato: [plans/02_Audio_pipeline.md](plans/02_Audio_pipeline.md)

---

## Contesto in 30 secondi

- **LaraGoci** = ESP32-S3-BOX-3 con firmware XiaoZhi (mic, speaker, display, wake word)
- **Obiettivo** = OpenClaw usa il device come suo corpo (ascolta, parla, emoji)
- **Come** = Estensione `extensions/xiaozhi/` nel gateway OpenClaw (build from source)
- **Protocollo** = Il firmware parla protocollo XiaoZhi (7 msg JSON + Opus binary via WSS)
- **Sessione** = Il device usa la sessione `main` (stesso contesto di WhatsApp/browser)
- **Modello** = Identico all'estensione `voice-call/` (Twilio), ma con protocollo XiaoZhi

---

## Prerequisiti (bloccanti)

| #   | Task                                        | Dipende da | Note                                                                                                                              |
| --- | ------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **SSL/TLS su laragoci.lara-ai.eu**          | —          | **COMPLETATO** ✅ — Cloudflare Tunnel (`cloudflared`), OTA endpoint verificato.                                                   |
| P2  | **Clone + build OpenClaw da sorgente**      | —          | **COMPLETATO** ✅ — VM `ubuntu-8gb-hel1-1` (Hetzner CX22 8GB, Ubuntu 24.04). Clone, `pnpm install`, build OK. Versione 2026.2.26. |
| P3  | **Flash firmware XiaoZhi su BOX-3**         | —          | **COMPLETATO** ✅ — ESP-IDF v5.5.3, firmware custom con OTA URL laragoci.lara-ai.eu, wake word disabled, handshake WS verificato. |
| P4  | **Test hardware con server XiaoZhi Docker** | P3         | Validare che mic/speaker/display funzionano. Deploy docker xiaozhi-esp32-server temporaneo.                                       |

---

## Fase 1: Estensione OpenClaw (core bridge)

| #    | Task                             | Dipende da | File/Posizione                                | Dettaglio                                                                                                                                      |
| ---- | -------------------------------- | ---------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | ~~**Scaffold estensione**~~      | P2         | `extensions/xiaozhi/`                         | **COMPLETATO** ✅ — `openclaw.plugin.json`, `package.json`, `index.ts`, tutti i file `src/`. Commit `c3cf410`.                                 |
| 1.1b | ~~**Channel plugin**~~           | 1.1        | `src/channel.ts`                              | **COMPLETATO** ✅ — `xiaozhiChannelPlugin` con config, status, capabilities. Commit `1fbefcc`.                                                 |
| 1.1c | ~~**Tool MCP (stub)**~~          | 1.1        | `src/tools.ts`                                | **COMPLETATO** ✅ — 5 tool stub: `laragoci_speak/emoji/volume/status/play`. `index.ts` cablato. Commit `29d575a`.                              |
| 1.2  | ~~**Patch WS upgrade handler**~~ | P2         | `src/gateway/server-http.ts` + `src/plugins/` | **COMPLETATO** ✅ — `registerWsUpgradeHandler` nel plugin-SDK + registry + factory `plugins-ws.ts` + `attachGatewayUpgradeHandler` aggiornato. |
| 1.3  | ~~**Protocollo XiaoZhi**~~       | 1.1        | `src/protocol.ts`                             | **COMPLETATO** ✅ — `parseMessage`, `buildHello`, `buildStt`, `buildLlm`, `buildTts`.                                                          |
| 1.4  | ~~**Bridge WebSocket**~~         | 1.2, 1.3   | `src/bridge.ts`                               | **COMPLETATO** ✅ — `WebSocketServer noServer`, `handleUpgrade` (path `/xiaozhi/v1`), session tracking UUID, hello handshake, close/error.     |
| 1.5  | ~~**Endpoint OTA**~~             | 1.1        | `src/ota.ts`                                  | **COMPLETATO** ✅ — risponde con `{"url":"wss://...","token":"<hmac-sha256>"}`. Token opzionale se `secret` non configurato.                   |

## Fase 2: Audio pipeline

### Decisioni architetturali (2026-03-20)

- **Attivazione durante sviluppo:** button fisico (toggle idle ↔ listening). Il bridge riceve `listen:start` + Opus identicamente al flow wake word — nessun impatto sulla pipeline.
- **Wake word finale:** "goci goci" via WakeNet custom (training ~1000 sample TTS sintetici). Lavoro firmware indipendente, da fare dopo MVP. Quando arriva, il bridge aggiunge solo la gestione di `listen:detect` prima di `listen:start`.
- **Trigger agente:** non serve una parola chiave software-side — il button sostituisce il trigger durante lo sviluppo.
- **Protocol version:** il device usa v1 → frame Opus raw senza header 4 byte.

### Bug da fixare prima della pipeline (trovati da serial monitor 2026-03-20)

| #   | Bug                                                                                        | File                 | Fix                                            | Stato             |
| --- | ------------------------------------------------------------------------------------------ | -------------------- | ---------------------------------------------- | ----------------- |
| B1  | `buildHello` manda `sample_rate: 16000` invece di 24000                                    | `src/protocol.ts:29` | 1 riga                                         | **✅ 2026-03-21** |
| B2  | `buildTts` usa campo `action` invece di `state`                                            | `src/protocol.ts:47` | 1 riga                                         | **✅ 2026-03-21** |
| B3  | Connessione cade per NAT timeout router (~20s idle)                                        | `src/bridge.ts`      | `ws.ping()` ogni 10s                           | **✅ 2026-03-21** |
| B4  | `parseMessage` tenta `JSON.parse` su frame Opus binari (protocol v1)                       | `src/protocol.ts:8`  | discrimina Buffer vs stringa                   | **✅ 2026-03-21** |
| B5  | Cloudflare Tunnel chiude la connessione dopo ~60s (PING/PONG non contano come data frames) | `src/bridge.ts`      | `ws.send({type:"ping"})` invece di `ws.ping()` | **✅ 2026-03-21** |

### Tasks

| #   | Task                            | Dipende da | File/Posizione          | Dettaglio                                                                                                                             |
| --- | ------------------------------- | ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 2.2 | ~~**VAD**~~                     | —          | —                       | **NON NECESSARIO** — il device manda `listen:stop` quando rileva silenzio. Rimosso dal piano.                                         |
| 2.1 | **Opus decode**                 | B4         | `src/audio-pipeline.ts` | Decodifica frame Opus raw (16kHz mono 60ms) → PCM con `@discordjs/opus`.                                                              |
| 2.3 | **STT (Whisper)**               | 2.1        | `src/audio-pipeline.ts` | Buffer Opus tra listen:start e listen:stop → Whisper API (language: "it") → testo. No trigger → silent ack (tts:start+stop vuoto).    |
| 2.4 | **Integrazione agentCommand()** | 2.3        | `src/channel.ts`        | Chiama `agentCommand({ message: testo, sessionKey: "main", messageChannel: "xiaozhi" })`. Channel plugin già registrato ✅.           |
| 2.5 | **TTS → Opus encode**           | 2.4        | `src/audio-pipeline.ts` | Risposta agente → OpenAI TTS (pcm_24000, Nova) → PCM → Opus encode (24kHz mono 60ms).                                                 |
| 2.6 | **Rate controller**             | 2.5        | `src/audio-pipeline.ts` | Invio rate-controlled 60ms/frame. Messaggi `tts:start`, `tts:sentence_start`, `tts:stop`. Dopo tts:stop device torna in listen:start. |
| 2.7 | **Emoji display**               | 2.4        | `src/bridge.ts`         | Invia `{"type":"llm","emotion":"happy"}` al device.                                                                                   |

### Wake word (post-MVP, indipendente dalla pipeline)

| #   | Task                             | Dettaglio                                                             |
| --- | -------------------------------- | --------------------------------------------------------------------- |
| W1  | **Training "goci goci" WakeNet** | ~1000 sample TTS sintetici → Espressif training → modello `.bin`      |
| W2  | **Flash + integrazione bridge**  | Flash modello + gestione `listen:detect` nel bridge (modifica minima) |

## Fase 3: Tool MCP agente

| #   | Task                | Dipende da | File/Posizione | Dettaglio                                                                                                    |
| --- | ------------------- | ---------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| 3.1 | **laragoci.speak**  | 2.5        | `src/tools.ts` | `registerTool()`. L'agente invia testo → bridge → TTS → Opus → device. Per heartbeat, notifiche, iniziativa. |
| 3.2 | **laragoci.emoji**  | 2.7        | `src/tools.ts` | `registerTool()`. Invia emoji/emozione al display LCD.                                                       |
| 3.3 | **laragoci.volume** | 1.4        | `src/tools.ts` | `registerTool()`. Usa protocollo XiaoZhi MCP: `tools/call` → `self.audio_speaker.set_volume`.                |
| 3.4 | **laragoci.status** | 1.4        | `src/tools.ts` | `registerTool()`. Ottieni stato device (batteria, WiFi, connessione).                                        |
| 3.5 | **laragoci.play**   | 2.5        | `src/tools.ts` | `registerTool()`. Riproduci audio/URL sullo speaker.                                                         |

## Fase 4: Testing e integrazione

| #   | Task                        | Dipende da | Dettaglio                                                                              |
| --- | --------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| 4.1 | **Test handshake**          | 1.4, 1.5   | **COMPLETATO** ✅ — Device connesso, hello ricevuto, session_id assegnato. 2026-03-19. |
| 4.2 | **Test audio round-trip**   | 2.6        | Parla al device → testo sullo schermo → risposta audio.                                |
| 4.3 | **Test emoji**              | 2.7        | Verifica che le emoji appaiono sul display LCD.                                        |
| 4.4 | **Test tool MCP**           | 3.1-3.4    | Heartbeat → agente parla sul device proattivamente.                                    |
| 4.5 | **Test sessione condivisa** | 4.2        | Scrivi su WhatsApp, chiedi al device — stessa memoria.                                 |
| 4.6 | **Test abort**              | 2.6        | Interrompi l'agente mentre parla (wake word o pulsante).                               |
| 4.7 | **Test reconnection**       | 1.4        | Disconnect/reconnect con backoff esponenziale.                                         |

## Fase 5: Funzionalita' avanzate (post-MVP)

| #   | Task                 | Dettaglio                                        |
| --- | -------------------- | ------------------------------------------------ |
| 5.1 | Bluetooth A2DP       | Pairing vocale, connessione auto a cuffie/auto.  |
| 5.2 | Modulo 4G SIM7600G-H | Connessione cellulare, richiede SSL (P1).        |
| 5.3 | GPS via SIM7600G-H   | Location tracking.                               |
| 5.4 | Power management     | Deep sleep + wake word, ottimizzazione batteria. |
| 5.5 | OTA firmware updates | Aggiornamento firmware via WiFi/4G.              |
| 5.6 | Knowledge layer      | GraphDB skill per ontologia utente.              |
| 5.7 | PCB custom           | Design PCB basato su learning BOX-3.             |
| 5.8 | Case AirPods-like    | Stampa 3D, form factor tascabile.                |

---

## Parametri tecnici di riferimento rapido

### Audio

```
Upload:   Opus, 16kHz, mono, 60ms frame
Download: Opus, 24kHz, mono, 60ms frame, 24kbps, complexity 10
VAD:      soglia alta 0.5, soglia bassa 0.2, silenzio 1000ms
```

### Protocollo XiaoZhi (7 messaggi JSON)

```
Device → Server:  hello, listen (start/stop/detect), abort, mcp (result)
Server → Device:  hello, stt, llm (emotion), tts (start/sentence_start/stop), mcp (tools/call), system
```

### Connessione

```
URL:     wss://laragoci.lara-ai.eu/xiaozhi/v1/
OTA:     POST /xiaozhi/ota/
Auth:    Bearer token HMAC-SHA256
Headers: Authorization, Protocol-Version, Device-Id, Client-Id
Timeout: hello 10s, inattivita' 120s
```

### File chiave da modificare/creare

```
CREARE:
  extensions/xiaozhi/openclaw.plugin.json
  extensions/xiaozhi/package.json
  extensions/xiaozhi/index.ts
  extensions/xiaozhi/src/bridge.ts
  extensions/xiaozhi/src/protocol.ts
  extensions/xiaozhi/src/audio-pipeline.ts
  extensions/xiaozhi/src/channel.ts
  extensions/xiaozhi/src/ota.ts
  extensions/xiaozhi/src/tools.ts

MODIFICATI (task 1.2):
  src/plugins/types.ts              ✅ OpenClawPluginWsUpgradeHandler + registerWsUpgradeHandler
  src/plugins/registry.ts           ✅ PluginWsUpgradeRegistration + wsUpgradeHandlers[]
  src/gateway/server/plugins-ws.ts  ✅ NUOVO — createGatewayPluginWsUpgradeHandler
  src/gateway/server-http.ts        ✅ attachGatewayUpgradeHandler: pluginUpgradeHandler param
  src/gateway/server-runtime-state.ts ✅ crea handler + passa ad attachGatewayUpgradeHandler
  src/plugin-sdk/index.ts           ✅ export OpenClawPluginWsUpgradeHandler

RIFERIMENTO (non modificare, solo studiare):
  extensions/voice-call/      → modello architetturale da seguire
  src/gateway/server-node-events.ts → come iniettare messaggi nell'agent loop
  src/commands/agent.ts       → agentCommand() per inviare testo all'agente
  src/tts/tts.ts             → sistema TTS esistente
```

---

## Dipendenze npm da aggiungere

```json
{
  "@discordjs/opus": "^0.9.0"
}
```

> `node-vad` rimosso — VAD è hardware-side sul device.

### Build nativo @discordjs/opus

`@discordjs/opus` è un addon nativo C++ — non ha prebuilt per Node 22 su Linux x64.
Dopo ogni `npm install` / `pnpm install` nella dir dell'estensione, compilarlo manualmente:

```bash
cd extensions/xiaozhi
npm rebuild @discordjs/opus
```

Il binario viene messo in `node_modules/@discordjs/opus/prebuild/node-v127-napi-v3-linux-x64-glibc-2.39/opus.node`.
Senza questo step il gateway crasha all'avvio con `Cannot find module ... opus.node`.

---

## Documentazione di riferimento

- **Architettura e protocollo completo:** [laragoci.md](laragoci.md)
- **Piano SSL:** [plans/2026-02-16-ssl-setup.md](plans/2026-02-16-ssl-setup.md)
- **Piano progetto originale:** [plans/2026-02-16-laragoci-project.md](plans/2026-02-16-laragoci-project.md)
- **Roadmap globale:** [ROADMAP.md](ROADMAP.md)
- **Protocollo XiaoZhi WS:** https://github.com/78/xiaozhi-esp32/blob/main/docs/websocket.md
- **Protocollo XiaoZhi MCP:** https://github.com/78/xiaozhi-esp32/blob/main/docs/mcp-protocol.md
- **Firmware XiaoZhi:** https://github.com/78/xiaozhi-esp32
- **Estensione voice-call (modello):** `extensions/voice-call/` nel repo OpenClaw
- **OpenClaw source:** https://github.com/openclaw/openclaw

---

## Licenze (verificate 2026-02-19)

Tutto lo stack e' **MIT/Apache/BSD** — uso commerciale libero, modifiche proprietarie consentite.

| Componente       | Licenza    | Obbligo                 |
| ---------------- | ---------- | ----------------------- |
| OpenClaw         | MIT        | Notice MIT nel prodotto |
| XiaoZhi firmware | MIT        | Notice MIT nel prodotto |
| ESP-IDF          | Apache 2.0 | Notice Apache           |
| LVGL             | MIT        | Notice MIT              |
| Opus             | BSD        | Nessuno                 |

**Task pre-lancio:** Audit licenze dipendenze npm (`license-checker`) + creare file NOTICES per il prodotto.
