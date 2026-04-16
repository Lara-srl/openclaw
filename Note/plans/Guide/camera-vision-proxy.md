# Camera Vision Proxy — Guida Architetturale

## Panoramica

Il device (SenseCAP Watcher / ESP32-S3-BOX-3) scatta una foto e la invia al gateway per l'analisi visiva tramite Pixtral (Mistral Vision). Il flusso coinvolge 3 componenti:

```
Device (firmware C++)
    |
    | 1. MCP tool call: self.camera.take_photo
    |
Gateway (OpenClaw)
    |
    | 2. bridge.ts invia MCP request al device
    | 3. device cattura JPEG, POSTa a /xiaozhi/vision
    | 4. vision-proxy.ts analizza con Pixtral
    | 5. risposta torna al device via HTTP response
    | 6. device torna il risultato via MCP response
    |
LLM (Mistral)
    |
    | 7. tool result con descrizione immagine
```

## Flusso dettagliato

### 1. LLM chiama il tool `laragoci_photo`

Il tool e' registrato in `extensions/xiaozhi/src/tools.ts`. Quando l'LLM vuole vedere qualcosa, chiama il tool con un parametro `question`.

### 2. Gateway invia MCP al device

`tools.ts` chiama `bridge.callDeviceMcp("tools/call", { name: "self.camera.take_photo", arguments: { question } })` con timeout 30s.

### 3. Device cattura e POSTa la foto

Il firmware (`sscma_camera.cc`) fa:

- `Capture()` — cattura JPEG dalla camera Himax via SPI
- `Explain(question)` — POSTa il JPEG al vision proxy

La POST e' multipart/form-data con:

- **boundary**: `----ESP32_CAMERA_BOUNDARY`
- **campo `question`**: testo della domanda
- **campo `file`** (filename=`camera.jpg`): JPEG binario
- **Transfer-Encoding**: chunked

### 4. Vision proxy analizza l'immagine

`extensions/xiaozhi/src/vision-proxy.ts`:

- Registrato come HTTP route su `/xiaozhi/vision` in `index.ts`
- Parsa il multipart, estrae question + JPEG
- Converte JPEG in base64
- Chiama `runEmbeddedPiAgent` con Pixtral (`pixtral-large-latest`)
- Ritorna `{"success": true, "result": "descrizione..."}`

### 5. Device ritorna risultato via MCP

Il firmware riceve la risposta HTTP JSON e la passa come risultato MCP al gateway.

## File chiave

| File                                                | Ruolo                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `extensions/xiaozhi/src/tools.ts`                   | Registra tool `laragoci_photo`, chiama `callDeviceMcp`              |
| `extensions/xiaozhi/src/vision-proxy.ts`            | HTTP handler `/xiaozhi/vision`, parsing multipart, chiamata Pixtral |
| `extensions/xiaozhi/src/bridge.ts`                  | Invia MCP initialize con `vision.url` al device                     |
| `extensions/xiaozhi/src/config.ts`                  | `readXiaozhiVisionUrl()` legge URL dalla config                     |
| `extensions/xiaozhi/index.ts`                       | Registra la route HTTP                                              |
| `Note/main/boards/sensecap-watcher/sscma_camera.cc` | Firmware: cattura + POST                                            |

## Configurazione

### URL Vision (gateway side)

L'URL che il device usa per POSTare la foto viene inviato dal bridge durante l'handshake MCP `initialize`:

```json
{
  "capabilities": {
    "vision": {
      "url": "https://laragoci.lara-ai.eu/xiaozhi/vision",
      "token": ""
    }
  }
}
```

Il default e' `https://laragoci.lara-ai.eu/xiaozhi/vision` (tunnel Cloudflare).
Sovrascrivibile in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "xiaozhi": {
        "visionUrl": "https://custom-domain.example/xiaozhi/vision"
      }
    }
  }
}
```

### Modello Vision

In `vision-proxy.ts`, il modello e' `pixtral-large-latest` (Mistral). Usa `MISTRAL_API_KEY` env var.

## Bug risolti e trappole

### 1. URL localhost non raggiungibile dal device

Il device e' un ESP32 su rete WiFi. `http://localhost:18789` punta al device stesso, non al gateway. Serve l'URL pubblico (tunnel Cloudflare `laragoci.lara-ai.eu`).

### 2. Nome campo multipart: `file` non `image`

Il firmware manda `name="file"` con `filename="camera.jpg"`. Il parser deve accettare entrambi `"file"` e `"image"`.

### 3. Regex greedy nel parser multipart

```
Content-Disposition: form-data; name="file"; filename="camera.jpg"
```

- `.*name="([^"]+)"` (greedy) → cattura `camera.jpg` (dal `filename=`)
- `.*?name="([^"]+)"` (non-greedy) → cattura `file` (dal primo `name=`)

### 4. Cache jiti

I plugin vengono transpilati da jiti e cachati in `/tmp/jiti/`. Dopo modifiche ai sorgenti dei plugin:

```bash
rm /tmp/jiti/src-vision-proxy.*.cjs 2>/dev/null
# oppure per pulire tutta la cache xiaozhi:
rm /tmp/jiti/src-*.cjs 2>/dev/null
```

Poi restart gateway.

### 5. Timeout

Il timeout MCP per la foto e' 30s (`tools.ts`). Il tempo totale include:

- Cattura camera (~1-2s)
- Upload JPEG via HTTPS (~1-3s)
- Analisi Pixtral (~5-10s)
- Risposta al device (~1s)

## Comandi utili

```bash
# Test endpoint vision localmente
curl -s -X POST http://127.0.0.1:18789/xiaozhi/vision \
  -F "question=What do you see?" \
  -F "file=@/tmp/test.jpg;type=image/jpeg"

# Test via tunnel Cloudflare
curl -s -X POST https://laragoci.lara-ai.eu/xiaozhi/vision \
  -F "question=What do you see?" \
  -F "file=@/tmp/test.jpg;type=image/jpeg"

# Rebuild + restart (dopo modifiche plugin)
rm /tmp/jiti/src-vision-proxy.*.cjs 2>/dev/null
pnpm build
# poi restart gateway dal terminale dedicato

# Log vision proxy
grep "vision-proxy" /tmp/openclaw-gateway.log

# Log firmware (seriale)
# Cercare: SscmaCamera, HttpClient, "explain URL", "upload photo"
```
