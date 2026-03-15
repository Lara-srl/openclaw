# Feature: Progetto LaraGoci - AI Companion Device

Data: 2026-02-16
Stato: 🔄 in corso

## Obiettivo

Sviluppare LaraGoci, un AI Companion Device portatile che si connette via 4G a OpenClaw per offrire un assistente personale "sempre connesso" con integrazione Google Workspace completa.

## Vision

**LaraGoci:** Dispositivo tascabile (form factor AirPods case) che diventa il tuo assistente personale AI sempre disponibile, ovunque ti trovi.

## Concept Chiave

- **"Stupid device, smart cloud"**: Device cattura/riproduce audio, intelligenza nel cloud
- **1 utente = 1 VM OpenClaw**: Privacy e personalizzazione totale
- **Google Workspace integrato**: Calendar, Gmail, Drive per ogni utente
- **Plug & Play**: Zero configurazione utente

## Hardware Platform: ESP32-S3-BOX-3

### Scelta Development Board ✅

- **Main Board**: ESP32-S3-BOX-3 Development Board (€45-50)
- **Connectivity**: SIM7600G-H 4G+GPS module (€35-45)
- **Antenne**: LTE + GPS (€5-8)
- **Costo totale sviluppo**: ~€85-103

### Caratteristiche ESP32-S3-BOX-3 ✅

- **Audio integrato**: Microfono + speaker I2S
- **Display**: 2.4" LCD touchscreen 320x240
- **CPU**: ESP32-S3 dual-core 240MHz, 512KB RAM
- **Connettività**: WiFi + Bluetooth 5.0 LE
- **Batteria**: Integrata + ricarica USB-C
- **Sensori**: Accelerometro, giroscopio
- **Interfaccia**: Pulsanti capacitivi + touch

## Business Model

### Costi per utente/mese:

- **VM OpenClaw**: €5-10
- **Google Workspace**: €6
- **AI API**: €10-50 (dipende da uso/modello)
- **VoIP + WhatsApp**: €3-12
- **SIM 4G IoT**: €3-10
- **TOTALE**: €30-110/mese

### Hardware (una tantum):

- **Prototipo**: €85-103 (ESP32-S3-BOX-3 based)
- **Produzione finale**: €80-120 (PCB custom)

## Architettura

```
LaraGoci Device ──4G──> OpenClaw VM ──API──> AI Provider
   (ESP32-S3)            (dedicata)           (Claude/GPT)
       │                     │
       └─────WSS─────────────┴─── SSL: laragoci.lara-ai.eu
```

### Ogni utente riceve:

- ✅ **1 VM OpenClaw** dedicata (privacy isolata)
- ✅ **1 account Google Workspace** (mario123@laragoci.com)
- ✅ **1 numero VoIP WhatsApp** dedicato
- ✅ **Device pre-configurato** e testato

## Documentazione ✅

### File creati:

- **Completo**: `laragoci-project-brief.md` (10+ pagine)
- **Aggiornato**: `laragoci-project-brief-updated.md` (con ESP32-S3-BOX-3)
- **Compatto**: `laragoci-project-brief-compact.md` (2 pagine executive)
- **Location**: Google Drive /laragoci/ folder

## Roadmap Sviluppo

### 🎯 FASE 1: Prototipo ESP32-S3-BOX-3 (2-3 settimane)

- [ ] 1.1 **Ordinare hardware**: ESP32-S3-BOX-3 + SIM7600G-H + antenne
- [ ] 1.2 **Setup sviluppo**: ESP-IDF + Arduino framework
- [ ] 1.3 **Audio testing**: Mic capture + speaker playback
- [ ] 1.4 **4G connection**: SIM7600G-H via UART, test connessione
- [ ] 1.5 **WebSocket client**: WSS connection a OpenClaw
- [ ] 1.6 **Display UI**: Debug interface + status
- [ ] 1.7 **GPS testing**: Location via SIM7600G-H
- [ ] 1.8 **Power management**: Deep sleep + battery optimization

### 🎯 FASE 2: Integrazione OpenClaw (2-3 settimane)

- [ ] 2.1 **Audio endpoint**: OpenClaw riceve/invia audio via WebSocket
- [ ] 2.2 **Audio pipeline**: Capture → OpenClaw → AI → Playback
- [ ] 2.3 **VM dedicata**: Setup isolato per device
- [ ] 2.4 **Google Workspace**: Account dedicato + integration
- [ ] 2.5 **WhatsApp/VoIP**: Numero dedicato per device
- [ ] 2.6 **OTA updates**: Firmware aggiornabile da remoto
- [ ] 2.7 **End-to-end testing**: Conversazione completa funzionante

### 🎯 FASE 3: Prodotto Finale (1-2 mesi)

- [ ] 3.1 **PCB design**: Custom board basata su ESP32-S3-BOX-3 learning
- [ ] 3.2 **Case design**: Form factor AirPods case (stampa 3D)
- [ ] 3.3 **Production testing**: Batch testing e QA
- [ ] 3.4 **Business setup**: Dominio Google Workspace, scaling infrastructure
- [ ] 3.5 **Go-to-market**: Pricing, marketing, sales strategy

## Vantaggi Competitivi

### vs Alexa/Siri:

- ✅ **Portatile**: Sempre con te, non fisso a casa
- ✅ **4G always-on**: Non dipende da WiFi
- ✅ **Personalizzato**: 1 VM dedicata per utente
- ✅ **Google integrato**: Accesso completo a calendar/email/drive
- ✅ **WhatsApp nativo**: Può scriverti/chiamarti

### vs Smartphone:

- ✅ **Plug & play**: Zero configurazione
- ✅ **Voice-first**: Conversazione naturale
- ✅ **No distrazioni**: Focus su assistente, no social/games
- ✅ **Batteria dedicata**: No drain sul telefono principale

## Target Market

- **Teenager**: Primo assistente AI personale
- **Business**: Produttività, calendar, email management
- **Executive**: Luxury personal assistant premium
- **Senior**: Tecnologia semplificata, voice-first

**Price point stimato**: €200-400 device + €50-100/mese servizio

## Dipendenze

### Critiche:

- [x] **SSL/TLS OpenClaw**: Gateway deve supportare WSS per device 4G
- [ ] **Hardware procurement**: ESP32-S3-BOX-3 + SIM7600G-H ordinati
- [ ] **Google Workspace**: Account setup e automazione
- [ ] **SIM IoT**: Provider dati 4G per device

### Nice-to-have:

- [ ] **OTA framework**: Updates via 4G senza cavo
- [ ] **Multi-language**: Support lingue multiple
- [ ] **Edge AI**: Ridurre latency con processing locale

## Success Metrics

- [ ] Prototipo funzionante: conversazione end-to-end
- [ ] Latency < 2 secondi: domanda → risposta audio
- [ ] Batteria > 8 ore: Uso continuo giornata lavorativa
- [ ] 4G roaming: Funziona ovunque in EU
- [ ] Google integration: Calendar/email commands working
- [ ] Business ready: Costi chiari, pricing sostenibile

## Note

- ESP32-S3-BOX-3 accelera sviluppo ~50% (audio + display + power integrati)
- SSL/TLS prerequisito assoluto per connessioni 4G sicure
- Business model ricorrente €30-110/mese molto scalabile
- Form factor finale dovrà essere significativamente più piccolo del development board

## Rischi

- **Hardware availability**: Component shortage ESP32/SIM7600G
- **4G costs**: SIM IoT pricing scaling con volumi
- **AI API costs**: Usage spikes possono aumentare costi drasticamente
- **Regulatory**: Certificazioni CE/FCC per device commerciale
- **Competition**: Big tech (Google, Amazon, Apple) con risorse maggiori
