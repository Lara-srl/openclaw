# Onboarding Device — Modalità AP e Pagina Web WiFi

> Data: 2026-03-28 — Stato: DA ANALIZZARE

---

## Osservazione

Quando il device XiaoZhi non trova il WiFi salvato, entra automaticamente in **modalità AP**
(hotspot `xiaozhi-xxxx`). L'utente si collega e configura il WiFi tramite una pagina web.

Questo è esattamente il flusso ideale per l'**onboarding** del dispositivo da parte dell'utente
finale — zero flashing, zero menuconfig.

---

## Task da fare

### 1. Analizzare la pagina web di configurazione

- A quale URL risponde? (probabilmente `192.168.4.1` o redirect automatico captive portal)
- Cosa mostra? Solo WiFi o anche altri parametri (WS server URL, device name, ecc.)?
- È possibile pre-compilare il campo **WebSocket server URL** (es. `wss://...`) durante l'onboarding?
- Screenshot / dump HTML della pagina

### 2. Analizzare il flusso AP completo

- Quanto tempo aspetta prima di entrare in AP mode se WiFi non trovato?
- Il pulsante BOOT (long press) triggera reset WiFi immediato?
- Dopo configurazione, il device si riconnette automaticamente o serve reboot?
- Cosa succede se inserisci credenziali sbagliate?

### 3. Valutare integrazione con OpenClaw onboarding

- Possibilità di mostrare QR code con le credenziali WiFi + WS URL preconfigurato
- Flusso: utente scansiona QR → si collega all'AP → pagina pre-compilata con WS URL OpenClaw
- Alternativa: istruzioni step-by-step nell'app OpenClaw per guidare la configurazione

---

## Note

- Confermato funzionante sul BOX-3 (2026-03-28, cambio ufficio)
- Firmware: XiaoZhi standard con patch hold-to-talk
- SenseCAP Watcher ha stesso firmware XiaoZhi — probabilmente stesso flusso AP
