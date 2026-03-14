# 02 — Setup Device ESP32-S3-BOX-3

_Data: 2026-03-14_

## Prerequisiti prima di toccare il device

- [x] Completare task 1.2 + 1.3 + 1.4 nel codice (bridge WS funzionante) ✅ 2026-03-14
- [ ] SSL/TLS su `openclaw.lara-ai.eu` (P1) — senza certificato valido l'ESP32 rifiuta WSS

---

## Step 1 — Flash firmware XiaoZhi

Il firmware di fabbrica del BOX-3 **non parla il protocollo XiaoZhi WebSocket**.
Va sostituito con il firmware ufficiale XiaoZhi.

1. Apri Chrome (necessario per Web Serial API)
2. Vai su https://xiaozhi.me/flash
3. Collega il BOX-3 al PC via USB-C
4. Seleziona il target **ESP32-S3-BOX-3**
5. Clicca Flash — attendi completamento
6. Il device si riavvia sul firmware XiaoZhi

---

## Step 2 — Configura WiFi

Al primo avvio il BOX-3 entra in modalità provisioning:

1. Sul display appare un QR code o SSID temporaneo
2. Connetti il telefono alla rete del BOX-3
3. Inserisci le credenziali WiFi di casa/laboratorio
4. Il device si connette e mostra l'IP sul display

---

## Step 3 — Punta il gateway a OpenClaw

Per default il firmware punta al server XiaoZhi pubblico.
Va reindirizzato al nostro gateway.

### Opzione A — OTA endpoint (preferita)

Quando il device fa boot chiama `POST /xiaozhi/ota/` per ricevere l'URL WebSocket.
Il nostro endpoint OTA (task 1.5) risponde con:

```json
{
  "url": "wss://openclaw.lara-ai.eu/xiaozhi/v1/",
  "token": "<hmac-sha256>"
}
```

Configurare nel firmware l'URL OTA prima del flash:

- Default OTA URL nel firmware XiaoZhi: `https://api.tenclass.net/xiaozhi/ota/`
- Va cambiato in: `https://openclaw.lara-ai.eu/xiaozhi/ota/`

Questo si imposta nel file `sdkconfig` prima di compilare, oppure via web installer
se supporta custom OTA URL.

### Opzione B — Config via seriale (fallback)

Se non si riesce a cambiare l'OTA URL prima del flash:

```bash
# Apri monitor seriale (115200 baud)
idf.py monitor

# Oppure con minicom/screen
screen /dev/ttyUSB0 115200
```

Dalla console del device impostare manualmente l'URL WebSocket.

---

## Step 4 — Test handshake

Dopo 1.2 + 1.3 + 1.4 completati e SSL attivo:

1. Avvia il gateway OpenClaw sulla VM
2. Accendi il BOX-3
3. Sul log del gateway verificare:
   ```
   [xiaozhi] device connected: <device-id>
   [xiaozhi] hello received, session_id assigned
   ```
4. Sul display del BOX-3 deve apparire l'emoji di idle (es. 😐)

---

## Step 5 — Test audio round-trip

Dopo Fase 2 completa (audio pipeline):

1. Pronuncia la wake word (default: "你好小智" oppure configurabile)
2. Parla una frase
3. Verifica sul log: `[xiaozhi] STT: "<testo trascritto>"`
4. L'agente risponde
5. Il BOX-3 riproduce la risposta via TTS

---

## Riferimenti

- Firmware XiaoZhi: https://github.com/78/xiaozhi-esp32
- Web flasher: https://xiaozhi.me/flash
- Protocollo WS: https://github.com/78/xiaozhi-esp32/blob/main/docs/websocket.md
- OTA protocol: configurato in `extensions/xiaozhi/src/ota.ts`
- Piano SSL: `Note/plans/2026-02-16-ssl-setup.md` (da creare)
