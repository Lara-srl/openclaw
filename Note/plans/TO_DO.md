# TO_DO — Task da implementare

> Aggiornato: 2026-03-29

---

## Cache & Costo API

### T1 — Gemini Context Caching esplicito (post-MVP)

**Problema:** `cacheRead=0` sempre — ogni chiamata vocale paga ~15k token di input intero.
Con Gemini il prompt caching non è automatico come Anthropic: va creato un "cache object" via API
con TTL minimo configurabile (1h–1 mese).

**Impatto attuale:** ~$0.09/call (input tokens) — in produzione con 50 query/giorno = ~$4.50/giorno.

**Task:**

- Creare cache object Gemini con il system prompt (workspace + VOICE_EXTRA_SYSTEM_PROMPT) all'avvio del gateway
- Passare `cachedContent` nella call LLM invece del system prompt inline
- Invalidare e ricreare il cache object se il workspace cambia
- File: `extensions/xiaozhi/src/audio-pipeline.ts` + eventuale supporto in core OpenClaw

**Riferimento:** https://ai.google.dev/gemini-api/docs/caching

---

### T2 — Session reset automatico

**Problema:** la sessione cresce durante la giornata (ogni turno aggiunge ~50-100 token alla history).
Dopo 100 turni vocali: +5-10k token extra per call → latenza crescente + risposte sempre più lunghe.

**Task:**

- Reset sessione automatico ogni N turni (es. 20) o ogni X ore (es. 4h)
- File: `extensions/xiaozhi/src/audio-pipeline.ts` → nel metodo `runAgent()`, prima di `loadSessionStore`
- Mantenere solo gli ultimi K turni invece di svuotare tutto (sliding window)

---

### T3 — Workspace trimming

**Problema:** workspace `~/.openclaw/workspace/` è ~15k token:

- `AGENTS.md` 7.8k — contiene heartbeat, group chat rules, emoji reactions: tutto non pertinente alla voce
- `USER.md`, `HEARTBEAT.md`, `TOOLS.md`: rilevanti ma gonfi

**Task (sessione dedicata — impatta tutti i canali):**

- Portare OpenClaw verso stack locale minimo: Gmail, WhatsApp, 5 MCP tools
- Rimuovere sezioni non pertinenti da AGENTS.md (group chat, heartbeat proattivo, emoji reactions)
- Target: workspace ~5k token (da 15k)

---

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
