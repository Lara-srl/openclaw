# 12 — Compaction proattiva per Xiaozhi + Mistral

## Stato implementazione

**Branch:** `Compaction`
**Commit principali:**

- `0dde5f2f4` — feat: Plan 12 base (re-export + bridge + context-manager + audio-pipeline + bridge.ts wiring + nightly scheduler)
- `d199eecae` — feat: `memoryFlush.alwaysRun` flag + threshold default abbassato a 25K
- `e06591baf` — fix: split debounce per outcome (success=10min, cancelled=60s)

**Sintesi:** core implementazione ✅ completa, smoke test ✅ Trigger A (nightly) e ✅ Trigger B (post-response) entrambi passano. Memory flush gira e crea file in `~/.openclaw/workspace/memory/`. **Due TODO aperti** documentati in fondo (memory file overwrite + JSONL non compattato per `keepRecentTokens` Pi).

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

### ✅ Trigger A — Notturno (principale, proattivo)

Timer interno a `context-manager.ts` che alle 3:00 (configurabile) chiama compaction se `totalTokens > minTokensForNightlyCompact` (configurabile, default: 8000).

- Semplice `setTimeout` ricalcolato ogni giorno
- Gira quando nessuno usa il device → **zero impatto UX**
- Tiene le sessioni snelle ogni mattina → meno token di input per turno = risparmio costi
- Se gateway spento alle 3:00 → niente, Trigger B copre

### ✅ Trigger B — Soglia token (safety net, post-response)

**Dopo** ogni risposta vocale (fire-and-forget), se `totalTokens > thresholdTokens` (configurabile, default: **25K** — abbassato da 64K originale durante test) → compatta in background.

- Scatta solo in caso di uso intenso che supera la soglia in un singolo giorno
- **Mai prima della risposta** — l'utente riceve la risposta vocale normalmente, poi la compaction gira in background
- Se fallisce, il prossimo turno riprova

Entrambi: memory flush prima della compaction per salvare memorie.

### ✅ Feedback visivo sul device

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

## File modificati

### ✅ 1. `src/extensionAPI.ts` — re-export

Esporta `compactEmbeddedPiSession`, primitive memory flush, `incrementCompactionCount`, helper sessioni. Vedi commit `0dde5f2f4`.

```typescript
// Compaction nativa
export { compactEmbeddedPiSession } from "./agents/pi-embedded-runner.ts";
export type { CompactEmbeddedPiSessionParams } from "./agents/pi-embedded-runner/compact.ts";
export type { EmbeddedPiCompactResult } from "./agents/pi-embedded-runner/types.ts";

// Memory flush primitives
export {
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./auto-reply/reply/memory-flush.ts";

// Session updates
export { incrementCompactionCount } from "./auto-reply/reply/session-updates.ts";
```

### ✅ 2. `extensions/xiaozhi/src/core-bridge.ts` — estendere CoreAgentDeps

Aggiunti campi opzionali (runtime-checked): `compactEmbeddedPiSession`, `shouldRunMemoryFlush`, `resolveMemoryFlushSettings`, `resolveMemoryFlushContextWindowTokens`, `resolveMemoryFlushPromptForRun`, `incrementCompactionCount`. Aggiunti tipi `CoreSessionEntry`, `CoreMemoryFlushSettings`, `CoreCompactResult`. Aggiunto `onAgentEvent` callback ai parametri di `runEmbeddedPiAgent`.

### ✅ 3. `extensions/xiaozhi/src/context-manager.ts` — NUOVO FILE (~540 LOC)

**Sorgente di verità per il conteggio token**

`sessionEntry.totalTokens` dal runtime cache è `null` anche dopo conversazioni reali (verificato con context breakdown `source=run` → `session.totalTokens: null`). Il dato affidabile è nel JSONL: ogni entry `{type:"message", message.role:"assistant"}` contiene `message.usage.totalTokens` popolato correttamente sia per Anthropic che per Mistral.

**`readLatestSessionTokens(sessionFile: string): Promise<number>`** — helper:

1. `fs.stat(sessionFile)` per dimensione
2. Legge solo gli ultimi 16 KB del file (`HANDLE_TAIL = 16 * 1024`) — basta ampiamente per contenere l'ultima entry
3. Splitta per `\n`, scansione all'indietro
4. Prima linea valida con `.type === "message"`, `.message.role === "assistant"`, `.message.usage?.totalTokens > 0` → ritorna quel valore
5. Nessun match → ritorna `0` (sessione nuova o solo turni user/tool)
6. try/catch → ritorna `0` su qualsiasi errore I/O

**State locale** (module-level):

- `lastCompactedAt: Map<string, DebounceEntry>` — debounce per evitare compaction loop quando il JSONL post-compact mantiene ancora la vecchia last-assistant-entry fino al prossimo turno utente
- `COMPACTION_DEBOUNCE_SUCCESS_MS = 10 * 60 * 1000` (10 minuti) — solo dopo compaction completata
- `COMPACTION_DEBOUNCE_CANCELLED_MS = 60 * 1000` (60 secondi) — dopo cancellazione safeguard, retry rapido al prossimo turno

**`maybeCompactSession(params)`** (chiamata post-response + nightly):

1. Runtime guard: `typeof deps.compactEmbeddedPiSession !== "function"` → skip
2. **Debounce split**: se ultima compaction success è < 10min OR cancelled è < 60s → skip
3. `tokens = await readLatestSessionTokens(sessionFile)`
4. Se `tokens < minTokens` → return
5. **Feedback schermo**: `buildLlm("🔄 Sto organizzando i ricordi...", "neutral")`
6. **Memory flush** via `maybeRunMemoryFlush()` (con bypass `alwaysRun`)
7. **Compaction nativa**: `deps.compactEmbeddedPiSession({ ..., trigger: "manual", senderIsOwner: true })`
8. Se ok → `incrementCompactionCount()` + setDebounce("success") + feedback `"✅ Ricordi organizzati!"`
9. Se cancelled da safeguard → setDebounce("cancelled") con messaggio `(retry in 60s)`
10. Se errore → setDebounce("error"), nessun feedback schermo
11. try/catch totale — fallimento **MAI** blocca voice pipeline

### ✅ 4. `extensions/xiaozhi/src/audio-pipeline.ts` — wiring in `runAgent()`

**IMPORTANTE — timing bug scoperto durante test:** `runEmbeddedPiAgent()` ritorna quando l'LLM finisce di generare, ma il TTS streaming continua in parallelo via `consumeLoop`. Chiamare `maybeCompactSession` direttamente dopo `await runEmbeddedPiAgent` la fa partire **durante** il TTS streaming.

**Fix implementato:** field privato `pendingCompaction: (() => void) | null` nella classe `AudioPipeline`:

- `runAgent` salva la chiamata come closure in `this.pendingCompaction` (non la esegue)
- Dopo `buildTts("stop")` nell'outer function, consume e fire la closure
- Reset a `null` all'inizio di ogni nuovo `runAgent` per prevenire stale closures

### ✅ 5. `extensions/xiaozhi/src/bridge.ts` — wiring nightly scheduler

In `init()`: chiama `scheduleNightlyCompaction()` con resolver per `getActiveWs()` e `getSessionContext()`. In `disconnect()`: `stopNightlyCompaction()` per cleanup.

### ✅ 6. `extensions/xiaozhi/openclaw.plugin.json` — manifest schema

**IMPORTANTE — gotcha scoperta durante test:** il manifest plugin (`openclaw.plugin.json`) ha **`additionalProperties: false`** e dichiara separatamente lo schema di validazione user config. Senza dichiarare `compaction` nel `configSchema.properties`, il validator core RIFIUTA il config con `must NOT have additional properties` PRIMA che Zod abbia anche solo la possibilità di parsare. **Doppio livello di validazione: manifest JSON schema + Zod schema.** Vanno tenuti in sync.

Aggiunto sub-schema completo per `compaction` con nightly, threshold, memoryFlush.

### ✅ 7. `extensions/xiaozhi/src/config.ts` — Zod schema + helper

- `XIAOZHI_COMPACTION_DEFAULTS`: defaults per nightly (3:00, Europe/Rome, 8K), threshold (**25K** — abbassato da 64K), memoryFlush (`alwaysRun: true`)
- Schemi Zod: `XiaozhuCompactionNightlySchema`, `XiaozhuCompactionThresholdSchema`, `XiaozhuCompactionMemoryFlushSchema`, `XiaozhuCompactionSchema`
- **`readXiaozhiCompactionConfig(cfg)` helper:** legge il config xiaozhi da 3 path possibili, in ordine:
  1. `cfg.plugins.entries.xiaozhi.config` (canonical)
  2. `cfg.plugins.entries.xiaozhi` (flat)
  3. `cfg.plugins.xiaozhi` (legacy)

  Mai throwa, ritorna defaults su qualsiasi errore. **IMPORTANTE — gotcha config path:** il path corretto in `~/.openclaw/openclaw.json` è `plugins.entries.xiaozhi.config.compaction` (NON `plugins.xiaozhi.compaction` o `extensions.xiaozhi.compaction`). `PluginEntryConfig` accetta solo `enabled` e `config` come campi top-level.

## Configurazione

### Config xiaozhi (path corretto: `plugins.entries.xiaozhi.config.compaction`)

| Config key                         | Default         | Effetto                                                                         |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------------- |
| `compaction.enabled`               | `true`          | Master switch                                                                   |
| `compaction.nightly.enabled`       | `true`          | Trigger notturno on/off                                                         |
| `compaction.nightly.hour`          | `3`             | Ora locale (0-23)                                                               |
| `compaction.nightly.minTokens`     | `8000`          | Soglia minima per compattare di notte                                           |
| `compaction.nightly.timezone`      | `"Europe/Rome"` | Timezone                                                                        |
| `compaction.threshold.enabled`     | `true`          | Safety net post-response on/off                                                 |
| `compaction.threshold.maxTokens`   | **`25000`**     | Soglia voice-tuned (abbassata da 64K originale)                                 |
| `compaction.memoryFlush.alwaysRun` | **`true`**      | Forza flush prima di ogni compaction xiaozhi (bypassa `shouldRunMemoryFlush()`) |

### Esempio config `~/.openclaw/openclaw.json`

```json
{
  "plugins": {
    "entries": {
      "xiaozhi": {
        "enabled": true,
        "config": {
          "compaction": {
            "threshold": {
              "maxTokens": 25000
            }
          }
        }
      }
    }
  }
}
```

I defaults coprono il resto (alwaysRun, nightly, ecc.).

## Findings importanti durante implementazione

Sezione critica: gotcha e scoperte da tenere a mente per future modifiche.

### F1 — Plugin config: doppio livello di validazione

Il config xiaozhi viene validato due volte:

1. **Manifest JSON schema** (`extensions/xiaozhi/openclaw.plugin.json`) — strict (`additionalProperties: false`), runa PRIMA di Zod
2. **Zod schema** (`extensions/xiaozhi/src/config.ts`) — runa solo se passa il manifest

Se aggiungi un campo nuovo a Zod ma dimentichi il manifest, vedi `must NOT have additional properties` e Zod non viene mai chiamato. Sempre aggiornare ENTRAMBI insieme.

### F2 — Path config: `plugins.entries.xiaozhi.config.*`

Il config user xiaozhi vive in `cfg.plugins.entries.xiaozhi.config.*`, NON in `cfg.plugins.xiaozhi.*` né `cfg.extensions.xiaozhi.*`. `PluginEntryConfig` accetta solo `enabled` + `config` come top-level. Helper `readXiaozhiCompactionConfig` prova 3 path per robustezza ma il path canonical è il primo.

### F3 — Pi `keepRecentTokens` hardcoded a 20000 (override possibile via core)

Pi (`@mariozechner/pi-coding-agent`) hardcoded `keepRecentTokens: 20000` in `node_modules/.pnpm/.../compaction.js:62`. Questo è il vincolo che rende safeguard cancellation inevitabile per sessioni voice piccole (vedi TODO #2).

**SCOPERTA CRITICA:** OpenClaw core **già supporta** override via `cfg.agents.defaults.compaction.keepRecentTokens`. Path:

```
compactEmbeddedPiSession (compact.ts:540)
  → createPreparedEmbeddedPiSettingsManager
  → applyPiCompactionSettingsFromConfig (src/agents/pi-settings.ts:68)
  → settingsManager.applyOverrides({ compaction: { keepRecentTokens } })
```

Questo è il **path di fix per TODO #2**.

### F4 — Timing compaction vs TTS streaming

`runEmbeddedPiAgent()` ritorna quando l'LLM finisce, ma `consumeLoop` continua a streamare TTS in parallelo via `Promise.all([agentPromise, consumeLoop()])`. Chiamare fire-and-forget direttamente dopo `await runEmbeddedPiAgent` fa partire la compaction **durante** lo streaming → rischio di interferenze (ws send concorrente, log mischiati, ecc).

**Fix:** field `this.pendingCompaction: (() => void) | null` nella classe `AudioPipeline`. La closure viene salvata in `runAgent` e consumata DOPO `sendJson(buildTts("stop"))` nell'outer function. Reset a `null` all'inizio di ogni runAgent per evitare stale closures.

### F5 — Safeguard cancella se non ci sono "real conversation messages"

`src/agents/pi-extensions/compaction-safeguard.ts:198` cancella se `messagesToSummarize` non contiene almeno un messaggio role `user|assistant|toolResult`. Questo accade quando:

- Pi `findCutPoint` walked tutti i messaggi nella tail di `keepRecentTokens` → cutPoint = 0 → array vuoto
- Sessione contiene solo output di slash commands (caso scope-out)

Per voice xiaozhi: capita quando `totalTokens (32K) - systemPrompt (~15K) - keepRecent (20K) = -3K < 0` → 0 messaggi summarizable.

### F6 — Memory flush bypass `shouldRunMemoryFlush`

`shouldRunMemoryFlush()` del core usa la formula `contextWindow - reserveFloor - softThreshold ≈ 117K` per mistral-small (131K context). Con threshold xiaozhi a 25K, la sessione **non raggiungerà mai** 117K → flush mai eseguito → directory `workspace/memory/` resta vuota per sempre.

**Fix:** `compaction.memoryFlush.alwaysRun: true` di default per xiaozhi. In `maybeRunMemoryFlush()`, se `alwaysRun=true` salta la decision function e va dritto a `runEmbeddedPiAgent` con il flush prompt.

### F7 — Debounce split: success vs cancelled

Inizialmente debounce era 10min impostato PRIMA della compaction. Problema: cancellazione safeguard bloccava retry per 10min anche se nulla era cambiato. **Fix:** debounce impostato DOPO con valore outcome-aware:

- `success` → 10min (necessario per evitare loop sul JSONL post-compact che mantiene la vecchia entry)
- `cancelled` → 60s (retry rapido al prossimo turno voice mentre la sessione cresce)
- `error` → 60s (idem)

### F8 — Token reading: usage.totalTokens vs sessionEntry.totalTokens

`sessionEntry.totalTokens` dal session store runtime cache è spesso `null` anche con conversazione attiva. Il dato affidabile è in `message.usage.totalTokens` dell'ultima entry assistant del JSONL. `readLatestSessionTokens` legge solo gli ultimi 16KB del file → costo O(1) indipendente dalla dimensione.

### F9 — Memory flush prompt: APPEND vs OVERWRITE

`DEFAULT_MEMORY_FLUSH_PROMPT` (`src/auto-reply/reply/memory-flush.ts:11-16`) dice esplicitamente:

```
IMPORTANT: If the file already exists, APPEND new content only and do not overwrite existing entries.
```

Mistral-small NON segue l'istruzione e sovrascrive il file. Limitazione modello (vedi TODO #1). Claude/GPT-4 rispetterebbero la regola.

## Flusso risultante

```
Bridge.init()
  └─ scheduleNightlyCompaction()                          ← TRIGGER A (3:00, principale)
       └─ setTimeout → maybeCompactSession(minTokens=8K)
            ├─ 📱 schermo: "🔄 Sto organizzando i ricordi..."
            ├─ memory flush (forzato da alwaysRun)
            ├─ compactEmbeddedPiSession()
            ├─ 📱 schermo: "✅ Ricordi organizzati!"
            └─ rischedula per domani

AudioPipeline.runAgent()
  │
  ├─ 1. routeToInstant() / hasToolIntent()                ← ESISTENTE
  ├─ 2. deps.runEmbeddedPiAgent({...})                    ← ESISTENTE
  ├─ 3. salva closure pendingCompaction
  ├─ 4. (outer) speak TTS → utente riceve risposta        ← ESISTENTE
  ├─ 5. sendJson(buildTts("stop"))
  └─ 6. fire pendingCompaction:                            ← TRIGGER B (post-TTS)
        void maybeCompactSession(minTokens=25K)
              ├─ debounce check (split success/cancelled)
              ├─ totalTokens > 25K? → memory flush + compact
              └─ totalTokens < 25K? → skip silenzioso

Bridge.disconnect()
  └─ stopNightlyCompaction()                              ← CLEANUP
```

## Verifica — risultati test reali

### ✅ Test Trigger A — Nightly (smoke)

Phase 0 superato — scheduling, calcolo delay timezone, setTimeout, rischedulazione tutto funzionante. Log atteso:

```
[xiaozhi:context-manager] nightly compaction scheduled for 2026-04-12T01:00:00.000Z (in XXXXs, hour=3 tz=Europe/Rome)
```

### ✅ Test Trigger B — Threshold (post-response)

Tokens che superano 25K → compaction parte dopo `buildTts("stop")`. Log osservato durante test reale:

```
2026-04-11T11:33:48.629 [xiaozhi:context-manager] tokens=31849 threshold=25000 origin=threshold outcome=compacting
2026-04-11T11:33:48.633 [xiaozhi:context-manager] memory flush forced (alwaysRun=true) tokens=31849
2026-04-11T11:33:48.635 [xiaozhi:context-manager] memory flush start
2026-04-11T11:33:52.170 [xiaozhi:context-manager] memory flush completed
2026-04-11T11:33:52.171 [xiaozhi:context-manager] compaction start origin=threshold
2026-04-11T11:33:52.286 [compaction-safeguard] Compaction safeguard: cancelling compaction with no real conversation messages to summarize.
2026-04-11T11:33:52.291 [xiaozhi:context-manager] compaction not executed origin=threshold ok=false reason=Compaction cancelled (retry in 60s)
```

**Memory flush ✅** — file creato in `~/.openclaw/workspace/memory/2026-04-11.md` (con caveat overwrite, vedi TODO #1).
**Compaction ❌** — cancellata da safeguard Pi (vedi TODO #2).

### ✅ Test debounce split

Prima del fix: dopo cancellazione safeguard, retry bloccato 10min.
Dopo fix: log mostra `(retry in 60s)`. Verificato.

### Sanity check — non regressione

- Sessione **nuova** (0 turni): `readLatestSessionTokens` ritorna 0 → skip compaction, niente log di errore
- Fallimento `compactEmbeddedPiSession` (es. API key mancante): voice pipeline risponde normalmente al turno successivo, niente crash
- Gateway spento durante `maybeCompactSession` fire-and-forget: nessun trace orfano (promise `void` + try/catch interno)
- `/compact` manuale da UI main continua a funzionare come prima (Plan 12 tocca solo il path xiaozhi)

## Riferimenti codice

| File                                               | Righe           | Cosa fa                                                                                                                                            |
| -------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/pi-embedded-runner/compact.ts`         | 88-125, 247-761 | `CompactEmbeddedPiSessionParams`, `compactEmbeddedPiSessionDirect()` — chiama `createPreparedEmbeddedPiSettingsManager` riga 540                   |
| `src/agents/pi-settings.ts`                        | 56-97           | **`applyPiCompactionSettingsFromConfig`** — override di `keepRecentTokens` Pi via `cfg.agents.defaults.compaction.keepRecentTokens` (path TODO #2) |
| `src/agents/pi-project-settings.ts`                | 64-75           | `createPreparedEmbeddedPiSettingsManager` — calling site di `applyPiCompactionSettingsFromConfig`                                                  |
| `src/agents/pi-embedded-runner.ts`                 | 2               | Re-export `compactEmbeddedPiSession`                                                                                                               |
| `src/agents/pi-extensions/compaction-safeguard.ts` | 195-202         | Safeguard "no real conversation messages" — cancella se `messagesToSummarize` vuoto                                                                |
| `src/auto-reply/reply/memory-flush.ts`             | 11-16, 113-144  | `DEFAULT_MEMORY_FLUSH_PROMPT` (con APPEND directive) + `shouldRunMemoryFlush()` threshold logic                                                    |
| `src/auto-reply/reply/agent-runner-memory.ts`      | 27-172          | `runMemoryFlushIfNeeded()` execution                                                                                                               |
| `src/auto-reply/reply/commands-compact.ts`         | 47-144          | `/compact` handler (reference implementation)                                                                                                      |
| `src/auto-reply/reply/session-updates.ts`          | -               | `incrementCompactionCount()`                                                                                                                       |
| `src/agents/pi-embedded-runner/cache-ttl.ts`       | 11              | Provider whitelist (NON toccare)                                                                                                                   |
| `src/config/zod-schema.agent-defaults.ts`          | 80-98           | Schema config compaction (`keepRecentTokens` riga 84 — già supportato!)                                                                            |
| `extensions/xiaozhi/src/audio-pipeline.ts`         | -               | `runAgent()` — `pendingCompaction` closure consumed dopo `buildTts("stop")`                                                                        |
| `extensions/xiaozhi/src/context-manager.ts`        | 1-540           | Tutta la logica compaction xiaozhi (NUOVO)                                                                                                         |
| `extensions/xiaozhi/src/core-bridge.ts`            | 100-145         | `CoreAgentDeps` esteso con compaction primitives                                                                                                   |
| `extensions/xiaozhi/openclaw.plugin.json`          | 19-93           | Manifest JSON schema (sync con Zod)                                                                                                                |
| `extensions/xiaozhi/src/config.ts`                 | 1-117           | Zod schema + `readXiaozhiCompactionConfig` helper                                                                                                  |

## Evidenze raccolte (contesto implementativo)

- **Sessione xiaozhi "zombie"**: `~/.openclaw/agents/main/sessions/42a93d39-9cae-4672-84de-37a9d381acfe.jsonl` — 570 righe dal 28 marzo, 150 turni Mistral + 90 Anthropic, `message.usage.totalTokens` cresce 20233 → 20497 su dialoghi brevi, mai compattata (pre-Plan-12).
- **Runtime cache vuota**: `session.totalTokens: null` nel context breakdown `source=run` anche dopo conversazione reale → **non usare** `sessionEntry.totalTokens` come fonte, leggere dal JSONL.
- **`/compact` manuale** fallisce con `Compaction safeguard: cancelling compaction with no real conversation messages to summarize` su sessioni che contengono solo output di slash commands. Comportamento corretto, non toccare.
- **`usage.totalTokens` popolato sia per Anthropic che Mistral**: verificato — entrambi i provider scrivono il campo correttamente nel JSONL.
- **Test reale 2026-04-11**: sessione cresciuta da 30943 → 31849 tokens, due tentativi di compaction entrambi cancellati da safeguard. JSONL stabile (mtime non cambia post-compaction-attempt). Memory file `2026-04-11.md` creato e sovrascritto ad ogni flush.

---

# 🚧 TODO POST-IMPLEMENTAZIONE

Due problemi scoperti durante test operativo che restano aperti dopo i commit `0dde5f2f4`, `d199eecae`, `e06591baf`.

## TODO 1 — Memory file sovrascritto (NON normale ma spiegabile)

**Sintomo:** ad ogni esecuzione del memory flush, il file `~/.openclaw/workspace/memory/YYYY-MM-DD.md` viene **sovrascritto** invece di accrescersi. I contenuti delle iterazioni precedenti vengono persi.

**Causa:** `DEFAULT_MEMORY_FLUSH_PROMPT` (`src/auto-reply/reply/memory-flush.ts:11-16`) istruisce esplicitamente:

```
IMPORTANT: If the file already exists, APPEND new content only and do not overwrite existing entries.
```

Mistral-small **non rispetta** l'istruzione e usa Write invece di Read+Edit. Limitazione del modello. Claude/GPT-4 seguirebbero la regola.

**Aggravante:** con `memoryFlush.alwaysRun: true` e debounce cancelled a 60s, ogni turno voice quando tokens > 25K rifa il flush → file riscritto continuamente con varianti minime → cost elevato in token + perdita di memorie precedenti.

**Soluzioni proposte (da scegliere):**

1. **Pre-read file content + inject in prompt** — leggere il file esistente e iniettarlo nel flush prompt come `<existing-content>...</existing-content>`, dicendo all'LLM "scrivi una nuova versione che mantenga TUTTO questo + le nuove memorie". Non dipende da semantica Edit/Append. Implementare in `extensions/xiaozhi/src/context-manager.ts` → `maybeRunMemoryFlush`.
2. **Separato debounce memory flush** — non rifare flush più frequentemente di N minuti (es. 10min) anche se compaction viene riprovata. Limita lo spreco token + l'overwrite ripetuto.
3. **Prompt più aggressivo** — mistral-tuned: "DO NOT use Write. Use Read first, then Edit to merge new memories with existing ones." Dipende ancora dall'obbedienza del modello.
4. **Disabilitare Write tool** durante il flush — forzare l'agente a usare Edit. Richiede modifica `disableTools` o tool-allowlist nel runEmbeddedPiAgent call.

**Raccomandato:** combinazione di **1 + 2** (pre-read + debounce flush separato).

## TODO 2 — JSONL mai modificato (PROBLEMA REALE, fix pulito)

**Sintomo:** dopo ore di uso, il file JSONL della sessione (`~/.openclaw/agents/main/sessions/<id>.jsonl`) **non viene mai compattato**. I token di input restano stabili (~31K) all'infinito. Ogni tentativo di compaction parte ma viene cancellato dal safeguard:

```
[compaction-safeguard] Compaction safeguard: cancelling compaction with no real conversation messages to summarize.
```

**Causa:** Pi (`@mariozechner/pi-coding-agent`) ha `keepRecentTokens: 20000` hardcoded come default. Con sessione voice xiaozhi tipica (~32K totali = ~15K system prompt + ~17K messaggi):

- Pi cammina all'indietro nei messaggi cercando di accumulare 20K di "tail recente"
- Trova solo 17K di messaggi → cutPoint = 0
- `messagesToSummarize` = array vuoto
- Safeguard cancella per "no real conversation messages"

**SCOPERTA CHIAVE:** OpenClaw core **già supporta** l'override via config (`src/agents/pi-settings.ts:68`):

```typescript
const configuredKeepRecentTokens = toPositiveInt(compactionCfg?.keepRecentTokens);
```

Path completo:

```
compactEmbeddedPiSession (compact.ts:540)
  → createPreparedEmbeddedPiSettingsManager (pi-project-settings.ts:64)
  → applyPiCompactionSettingsFromConfig (pi-settings.ts:56)
  → settingsManager.applyOverrides({ compaction: { keepRecentTokens: 5000 } })
  → Pi rispetta il nuovo valore
```

**Fix proposto (clean, isolato a xiaozhi):**

1. **`extensions/xiaozhi/src/config.ts`**: aggiungere `compaction.keepRecentTokens` ai defaults (proposto: `5000`)
2. **`extensions/xiaozhi/openclaw.plugin.json`**: dichiarare il campo nel manifest schema (ricordare F1: doppio livello!)
3. **`extensions/xiaozhi/src/context-manager.ts`** in `maybeCompactSession`: clonare `cfg` (structuredClone), set `cfg.agents.defaults.compaction.keepRecentTokens = xiaozhiCompaction.keepRecentTokens`, passare il config clonato a `deps.compactEmbeddedPiSession({ config: clonedCfg, ... })`. Il config originale resta intatto, l'override si applica SOLO al call di compaction xiaozhi.

**Risultato atteso con keepRecentTokens=5000:**

- Sessione 32K → keepRecent 5K → ~12K di messaggi vecchi summarizable
- Pi summarize → 5K recent + ~3K summary = 8K messaggi
- Più system prompt 15K = ~23K totali post-compact
- **Riduzione: 32K → 23K (~30%)**

**Tuning:** valori più aggressivi (3K-2K) danno riduzioni 35-45% ma mantengono meno turni recenti in contesto. Per voice assistant 5K = ~25-30 turni recenti, dovrebbe bastare.

**Vincolo del fix:** dato che Pi può summarizzare solo i `messages` (non il system prompt che è ~15K e immutabile), la riduzione massima teorica è ~50% del totale. Per scendere ulteriormente servirebbe tagliare il system prompt (fuori scope Plan 12).

**Status:** ✅ IMPLEMENTATO (commit `fe8681619`) — override propagato via `cfg.agents.defaults.compaction.keepRecentTokens` con `structuredClone` in `maybeCompactSession`. Default iniziale: 5000.

### F4 — Follow-up: keepRecentTokens=5000 ancora troppo alto (commit successivo)

Dopo il deploy con `keepRecentTokens=5000` il loop cancel-retry persisteva. Root cause analisi:

- Pi `findCutPoint` (compaction.js:295) usa stima **`chars/4`** (non token reali LLM), cammina all'indietro accumulando finché supera `keepRecentTokens`
- Sessione voice analizzata (`42a93d39-...jsonl`, 621 righe, 1 compaction a riga 581):
  - Messaggi post-compaction (righe 582-621): **40 msg, 1874 estTokens totali** (avg 47 estTok/msg — voice messages molto corti)
  - Tail totale < 5000 → walk-back non supera mai target → `cutIndex = cutPoints[0]` (primo msg del range) → `messagesToSummarize = []` → safeguard cancella
- Pi `prepareCompaction` (compaction.js:468): `boundaryStart = prevCompactionIndex + 1` — solo messaggi DOPO l'ultima compaction sono candidati. Il "kept region" della compaction precedente (~20K estTokens, righe 352-580) è frozen.

**Fix F4:** abbassato default a `1000` in `XIAOZHI_COMPACTION_DEFAULTS.keepRecentTokens`. Con tail di 1874 estTokens: walk-back accumula ~1000 tok (~20 msg recenti tenuti), cut a metà coda, `messagesToSummarize ≈ 20 msg × 47 estTok = ~900 estTokens` → summary (~200 tok) → savings ~700 estTokens per compaction.

**Limitazione architetturale:** risparmio per singola compaction xiaozhi è modesto (~1-2K real token su totale ~39K) perché Pi non può rielaborare il kept region della compaction precedente. Il 39K reale = ~15K system prompt + ~23K real token di kept region (immutabile) + summary + tail. Pi compaction incrementale può aiutare solo sulla tail nuova.

**Implicazione:** con soglia 25K e sessioni voice che accumulano ~2K real token ogni N turni, la tail ricresce velocemente e la compaction tail-only non basta. Serve session rotation (→ TODO 3).

## TODO 3 — Session rotation per riduzioni aggressive (✅ IMPLEMENTATO)

**Problema:** Pi compaction incrementale satura quando il kept region + system prompt supera la soglia xiaozhi. Nessuna evoluzione possibile senza rielaborare il kept region storico.

**Soluzione implementata:** sostituita `compactEmbeddedPiSession` con **`resetEmbeddedPiSession`**, una nuova primitive che replica il comportamento di `sessions.reset` RPC (gateway lato server) lato extension:

1. Fire `command/new` internal hook → il bundled `session-memory` handler (`src/hooks/bundled/session-memory/handler.ts`) scrive automaticamente `~/.openclaw/workspace/memory/YYYY-MM-DD-<slug>.md` con summary LLM dell'ultima finestra di 15 messaggi (slug generato via LLM per titolo descrittivo, fallback path già gestito dall'handler in caso il file sia già stato archiviato).
2. `updateSessionStore` atomica: mint nuovo `sessionId` (UUID), reset token counters a 0, preserva model / thinking / label / origin / lastChannel / skillsSnapshot. Stessa mutazione usata da `sessions.reset` in `src/gateway/server-methods/sessions.ts:462-494`.
3. `archiveSessionTranscripts` rinomina vecchio `.jsonl` → `.jsonl.reset.<timestamp>` (stesso meccanismo usato da `/new`).
4. Prossimo turno voice: `resolveMainSessionContext` legge nuovo `sessionId` dallo store → Pi crea session file pulito. `MEMORY.md` viene auto-iniettato come bootstrap file (è first-class in `src/agents/workspace.ts`, `MINIMAL_BOOTSTRAP_ALLOWLIST` non lo filtra per `sessionKey="main"`).

**Stato sessione dopo rotation:**

- Nuovo JSONL vuoto (0 messaggi) → system prompt (~15K) + bootstrap files (inclusi `MEMORY.md` + memory daily file appena creato) = baseline pulita
- Counters `inputTokens/outputTokens/totalTokens = 0`
- Memory file daily contiene summary della conversazione precedente → nuovo agent può consultarlo via `memory_search`/`memory_get`

**File modificati (commit questa sessione):**

- `src/agents/pi-embedded-runner/reset.ts` — nuovo file, funzione `resetEmbeddedPiSession` (extension-facing)
- `src/agents/pi-embedded-runner.ts` — re-export barrel
- `src/extensionAPI.ts` — re-export `resetEmbeddedPiSession` + types
- `extensions/xiaozhi/src/core-bridge.ts` — nuovo dep `resetEmbeddedPiSession?` + type `CoreResetResult`
- `extensions/xiaozhi/src/context-manager.ts` — riscritto: `maybeCompactSession` → `maybeRotateSession`, rimosso `maybeRunMemoryFlush` (l'hook lo fa), rimosso `applyKeepRecentTokensOverride` (non applicabile)
- `extensions/xiaozhi/src/audio-pipeline.ts` — import aggiornato + closure `pendingCompaction` chiama `maybeRotateSession`

**Differenze rispetto a `sessions.reset` nativa:**

- ❌ **NO** `ensureSessionRuntimeCleanup` — xiaozhi chiama post-response, no run in flight
- ❌ **NO** `closeAcpRuntimeForSession` — nessun client ACP bound alla sessione voice
- ❌ **NO** `emitSessionUnboundLifecycleEvent` — nessun thread binding / subagent lifecycle da smontare
- ✅ **SÌ** hook `command/new` (per session-memory handler)
- ✅ **SÌ** `updateSessionStore` con nuova UUID + reset counters
- ✅ **SÌ** `archiveSessionTranscripts`

**Race condition residua:** se il prossimo turno voice arriva MENTRE la rotation è in corso (< 500ms), il resolve della session context potrebbe leggere il vecchio sessionId prima dell'atomic `updateSessionStore`, e Pi aprire un file già archiviato. In pratica la finestra è molto stretta (button press umano = >1s) ed è la stessa race che protegge `sessions.reset` via `ensureSessionRuntimeCleanup`. Non mitigata in questa iterazione; log di errore in caso, ma voice pipeline continua al turno successivo (il fallimento è silenzioso grazie al try/catch di fire-and-forget).

**Cleanup follow-up (non bloccante):**

- `extensions/xiaozhi/src/config.ts`: campo `keepRecentTokens` è ora dead config — nessun consumer, safe da rimuovere (insieme a `openclaw.plugin.json` manifest schema)
- TODO 1 (memory file overwrite) non più applicabile: l'hook `session-memory` scrive file datato+slug univoco, no collisioni
- TODO 2 (`keepRecentTokens=1000`): superato dalla rotation, nessuna compaction Pi viene più tentata

**Status:** ✅ IMPLEMENTATO (questa sessione, branch `Compaction`). Typecheck + `pnpm check` passano. Build `pnpm build` rigenera `dist/extensionAPI.js` con il nuovo export. Test operativo reale su device xiaozhi da fare: aspettarsi log `[xiaozhi:context-manager] rotation completed origin=threshold oldSessionId=... newSessionId=... archived=1` + nuovo file in `~/.openclaw/workspace/memory/YYYY-MM-DD-<slug>.md`.
