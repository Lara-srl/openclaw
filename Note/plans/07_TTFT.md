# Piano TTFT — XiaoZhi Context Router

> Data: 2026-04-01
> Obiettivo: ridurre il Time To First Token (TTFT) eliminando token inutili per il canale vocale.

---

## Problema

Ogni call vocale XiaoZhi ricostruisce il contesto da zero (Mistral non ha prompt caching).

| Componente                               | Token tipici     |
| ---------------------------------------- | ---------------- |
| System Prompt (full)                     | ~3.000           |
| Context Files (SOUL, AGENTS, MEMORY)     | 0–1.000          |
| Tool descriptions (WhatsApp + gog + MCP) | ~300–500         |
| Session history (1–3 turns)              | 250–750          |
| User prompt (STT)                        | ~100             |
| **Totale tipico**                        | **~3.600–5.100** |

Il system prompt `full` include sezioni pensate per chatbot testuale multi-canale (Telegram, Discord, Slack) che per XiaoZhi sono 100% inutili e pesano ~800–1.000 token.

---

## Soluzione: 3 livelli + Voice Profile

### Voice Profile (sempre attivo) questo è il nuovo context

Nuova modalità `promptMode: "voice"` in `src/agents/system-prompt.ts`.

**Rimuove** (sezioni irrilevanti per voce):

| Sezione                                     | Risparmio                        |
| ------------------------------------------- | -------------------------------- |
| Reply Tags (`[REPLY]`, `[TOOL]`, …)         | ~300 ch                          |
| Messaging Section (routing canali)          | ~600 ch                          |
| Model Aliases                               | ~200 ch                          |
| Self-Update (gateway restart, config.apply) | ~300 ch                          |
| Docs path                                   | ~200 ch                          |
| Heartbeats                                  | ~200 ch                          |
| **Totale**                                  | **~1.800 ch / ~800–1.000 token** |

**Mantiene sempre** (identità + funzionalità vocale):

- SOUL.md, AGENTS.md, MEMORY.md — iniettati come `contextFiles`, non toccati da `promptMode`
- Conversazione (storia JSONL) — caricata da `SessionManager`, separata dal system prompt
- Tool descriptions — gestite da `disableTools`, non da `promptMode`
- Silent Replies — utile anche per voce (LLM sa che può non rispondere)
- Safety, Skills, Workspace, Runtime

> Memory hints: già vuota per XiaoZhi (nessun tool `memory_search`/`memory_get` attivo) — irrilevante.

---

### Livello 0 — Instant (bypass LLM totale)

**Dove**: `audio-pipeline.ts`, dopo STT (riga ~243), prima di `runAgent()`.

**Come**: funzione `routeToInstant(text): string | null` — regex su testo normalizzato (lowercase, no punteggiatura).

**Pattern italiani (esempi)**:

| Pattern                                           | Risposta                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `ciao`, `salve`, `buongiorno`, `ehi`              | "Ciao! Come posso aiutarti?"                                           |
| `grazie`, `ok grazie`, `perfetto`, `ottimo`       | "Prego!"                                                               |
| `che ore sono`, `che ora è`                       | ora da `new Date()`                                                    |
| `che giorno è`, `che data è`                      | data da `new Date()`                                                   |
| `stop`, `basta`, `arrivederci`, `a dopo`          | "A presto!"                                                            |
| `come stai`, `tutto bene`                         | risposta fissa                                                         |
| `Come ti chiami`, `qual'è il tuo nome`, `chi sei` | Sono Lara Un'entita ditale con un corpo fisico , e tu come ti chiami ? |
| `Cosa Fai`, `Scopo`, `Finalità`                   | Portò L'IA a portata di mano, tu invece che cosa fai?                  |

**Nessuna dipendenza aggiuntiva.** TTFT: < 10ms.
Copertura stimata: ~20–25% query quotidiane.

---

### Livello 1 — Conversation (LLM senza tool)

**Dove**: `audio-pipeline.ts`, router regex prima di `runAgent()`.

**Come**: passa `disableTools: true` a `runEmbeddedPiAgent()`.
Il param esiste già in `RunEmbeddedPiAgentParams` (`params.ts:71`).
In `attempt.ts:335`: `const toolsRaw = params.disableTools ? [] : createOpenClawCodingTools({...})`

**Routing**: query senza keyword di tool-intent → conversation.

Keyword tool-intent (italiane) che mandano a `tools_full`:

```
cerca / trova / google / cerca su internet
manda / scrivi / invia / messaggio
leggi / apri / mostra il file / cartella
ricorda / salva / segna / aggiungi
calendario / promemoria / svegliami / ricordami
esegui / lancia / avvia / apri l'app
scatta / foto / fai una foto
```

Tutto il resto (domande, spiegazioni, conversazione) → `disableTools: true`.

**Risparmio**: ~300–500 token (tool descriptions WhatsApp + gog + MCP device).
Copertura stimata: ~50% query quotidiane.

---

### Livello 2 — Tools Full (comportamento attuale + Voice Profile)

Tutte le query con tool-intent rilevato → `disableTools: false`.
Solo Voice Profile attivo (sempre).

**Tool attivi** (stack attuale):

| Gruppo       | Tool                               | Char stimati   |
| ------------ | ---------------------------------- | -------------- |
| WhatsApp     | `message`                          | ~150           |
| Google Suite | gog (3–5 tool)                     | ~400–600       |
| MCP device   | parla, ascolta, scatta foto, vibra | ~200–300       |
| **Totale**   |                                    | **~750–1.050** |

> Tool subset discrimination non implementato: con soli ~1.000 ch di tool descriptions il risparmio per subset è marginale (~200–300 token). Rivalutare dopo MVP.

---

## Flusso finale

```
Audio → STT → testo
                │
                ├─ routeToInstant(text)?
                │     └─ sì → risposta locale, silentAck, stop   (<10ms)
                │
                ├─ hasToolIntent(text)?
                │     ├─ no  → runAgent(disableTools:true,  promptMode:"voice")
                │     └─ sì  → runAgent(disableTools:false, promptMode:"voice")
                │
                └─ (voice profile sempre attivo in entrambi i casi)
```

---

## Token input stimati post-ottimizzazione

| Livello             | Token input      | TTFT stimato   | % query |
| ------------------- | ---------------- | -------------- | ------- |
| instant             | 0 (bypass)       | < 10ms         | ~25%    |
| conversation        | ~1.800–2.500     | ~100–200ms     | ~50%    |
| tools_full          | ~2.100–3.000     | ~150–250ms     | ~25%    |
| **oggi (baseline)** | **~3.600–5.100** | **~300–600ms** | 100%    |

---

## File da modificare

| File                                          | Modifica                                                            |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `src/agents/system-prompt.ts`                 | Aggiunge `promptMode: "voice"` con sezioni rimosse custom           |
| `src/agents/pi-embedded-runner/run/params.ts` | Nessuna modifica — `disableTools` già presente                      |
| `extensions/xiaozhi/src/audio-pipeline.ts`    | `routeToInstant()` + `hasToolIntent()` + passa `promptMode:"voice"` |

---

## Sequenza implementazione

1. **Voice Profile** — `promptMode:"voice"` in `system-prompt.ts` + passaggio da `audio-pipeline.ts`
2. **Instant** — `routeToInstant()` in `audio-pipeline.ts` (~50 righe, zero dipendenze)
3. **Conversation router** — `hasToolIntent()` + `disableTools` (~30 righe)
