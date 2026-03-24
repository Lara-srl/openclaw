# Piano Fase 2 — Audio Pipeline

> Creato: 2026-03-20 — Aggiornato: 2026-03-24 — Stato: B1-B9 risolti ✅, pipeline 2.1→2.7 funzionante ✅, audio round-trip VERIFICATO ✅

---

## Decisioni architetturali

| Decisione                    | Scelta                                  | Motivo                                                                   |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| Attivazione durante sviluppo | Button fisico (toggle idle ↔ listening) | Funziona già, pipeline identica al flow wake word                        |
| Wake word finale             | "goci goci" via WakeNet custom          | 4 sil, 8 fonemi, unica nel parlato normale, ripetizione aiuta il modello |
| Trigger agente               | Nessun filtro software-side             | Button sostituisce il trigger durante sviluppo                           |
| Protocol version             | v1 — Opus raw senza header 4 byte       | Confermato dal serial monitor                                            |
| VAD                          | Hardware sul device (WebRTC)            | Device manda listen:start/stop autonomamente, nessun VAD server-side     |

---

## Bug da fixare (trovati dal serial monitor 2026-03-20)

### B1 — `sample_rate` errato nel hello server ✅ RISOLTO 2026-03-21

**File:** `extensions/xiaozhi/src/protocol.ts:29`
**Sintomo:** `W Application: Server sample rate 16000 does not match device output sample rate 24000`
**Fix:** `sample_rate: 16000` → `sample_rate: 24000` in `buildHello`
**Verifica:** serial monitor non mostra più il warning dopo il fix

### B2 — `buildTts` usa `action` invece di `state` ✅ RISOLTO 2026-03-21

**File:** `extensions/xiaozhi/src/protocol.ts:47`
**Fix:** rinominare il campo `action` → `state`

```ts
// prima:  { type: "tts", action: "start" }
// dopo:   { type: "tts", state: "start" }
```

### B3 — Connessione cade per timeout idle ✅ RISOLTO 2026-03-21

**File:** `extensions/xiaozhi/src/bridge.ts`
**Sintomo:** `E EspSsl: SSL receive failed: -76` → `WS: Websocket disconnected` — WS close code **1006**
**Causa reale (da diagnostica):** non è Cloudflare timeout a 100s — è il **NAT del router home (Fritz!Box)**
che azzera la mappatura TCP per connessioni idle. Timeout osservato: ~20s senza keepalive.
**Fix:** `setInterval(() => ws.ping(), 10_000)` in `handleConnection`, clear su `close`/`error`.
Intervallo ridotto a 10s dopo test (30s non bastava, connessione cadeva a 21s prima del primo ping).
**Verifica:** con keepalive 10s la connessione regge oltre 40s idle. Il disconnect a 40s quando si preme
il bottone è atteso (Phase 1 stub — il bridge non risponde con STT/TTS → device timeout).
**Note aggiuntive:**

- Aggiunto `console.log` su connect/disconnect con session ID, device MAC, WS close code
- `cloudflared` (PID 36774, running dal Mar15) è stabile — non causa i disconnect

### B5 — Cloudflare Tunnel chiude connessione dopo ~60s ✅ RISOLTO 2026-03-21

**File:** `extensions/xiaozhi/src/bridge.ts`
**Sintomo:** disconnect code=1006 esattamente ~64s dopo la connessione, nonostante keepalive `ws.ping()` ogni 10s
**Diagnostica (2026-03-21 23:07-23:08):**

```
23:07:42 connected session=54df8d52
23:07:42 listen:start (device si è connesso e ha mandato listen:start subito)
23:07:52 keepalive ping readyState=1  ← ping funziona, connessione OPEN
23:08:02 keepalive ping readyState=1
23:08:12 keepalive ping readyState=1
23:08:22 keepalive ping readyState=1
23:08:32 keepalive ping readyState=1
23:08:42 keepalive ping readyState=1  ← ultimo ping, 60s dall'inizio
23:08:46 disconnected code=1006       ← 4s dopo l'ultimo ping
```

**Causa:** Cloudflare Tunnel considera i WebSocket PING/PONG come control frames, non come dati.
Dopo ~60s senza DATA frames dal server verso il device, Cloudflare chiude la connessione.
Il keepalive con `ws.ping()` (WS control frame) non è sufficiente.
**Fix:** sostituire `ws.ping()` con `ws.send(JSON.stringify({type:"ping"}))` — TEXT data frame.
Il firmware XiaoZhi ignora message types sconosciuti (logga `Unknown message type: ping`, non crasha).
**File:** `extensions/xiaozhi/src/bridge.ts` — `setInterval` con `ws.send(JSON.stringify({type:"ping"}))` ogni 10s.
**Nota:** B5 parzialmente risolto → vedi B6.

### B6 — Fritz!Box NAT timeout ~9.2s, keepalive 10s troppo lento ✅ RISOLTO 2026-03-21

**File:** `extensions/xiaozhi/src/bridge.ts`
**Sintomo:** dopo il fix B5 (data frame ogni 10s), connessione cade ancora a ~19-20s.
**Diagnostica (session 132db34e, 2026-03-21 23:17):**

```
Connessione a device uptime 55714ms
W (65314) Application: Unknown message type: ping  ← ping ricevuto a t=9.6s dalla connessione
I (74544) SystemInfo: free sram                    ← t=18.8s
E (74904) EspSsl: SSL receive failed: -76          ← disconnect a t=19.2s
```

**Calcolo:** ping refresh NAT a t=9.6s → NAT timeout 9.2s → NAT cade a 9.6+9.2=18.8s.
Prossimo ping a t=19.6s (10s dopo il primo). 18.8 < 19.6 → connessione cade 800ms PRIMA del ping.
**Causa:** `ws.ping()` (control frame) mandava PING + riceveva PONG dal device → due pacchetti TCP
(uno per direzione) ogni 10s, refresh NAT in entrambe le direzioni. Con `ws.send()` (data frame),
solo server→device → il device NON risponde → NAT del Fritz!Box vede solo metà del traffico.
**Fix:** ridurre keepalive da `10_000` a `8_000` ms + inviare ENTRAMBI: data frame E ws.ping().
Questo garantisce: data flow per Cloudflare (data frame) + PONG bidirezionale per NAT (control frame).
**Gateway log (session d846296c):** connected 23:16:22, disconnected 23:16:55 = 33s (utente ha premuto bottone, Opus frames hanno temporaneamente tenuto in vita il NAT).
**Gateway log (session 132db34e):** connected 23:17:00, disconnected 23:17:20 = 20s (no button, solo keepalive, cade per NAT race condition).

### B4 — `parseMessage` crasha su frame Opus binari ✅ RISOLTO 2026-03-21

**File:** `extensions/xiaozhi/src/protocol.ts:8`
**Causa:** Protocol v1 manda frame Opus raw (Buffer binario), il parser tenta `JSON.parse` → eccezione
**Fix:** discriminare tipo frame prima del parse:

```ts
// se Buffer e non inizia con '{' → frame Opus binario, non JSON
if (Buffer.isBuffer(data) && data[0] !== 0x7b) return { type: "audio", payload: data };
```

### B7 — ws.ping() causa SSL reset sul device ✅ RISOLTO 2026-03-21

**File:** `extensions/xiaozhi/src/bridge.ts`
**Sintomo:** `MBEDTLS_ERR_NET_RECV_FAILED` ~4.8s dopo il primo ping → disconnect durante ascolto attivo.
**Fix:** rimosso `ws.ping()`. Durante ascolto, i frame Opus del device (~60ms/frame) garantiscono traffico bidirezionale sufficiente per Fritz!Box NAT. In idle, il JSON data frame `{"type":"ping"}` ogni 8s è sufficiente per Cloudflare.

### B8 — Device disconnette (1006) invece di mandare listen:stop ✅ RISOLTO 2026-03-24

**File:** `extensions/xiaozhi/src/audio-pipeline.ts`, `extensions/xiaozhi/src/bridge.ts`
**Sintomo:** il secondo click del bottone causa disconnect 1006 invece di listen:stop → pipeline mai triggerata.
**Causa:** il device manda listen:stop + chiude TCP in rapida successione. Con 1006 (TCP RST) il frame listen:stop viene scartato prima di essere processato — race condition.
**Fix:** `flushOnDisconnect()` in `AudioPipeline` — se `state === "listening"` con frame bufferizzati al momento del close, triggera `onListenStop()` implicito. STT + agent girano, TTS silently no-op (WS chiusa).
**Flusso reale device:**

- Click 1 → `listen:start` + streaming audio (60ms/frame)
- Click 2 → 1006 disconnect (listen:stop perso nel TCP RST)
- B8 salva la pipeline

### B9 — TTS perso su WS già chiusa (B8 case) ✅ RISOLTO 2026-03-24

**File:** `extensions/xiaozhi/src/audio-pipeline.ts`, `extensions/xiaozhi/src/bridge.ts`
**Sintomo:** dopo B8, STT e agent funzionano ma i frame TTS vengono inviati su WS chiusa → silently no-op → device non sente risposta.
**Fix:**

1. In `speak()`: se `ws.readyState !== OPEN` dopo encode, chiama callback `onTtsReady(frames)` invece di inviare.
2. In `bridge.ts`: `pendingTts = Map<deviceId, Buffer[]>` — salva i frame.
3. Su reconnect dello stesso device: `injectTts(frames)` invia i frame pending sulla nuova WS (state → speaking → blocca listen:start via guard → tts:stop → idle).
   **Risultato:** il device sente la risposta al prossimo reconnect, poi può fare la domanda successiva.

---

## Flusso completo messaggi (stato attuale 2026-03-24)

```
SESSIONE N (click 1 + click 2 = disconnect B8)
  Device                          Bridge                          Pipeline / Agent
    |-- connect ------------------>|                                  |
    |<-- hello (session_id) -------|  B9: check pendingTts[deviceId]  |
    |                              |  → injectTts se presente         |
    |-- hello (device) ----------->|  (ignorato)                      |
    |-- listen:start ------------->|  onListenStart() state→listening |
    |-- [Opus ×N] --------------->|                                  |<-- buffer
    |  [click 2]                   |                                  |
    |-- 1006 disconnect ---------->|  B8: flushOnDisconnect()         |
    |                              |      → onListenStop() implicito  |
    |                              |                                  |-- Opus→PCM→Whisper→Agent→TTS encode
    |                              |                                  |   ws chiusa → onTtsReady(frames)
    |                              |  pendingTts.set(deviceId,frames) |

SESSIONE N+1 (reconnect)
    |-- connect ------------------>|                                  |
    |<-- hello (session_id) -------|                                  |
    |<-- tts:start ----------------|  B9: injectTts(pending frames)   |-- state→speaking
    |<-- [Opus ×M] ---------------|                                  |   rate-ctrl 60ms/frame
    |<-- tts:stop -----------------|                                  |-- state→idle
    |-- hello (device) ----------->|  (ignorato)                      |
    |-- listen:start ------------->|  onListenStart() (idle→ok)       |
    |-- [Opus ×K] --------------->|  ...prossima domanda...          |
```

---

## State machine per sessione device

Ogni `DeviceSession` in `bridge.ts` ha il proprio `AudioPipeline`. Stati:

```
IDLE
  ↓ listen:start
LISTENING  (accumula frame Opus nel buffer)
  ↓ listen:stop
PROCESSING  (Whisper → agentCommand → TTS → Opus encode)
  ↓ tts:start inviato
SPEAKING  (invia frame Opus rate-controlled al device)
  ↓ tts:stop inviato
IDLE  (dialog mode: device manda subito listen:start → LISTENING)
```

**Abort:** messaggio `{"type":"abort"}` dal device in qualsiasi stato → interrompi TTS in corso → svuota buffer → torna IDLE.

```
SPEAKING → [abort ricevuto] → stop invio frame → tts:stop → IDLE
PROCESSING → [abort ricevuto] → cancella richiesta agente → IDLE
```

---

## Integrazione bridge.ts ↔ audio-pipeline.ts

`bridge.ts` crea un `AudioPipeline` per ogni connessione device e smista i messaggi:

```ts
// in handleConnection():
const pipeline = new AudioPipeline(ws, deps); // deps: openai, agentCommand

ws.on("message", (data) => {
  if (isBinaryFrame(data)) {
    pipeline.onAudioFrame(data); // frame Opus → buffer
    return;
  }
  const msg = parseMessage(data);
  switch (msg.type) {
    case "listen":
      if (msg.state === "start") pipeline.onListenStart();
      if (msg.state === "stop") pipeline.onListenStop();
      break;
    case "abort":
      pipeline.onAbort();
      break;
  }
});

ws.on("close", () => pipeline.flushOnDisconnect()); // B8
```

---

## Tasks pipeline (in ordine)

| #     | Task                  | Dipende da | File                               | Dettaglio                                                                                                                                                           |
| ----- | --------------------- | ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1-B4 | ~~**Fix bug**~~       | —          | `src/protocol.ts`, `src/bridge.ts` | **COMPLETATO** ✅ 2026-03-21                                                                                                                                        |
| 2.1   | **Opus decode**       | B4         | `src/audio-pipeline.ts`            | Frame Opus raw (16kHz mono 60ms) → PCM con `@discordjs/opus`                                                                                                        |
| 2.3   | **STT Whisper**       | 2.1        | `src/audio-pipeline.ts`            | Buffer Opus tra listen:start → listen:stop → Whisper API (`language: "it"`) → testo. No risposta → silent ack (`tts:start` + `tts:stop` vuoto)                      |
| 2.4   | **agentCommand()**    | 2.3        | `src/channel.ts`                   | `agentCommand({ message: testo, sessionKey: "main", messageChannel: "xiaozhi" })`                                                                                   |
| 2.5   | **TTS → Opus encode** | 2.4        | `src/audio-pipeline.ts`            | Risposta agente → OpenAI TTS (`pcm_24000`, voce Nova) → PCM → Opus encode (24kHz mono 60ms, 24kbps, complexity 10)                                                  |
| 2.6   | **Rate controller**   | 2.5        | `src/audio-pipeline.ts`            | Invio rate-controlled 60ms/frame. Sequenza: `tts:start` → `tts:sentence_start` → frame Opus → `tts:stop`. Dopo stop il device torna in listen:start automaticamente |
| 2.7   | **Emoji display**     | 2.4        | `src/bridge.ts`                    | Invia `{"type":"llm","emotion":"happy"}` al device prima del TTS                                                                                                    |

---

## Wake word "goci goci" — post-MVP (indipendente dalla pipeline)

### Perché "goci goci"

- 4 sillabe, 8 fonemi → supera la soglia minima raccomandata (3 sil, 6 fonemi)
- Ripetizione: pattern che i modelli wake word riconoscono meglio (stessa logica di "Ok Google")
- Non compare mai nel parlato normale italiano → falsi positivi minimi
- Pronuncia italiana nativa → nessun problema di accento

### Come fare il training WakeNet custom

**Documentazione ufficiale:** https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/wake_word_engine/ESP_Wake_Words_Customization.html

**Step:**

1. **Genera ~1000 campioni TTS sintetici di "goci goci"**
   - Usa Python + qualsiasi TTS (ElevenLabs, Azure, Google TTS, Piper)
   - Varia: voce, velocità, tono, volume, leggero rumore di fondo
   - Formato richiesto: WAV, 16kHz, mono, 16-bit signed

2. **Segui il processo di customizzazione Espressif**
   - Espressif fornisce uno strumento di training (o un servizio cloud)
   - Input: campioni audio + nome della wake word
   - Output: file modello `.bin` da flashare nella partizione dedicata

3. **Integra nel firmware XiaoZhi**
   - Copia il `.bin` nella partizione `model` del firmware
   - Riabilita WakeNet nel menuconfig (`CONFIG_USE_WAKENET=y`)
   - AFE Pipeline diventa: `[input] -> |WakeNet| -> |VAD| -> [output]`
   - Il device manda `{"type":"listen","state":"detect","text":"goci goci"}` quando rileva la wake word

4. **Aggiorna il bridge (modifica minima)**
   - Aggiungere gestione `listen:detect` in `bridge.ts`
   - Al `detect` → avvia la sessione STT (già pronta dalla pipeline)
   - Nessuna modifica strutturale alla pipeline

### Dipendenza npm da aggiungere

```json
{
  "@discordjs/opus": "^0.9.0"
}
```

---

## Parametri audio di riferimento

```
Upload   (device → server): Opus, 16kHz, mono, 60ms/frame, protocol v1 (raw, no header)
Download (server → device): Opus, 24kHz, mono, 60ms/frame, 24kbps, complexity 10
VAD:     hardware WebRTC sul device — nessun VAD server-side necessario
```
