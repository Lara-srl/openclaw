# Piano: 99_hosted_gateway — Gateway Hosted Multi-Tenant su Scaleway

> Creato: 2026-03-29
>
> **Obiettivo**: OpenClaw hosted as-a-service su Scaleway Paris.
> Un container Docker per utente → isolamento totale, MVP in <1 settimana di lavoro.

---

## Architettura target (MVP)

```
Scaleway DEV1-L (Paris, €30/mese)
├── nginx (reverse proxy + SSL via Let's Encrypt)
├── Per ogni utente:
│   ├── container openclaw-gateway (Node 22, porta dinamica)
│   └── volume /data/users/<user-id>/.openclaw/
├── script provisioning (bash, crea utente on-demand)
└── Stripe webhook → trigger provisioning automatico
```

**Sizing**: 50 utenti × ~100MB RAM = ~5GB → dentro DEV1-L (8GB RAM).

---

## Stack completo

| Layer     | Tecnologia               | Note                                        |
| --------- | ------------------------ | ------------------------------------------- |
| VM        | Scaleway DEV1-L, Paris   | €30/mese, 8GB RAM, 4 vCPU                   |
| AI        | Mistral API (Parigi)     | STT + LLM + TTS, <5ms rete                  |
| Container | Docker + docker-compose  | 1 container per utente                      |
| Proxy     | nginx + certbot          | SSL, routing per subdomain o porta          |
| Pagamenti | Stripe                   | subscription €12/mese, webhook provisioning |
| Device    | SenseCAP Watcher XiaoZhi | firmware pre-flashato, WiFi AP mode         |

---

## Costi per utente/mese

| Voce                                 | Costo           |
| ------------------------------------ | --------------- |
| VM Scaleway (quota 50 utenti)        | €0.60           |
| Mistral API (STT+LLM+TTS, uso medio) | €1.00-1.50      |
| **Totale infra**                     | **~€2/utente**  |
| Abbonamento utente                   | €12/mese        |
| **Margine**                          | **~€10/utente** |

Break-even VM: **3 utenti**. A 50 utenti: ~€500/mese margine.

---

## Roadmap implementazione

### Fase 1 — Dockerfile (1 giorno)

Creare `docker/gateway/Dockerfile`:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY dist/ ./dist/
EXPOSE 18789
CMD ["node", "dist/cli/index.js", "gateway", "run", "--bind", "loopback", "--port", "18789", "--force"]
```

`docker/gateway/docker-compose.template.yml`:

```yaml
services:
  gateway:
    image: openclaw-gateway:latest
    restart: unless-stopped
    ports:
      - "${PORT}:18789"
    volumes:
      - /data/users/${USER_ID}/.openclaw:/root/.openclaw
    environment:
      - MISTRAL_API_KEY=${MISTRAL_API_KEY}
```

### Fase 2 — Script provisioning utente (1 giorno)

`scripts/provision-user.sh <user-id> <port> <channel> <channel-token>`:

1. Crea `/data/users/<user-id>/.openclaw/`
2. Genera `openclaw.json` con config Mistral + canale
3. Avvia container docker-compose
4. Configura nginx per routing
5. Stampa URL gateway per il device

### Fase 3 — WiFi provisioning device (da verificare)

XiaoZhi supporta **WiFi AP mode** per configurazione iniziale:

- Device in modalità AP → utente si connette con phone
- Inserisce SSID + password WiFi
- Inserisce URL gateway (`wss://gateway.laragoci.eu/<user-id>`)
- Device si riconnette e funziona

**Da verificare**: se XiaoZhi AP mode supporta campo custom per WS URL, o se serve
re-flash con URL hardcoded per ogni utente. Vedi firmware `menuconfig`.

### Fase 4 — Stripe + webhook (1 giorno)

Flow:

```
Utente paga su laragoci.eu (Stripe Checkout)
→ webhook POST /provision
→ script provision-user.sh
→ email utente con istruzioni WiFi provisioning
```

### Fase 5 — Dashboard minima (opzionale MVP)

- Status container (up/down)
- Restart gateway
- Tail logs ultimi 50 messaggi
- Cambio canale (WhatsApp → Telegram)

---

## Onboarding utente finale (target)

1. Acquista device + abbonamento su laragoci.eu (Stripe)
2. Riceve email con link setup
3. Accende device → compare rete WiFi "LaraGoci-XXXX"
4. Si connette con phone → inserisce WiFi casa + nessun altro campo
5. Device online → agente attivo su WhatsApp/Telegram del cliente
6. **Tempo totale: <10 minuti, zero terminale**

---

## Blocchi tecnici aperti

| Blocco                                | Priorità | Note                                  |
| ------------------------------------- | -------- | ------------------------------------- |
| WiFi AP mode XiaoZhi + WS URL custom  | 🔴 Alta  | Blocca onboarding zero-touch          |
| Dockerfile openclaw-gateway           | 🟡 Media | 1 giorno, straightforward             |
| Multi-tenant isolation WhatsApp creds | 🟡 Media | Ogni utente ha proprie credenziali WA |
| Script provisioning                   | 🟡 Media | Manuale ok per i primi 10 utenti      |
| Stripe webhook                        | 🟢 Bassa | Automatizzare dopo MVP manuale        |

---

## Dipendenze da altri piani

- `99_step_to_unicorn.md` — stack Mistral deve essere stabile prima
- `99_migrazione_stack_sovrano.md` — VM Scaleway, infra DNS
- Firmware XiaoZhi (AP mode WS URL) — da verificare nel repo firmware

---

## Note rollback / rischi

- **Isolamento dati**: volumi Docker separati per utente → WhatsApp sessions non condivise
- **Crash un utente**: container restart automatico (`restart: unless-stopped`)
- **Scale-up**: aggiungere VM Scaleway e distribuire utenti su più host se >100 utenti
- **GDPR**: dati su Scaleway Paris, AI su Mistral Paris → 100% EU, nessun dato fuori UE
