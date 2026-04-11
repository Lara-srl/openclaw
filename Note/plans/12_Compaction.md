# 12 — Compaction proattiva per Xiaozhi + Mistral

## Scope e non obiettivi

**Questo piano risolve:** compaction mai scattata sulla sessione xiaozhi perché `runEmbeddedPiAgent()` bypassa il path auto-reply e quindi nessun trigger nativo (pruning cache-ttl, memory flush, compaction auto) viene attivato. Risultato verificato: sessione `42a93d39-9cae-4672-84de-37a9d381acfe.jsonl` da 38K token, 150 turni Mistral, cresce all'infinito.

**Questo piano NON risolve:**

- `/compact` manuale che fallisce con "no real conversation messages to summarize" su sessioni vuote — è il safeguard di `src/agents/pi-extensions/compaction-safeguard.ts:198-202` che fa correttamente il suo lavoro, non è un bug.
- Display `?/128k` nel main UI quando il runtime cache non popola `session.totalTokens` — gap tra persistenza JSONL (dove `message.usage.totalTokens` esiste) e cache runtime. Bug separato, da aprire come task diverso.
- Compaction automatica su altri messaging channel (telegram, discord, whatsapp) — quelli già passano dal path auto-reply.

## Problema

La voice pipeline xiaozhi chiama `runEmbeddedPiAgent()` direttamente (`extensions/xiaozhi/src/audio-pipeline.ts:742`), bypassando completamente il path auto-reply (`src/auto-reply/reply/agent-runner.ts`).

| Meccanismo          | Auto-reply path            | Xiaozhi path             |
| ------------------- | -------------------------- | ------------------------ |
| Memory flush        | `runMemoryFlushIfNeeded()` | **MAI chiamato**         |
| Compaction tracking | `onAgentEvent` callback    | **MAI passato**          |
| Pruning (cache-ttl) | Solo Anthropic (whitelist) | **Bloccato per Mistral** |

Con Mistral (128K window) + messaggi vocali corti → la sessione cresce all'infinito (38K token, 566 righe).

## Analisi documentazione ufficiale

### Pruning (https://docs.openclaw.ai/concepts/session-pruning)

- Rimuove tool results vecchi in-memory (lossless, temporaneo)
- Docs: abilitabile per non-Anthropic via `contextPruning: { mode: "cache-ttl", ttl: "5m" }`
- **Codice blocca** in `src/agents/pi-embedded-runner/cache-ttl.ts:11`:
  ```typescript
  const CACHE_TTL_NATIVE_PROVIDERS = new Set(["anthropic", "moonshot", "zai"]);
  ```
- `isCacheTtlEligibleProvider()` è l'unico gate, NO bypass

### Compaction (https://docs.openclaw.ai/concepts/compaction)

- Riassume messaggi vecchi in sommario (lossy, permanente)
- Trigger: **solo** overflow error o `/compact` manuale
- Config: `mode`, `model`, `maxHistoryShare`, `reserveTokens`, `notifyUser`, `identifierPolicy`
- Plugin hooks: `before_compaction`/`after_compaction` (notifiche, non trigger)
- **Nessun trigger proattivo nativo**

### Memory (https://docs.openclaw.ai/concepts/memory)

- File Markdown (`MEMORY.md`, `memory/YYYY-MM-DD.md`)
- Memory flush: turno silenzioso **pre-compaction** — salva fatti importanti prima del summarize
- **Dipende dalla compaction** → se compaction non scatta, flush non scatta

## Approccio: Doppio trigger per compaction nativa

Chiamare `compactEmbeddedPiSession()` (stessa funzione di `/compact`) dal path xiaozhi. Due trigger combinati, entrambi **post-response** (mai prima della risposta vocale).

### Trigger A — Notturno (principale, proattivo)

Timer interno a `context-manager.ts` che alle 3:00 (configurabile) chiama compaction se `totalTokens > minTokensForNightlyCompact` (configurabile, default: 8000).

- Semplice `setTimeout` ricalcolato ogni giorno
- Gira quando nessuno usa il device → **zero impatto UX**
- Tiene le sessioni snelle ogni mattina → meno token di input per turno = risparmio costi
- Se gateway spento alle 3:00 → niente, Trigger B copre

### Trigger B — Soglia token (safety net, post-response)

**Dopo** ogni risposta vocale (fire-and-forget), se `totalTokens > thresholdTokens` (configurabile, default: 64K) → compatta in background.

- Scatta solo in caso di uso intenso che supera la soglia in un singolo giorno
- **Mai prima della risposta** — l'utente riceve la risposta vocale normalmente, poi la compaction gira in background
- Se fallisce, il prossimo turno riprova

Entrambi: memory flush prima della compaction per salvare memorie.

### Feedback visivo sul device

Durante la compaction, il device mostra un messaggio sullo schermo via `buildLlm()`:

- **Inizio**: `🔄 Sto organizzando i ricordi...` (emotion: `"neutral"`)
- **Fine OK**: `✅ Ricordi organizzati!` (emotion: `"happy"`)
- **Fine errore**: niente (silenzioso, solo log server-side)

Solo schermo, niente voce TTS — la compaction deve restare silenziosa.
Richiede accesso al WS dal context-manager (passato come parametro).

### Perché post-response e non pre-response

La compaction richiede 1-2 roundtrip LLM (memory flush + summary = 10-30s ciascuno con Mistral).
Se gira PRIMA della risposta → l'utente aspetta 30-60s extra su quel turno. Inaccettabile per un device vocale.
Post-response: l'utente ha già ricevuto la risposta, la compaction gira silenziosamente in background.

### Cosa NON fare

- ❌ Aggiungere `"mistral"` alla whitelist cache-ttl (no prompt-cache API)
- ❌ Routare xiaozhi via auto-reply (coupling: FollowupRun, TemplateContext, typing)
- ❌ Reimplementare compaction da zero
- ❌ Compaction **prima** della risposta vocale (latenza inaccettabile)

### Cosa fare

- ✅ Esportare `compactEmbeddedPiSession` + memory flush primitives via `extensionAPI.ts`
- ✅ Creare `context-manager.ts` che chiama compaction nativa proattivamente
- ✅ Wiring in `audio-pipeline.ts` **dopo** la risposta vocale (fire-and-forget)
- ✅ Tutte le soglie configurabili via `openclaw.json`

## File da modificare

### 1. `src/extensionAPI.ts` — re-export (~8 righe)

```typescript
// Compaction nativa
export { compactEmbeddedPiSession } from "./agents/pi-embedded-runner.js";
export type {
  CompactEmbeddedPiSessionParams,
  EmbeddedPiCompactResult,
} from "./agents/pi-embedded-runner/compact.js";

// Memory flush primitives
export {
  shouldRunMemoryFlush,
  resolveMemoryFlushSettings,
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushPromptForRun,
} from "./auto-reply/reply/memory-flush.js";

// Session updates
export { incrementCompactionCount } from "./auto-reply/reply/session-updates.js";
```

### 2. `extensions/xiaozhi/src/core-bridge.ts` — estendere CoreAgentDeps

- Aggiungere: `compactEmbeddedPiSession`, `shouldRunMemoryFlush`, `resolveMemoryFlushSettings`, `resolveMemoryFlushContextWindowTokens`, `resolveMemoryFlushPromptForRun`, `incrementCompactionCount`
- Aggiungere `onAgentEvent` ai parametri di `runEmbeddedPiAgent`

### 3. `extensions/xiaozhi/src/context-manager.ts` — NUOVO FILE (~180 LOC)

**Sorgente di verità per il conteggio token**

`sessionEntry.totalTokens` dal runtime cache è `null` anche dopo conversazioni reali (verificato con context breakdown `source=run` → `session.totalTokens: null`). Il dato affidabile è nel JSONL: ogni entry `{type:"message", message.role:"assistant"}` contiene `message.usage.totalTokens` popolato correttamente sia per Anthropic che per Mistral (verificato su `42a93d39.jsonl`: 20233 → 20275 → ... crescita reale).

**`readLatestSessionTokens(sessionFile: string): Promise<number>`** — helper:

1. `fs.stat(sessionFile)` per dimensione
2. Legge solo gli ultimi 16 KB del file (`HANDLE_TAIL = 16 * 1024`) — basta ampiamente per contenere l'ultima entry
3. Splitta per `\n`, scansione all'indietro
4. Prima linea valida con `.type === "message"`, `.message.role === "assistant"`, `.message.usage?.totalTokens > 0` → ritorna quel valore
5. Nessun match → ritorna `0` (sessione nuova o solo turni user/tool)
6. try/catch → ritorna `0` su qualsiasi errore I/O (sessione sarà considerata sotto soglia, skip compaction)

**State locale** (module-level, in `context-manager.ts`):

- `lastCompactedAt: Map<string, number>` — debounce per evitare compaction loop quando il JSONL post-compact mantiene ancora la vecchia last-assistant-entry fino al prossimo turno utente
- `COMPACTION_DEBOUNCE_MS = 10 * 60 * 1000` (10 minuti)

**`maybeCompactSession(params)`** (chiamata post-response + nightly):

1. Runtime guard: `typeof deps.compactEmbeddedPiSession !== "function"` → skip
2. **Debounce**: se `Date.now() - (lastCompactedAt.get(sessionKey) ?? 0) < COMPACTION_DEBOUNCE_MS` → skip
3. `const tokens = await readLatestSessionTokens(sessionFile)`
4. Accetta `minTokens` come parametro (soglia configurabile dal chiamante)
5. Se `tokens < minTokens` → return
6. **Feedback schermo**: se `ws` aperto → `buildLlm("🔄 Sto organizzando i ricordi...", "neutral")`
7. **Memory flush** (se `shouldRunMemoryFlush()` = true):
   - `deps.runEmbeddedPiAgent()` con prompt flush (salva memorie)
   - NON passa `buildExtraSystemPrompt()` (regole voce non vanno nel flush)
8. **Compaction nativa**:
   - `deps.compactEmbeddedPiSession({ sessionId, sessionKey, messageProvider: "xiaozhi", sessionFile, workspaceDir, agentDir, config, provider, model, thinkLevel, trigger: "manual", senderIsOwner: true })`
9. Se ok → `incrementCompactionCount()` + `lastCompactedAt.set(sessionKey, Date.now())`
10. **Feedback schermo**: se `ws` aperto → `buildLlm("✅ Ricordi organizzati!", "happy")`
11. try/catch — fallimento **MAI** blocca voice pipeline (niente feedback schermo su errore)
12. Log: `[xiaozhi:context-manager] tokens=N threshold=M outcome=...`

Parametro `ws?: WebSocket` opzionale — se non passato o chiuso, skip feedback schermo.

**Esempio implementazione `readLatestSessionTokens`:**

```ts
const HANDLE_TAIL = 16 * 1024; // 16 KB basta per ultimo entry JSONL

async function readLatestSessionTokens(sessionFile: string): Promise<number> {
  try {
    const stat = await fs.stat(sessionFile);
    if (stat.size === 0) return 0;
    const start = Math.max(0, stat.size - HANDLE_TAIL);
    const buf = Buffer.alloc(stat.size - start);
    const fd = await fs.open(sessionFile, "r");
    try {
      await fd.read(buf, 0, buf.length, start);
    } finally {
      await fd.close();
    }
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          typeof entry.message?.usage?.totalTokens === "number" &&
          entry.message.usage.totalTokens > 0
        ) {
          return entry.message.usage.totalTokens;
        }
      } catch {
        // linea troncata (possibile se siamo finiti a metà di una riga): ignora
      }
    }
    return 0;
  } catch {
    return 0;
  }
}
```

**`scheduleNightlyCompaction()`** (init bridge):

1. Calcola ms fino all'ora configurata (default 3:00, timezone da config, default `Europe/Rome`)
2. `setTimeout` → `maybeCompactSession(minTokens=nightlyMinTokens)` → rischedula per il giorno dopo
3. Se gateway spento all'ora → niente, Trigger B (safety net) copre
4. Log: `[xiaozhi:context-manager] nightly compaction scheduled for HH:MM`

**`stopNightlyCompaction()`**: `clearTimeout()` su bridge disconnect

**Config xiaozhi (tutte configurabili in `openclaw.json` → `extensions.xiaozhi`):**

- `compaction.enabled`: true (default) — abilita/disabilita tutto
- `compaction.nightly.enabled`: true (default) — abilita/disabilita solo il notturno
- `compaction.nightly.hour`: 3 (0-23) — ora locale della compaction notturna
- `compaction.nightly.minTokens`: 8000 — soglia minima per compattare di notte
- `compaction.nightly.timezone`: "Europe/Rome" — timezone per il calcolo dell'ora
- `compaction.threshold.enabled`: true (default) — abilita/disabilita solo il safety net
- `compaction.threshold.maxTokens`: 65536 — soglia token per safety net post-response

### 4. `extensions/xiaozhi/src/audio-pipeline.ts` — wiring in `runAgent()`

- **Dopo** `deps.runEmbeddedPiAgent()` (~riga 766): fire-and-forget `maybeCompactSession(minTokens=thresholdMaxTokens)`
- La compaction gira in background dopo che la risposta è stata inviata
- Il `void` keyword evita unhandled promise rejection (try/catch interno a `maybeCompactSession`)

## Flusso risultante

```
Bridge.init()
  └─ scheduleNightlyCompaction()                          ← TRIGGER A (3:00, principale)
       └─ setTimeout → maybeCompactSession(minTokens=8K)
            ├─ 📱 schermo: "🔄 Sto organizzando i ricordi..."
            ├─ memory flush (salva memorie)
            ├─ compactEmbeddedPiSession()
            ├─ 📱 schermo: "✅ Ricordi organizzati!"
            └─ rischedula per domani

AudioPipeline.runAgent()
  │
  ├─ 1. routeToInstant() / hasToolIntent()                ← ESISTENTE
  │
  ├─ 2. deps.runEmbeddedPiAgent({...})                    ← ESISTENTE (risposta vocale)
  │
  ├─ 3. speak TTS → utente riceve risposta                ← ESISTENTE
  │
  └─ 4. fire-and-forget:                                  ← TRIGGER B (safety net)
        void maybeCompactSession(minTokens=64K)
              ├─ totalTokens > 64K? → compact (+ feedback schermo)
              └─ totalTokens < 64K? → niente (99%)

Bridge.disconnect()
  └─ stopNightlyCompaction()                              ← CLEANUP
```

## Configurazione

### Config xiaozhi (tutte configurabili in `openclaw.json` → `extensions.xiaozhi`)

| Config key                       | Default         | Effetto                                                         |
| -------------------------------- | --------------- | --------------------------------------------------------------- |
| `compaction.enabled`             | `true`          | Master switch: abilita/disabilita tutta la compaction proattiva |
| `compaction.nightly.enabled`     | `true`          | Abilita/disabilita solo il trigger notturno                     |
| `compaction.nightly.hour`        | `3`             | Ora locale della compaction notturna (0-23)                     |
| `compaction.nightly.minTokens`   | `8000`          | Soglia minima: compatta solo se sessione > N token              |
| `compaction.nightly.timezone`    | `"Europe/Rome"` | Timezone per il calcolo dell'ora                                |
| `compaction.threshold.enabled`   | `true`          | Abilita/disabilita solo il safety net post-response             |
| `compaction.threshold.maxTokens` | `65536`         | Soglia token per il safety net (default ~50% di 128K)           |

### Config core OpenClaw (riusate, non nuove)

| Config key                                                   | Default         | Effetto                             |
| ------------------------------------------------------------ | --------------- | ----------------------------------- |
| `agents.defaults.compaction.memoryFlush.enabled`             | `true`          | Memory flush prima della compaction |
| `agents.defaults.compaction.memoryFlush.softThresholdTokens` | `4000`          | Margine per flush anticipato        |
| `agents.defaults.compaction.mode`                            | `"safeguard"`   | Strategia compaction                |
| `agents.defaults.compaction.model`                           | (agent's model) | Modello usato per summarization     |

### Esempio config `openclaw.json`

```json
{
  "extensions": {
    "xiaozhi": {
      "compaction": {
        "enabled": true,
        "nightly": {
          "enabled": true,
          "hour": 3,
          "minTokens": 8000,
          "timezone": "Europe/Rome"
        },
        "threshold": {
          "enabled": true,
          "maxTokens": 65536
        }
      }
    }
  }
}
```

### Soglie esempio

| threshold.maxTokens | Compaction scatta a | ~Turni vocali prima del safety net                |
| ------------------- | ------------------- | ------------------------------------------------- |
| 65536 (default)     | 64K token           | ~300-500 (raramente raggiunto con nightly attivo) |
| 40000               | 40K token           | ~150-200                                          |
| 25000               | 25K token           | ~100-150                                          |

Con il trigger notturno attivo, il safety net scatta quasi mai — la sessione viene pulita ogni notte.

## Ordine implementazione

1. Re-export in `extensionAPI.ts` → `pnpm build` → zero behavior change
2. Estendere `CoreAgentDeps` in `core-bridge.ts` (type-only)
3. Creare `context-manager.ts` (~150 LOC)
4. Wiring in `audio-pipeline.ts`: post-response fire-and-forget compaction
5. Wiring in `bridge.ts`: schedule/stop nightly compaction
6. Smoke test su device

## Rischi e mitigazioni

| Rischio                                                                                      | Mitigazione                                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compaction blocca risposta vocale                                                            | **Post-response**: gira DOPO la risposta, fire-and-forget                                                                                                      |
| Latenza percepita dall'utente                                                                | **Zero**: compaction in background, utente ha già ricevuto risposta                                                                                            |
| `CoreAgentDeps` type drift con dist/                                                         | Runtime guard → skip silenzioso                                                                                                                                |
| Compaction/flush fallisce                                                                    | try/catch totale, log e return silenzioso                                                                                                                      |
| Race condition: nuovo turno durante compaction background                                    | Session write lock interno a `compactEmbeddedPiSession` serializza                                                                                             |
| Session store stale dopo compact                                                             | Aggiorna in-memory + disco via `incrementCompactionCount`                                                                                                      |
| Voice extra-system-prompt nel flush                                                          | NON passato al flush (solo core systemPrompt)                                                                                                                  |
| setTimeout notturno perso dopo restart gateway                                               | Trigger B (safety net) copre; setTimeout si rischedula al prossimo avvio                                                                                       |
| Compaction notturna su sessione quasi vuota                                                  | Soglia `nightly.minTokens` (default 8K) previene compaction inutili                                                                                            |
| `sessionEntry.totalTokens` vale `null` nel runtime cache                                     | **Risolto**: leggiamo direttamente l'ultimo turno del JSONL (`readLatestSessionTokens`) — fonte di verità persistente, niente state in-memory da sincronizzare |
| JSONL post-compact mantiene ancora la vecchia entry fino al prossimo turno → compaction loop | **Debounce 10 min** via `lastCompactedAt` Map — skip silenzioso se l'ultima compaction è recente                                                               |
| Race lettura JSONL mentre runner scrive                                                      | `maybeCompactSession` chiamata **post** `runEmbeddedPiAgent.then()` → turno già persistito, file stabile                                                       |
| File JSONL cresciuto a decine di MB (caso estremo)                                           | Reverse-scan legge solo ultimi 16 KB via `fs.open + fd.read` → lettura costante O(1) indipendente dalla dimensione                                             |
| Linea JSONL troncata a metà nei 16 KB di coda                                                | try/catch su `JSON.parse` → linea saltata, continua scan all'indietro                                                                                          |

## Verifica

### Test funzionale (Trigger B — soglia post-response)

1. Abbassare temporaneamente `compaction.threshold.maxTokens` a un valore basso (es. `5000`) in `openclaw.json`
2. Avviare gateway Mistral, parlare al device finché la sessione xiaozhi supera 5K token
3. Log atteso sul turno che supera la soglia:
   ```
   [xiaozhi:context-manager] tokens=5234 threshold=5000 outcome=compacting
   [xiaozhi:context-manager] memory flush start
   [xiaozhi:context-manager] memory flush completed
   [xiaozhi:context-manager] compaction start
   [xiaozhi:context-manager] compaction completed
   ```
4. Device mostra sullo schermo: `🔄 Sto organizzando i ricordi...` → `✅ Ricordi organizzati!`
5. Turni successivi: `tokens=~2000 threshold=5000 outcome=skip` (post-compact l'ultimo assistant turn riflette la nuova dimensione)
6. Debounce: nello stesso turno immediatamente dopo, anche se il JSONL non ha ancora aggiornato, skip silenzioso per 10 min
7. `~/.openclaw/workspace/memory/YYYY-MM-DD.md` creato/aggiornato dal flush

### Test Trigger A (nightly)

1. Impostare `compaction.nightly.hour` all'ora locale corrente + 2 minuti
2. Assicurarsi che la sessione abbia `>= nightly.minTokens` (default 8K)
3. Log atteso allo scoccare:
   ```
   [xiaozhi:context-manager] nightly compaction scheduled for HH:MM
   [xiaozhi:context-manager] nightly tick tokens=XXXXX threshold=8000 outcome=compacting
   ```
4. Dopo 24h: log rischedulazione per il giorno successivo

### Sanity check — non regressione

- Sessione **nuova** (0 turni): `readLatestSessionTokens` ritorna 0 → skip compaction, niente log di errore
- Fallimento `compactEmbeddedPiSession` (es. API key mancante): voice pipeline risponde normalmente al turno successivo, niente crash
- Gateway spento durante `maybeCompactSession` fire-and-forget: nessun trace orfano (promise `void` + try/catch interno)
- `/compact` manuale da UI main continua a funzionare come prima (Plan 12 tocca solo il path xiaozhi)

## Riferimenti codice

| File                                               | Righe           | Cosa fa                                                                                                                                           |
| -------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/pi-embedded-runner/compact.ts`         | 88-125, 247-761 | `CompactEmbeddedPiSessionParams`, `compactEmbeddedPiSessionDirect()`                                                                              |
| `src/agents/pi-embedded-runner.ts`                 | 2               | Re-export `compactEmbeddedPiSession`                                                                                                              |
| `src/agents/pi-extensions/compaction-safeguard.ts` | 198-202         | Safeguard "no real conversation messages" (spiega perché `/compact` manuale su sessioni vuote viene rifiutato — corretto, fuori scope di Plan 12) |
| `src/auto-reply/reply/memory-flush.ts`             | 113-144         | `shouldRunMemoryFlush()` threshold logic                                                                                                          |
| `src/auto-reply/reply/agent-runner-memory.ts`      | 27-172          | `runMemoryFlushIfNeeded()` execution                                                                                                              |
| `src/auto-reply/reply/commands-compact.ts`         | 47-144          | `/compact` handler (reference implementation)                                                                                                     |
| `src/auto-reply/reply/session-updates.ts`          | -               | `incrementCompactionCount()`                                                                                                                      |
| `src/agents/pi-embedded-runner/cache-ttl.ts`       | 11              | Provider whitelist (NON toccare)                                                                                                                  |
| `src/config/zod-schema.agent-defaults.ts`          | 80-98           | Schema config compaction                                                                                                                          |
| `extensions/xiaozhi/src/audio-pipeline.ts`         | 675-794         | `runAgent()` — punto integrazione                                                                                                                 |
| `extensions/xiaozhi/src/core-bridge.ts`            | -               | `CoreAgentDeps` type                                                                                                                              |

## Evidenze raccolte (contesto implementativo)

- **Sessione xiaozhi "zombie"**: `~/.openclaw/agents/main/sessions/42a93d39-9cae-4672-84de-37a9d381acfe.jsonl` — 570 righe dal 28 marzo, 150 turni Mistral + 90 Anthropic, `message.usage.totalTokens` cresce 20233 → 20497 su dialoghi brevi, mai compattata.
- **Runtime cache vuota**: `session.totalTokens: null` nel context breakdown `source=run` anche dopo conversazione reale → **non usare** `sessionEntry.totalTokens` come fonte, leggere dal JSONL.
- **`/compact` manuale** fallisce con `Compaction safeguard: cancelling compaction with no real conversation messages to summarize` su sessioni che contengono solo output di slash commands (es. `4e5ee7af-...`, 9 entry tutte `role=assistant` da `/context`/`/compact`). Comportamento corretto, non toccare.
- **`usage.totalTokens` popolato sia per Anthropic che Mistral**: verificato su `42a93d39.jsonl` — entrambi i provider scrivono il campo correttamente nel JSONL. L'approccio "leggi ultimo turno JSONL" funziona identico per i due stack.
