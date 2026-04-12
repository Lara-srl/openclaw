# Skills & Tools in OpenClaw — Guida per XiaoZhi/LaraGoci

> Documento di riferimento: come funzionano Skills e Tools in OpenClaw e come sfruttarli nell'estensione XiaoZhi.

---

## 1. Concetti Base

|                   | **Skill**                                                              | **Tool**                                                               |
| ----------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Cos'è**         | Documento Markdown (SKILL.md) iniettato nel system prompt dell'agente  | Funzione eseguibile registrata via plugin API                          |
| **Dove vive**     | `skills/<name>/SKILL.md` (o managed/bundled/personal)                  | Codice TypeScript in un plugin (`api.registerTool()`)                  |
| **Come funziona** | L'LLM legge le istruzioni e decide come agire (bash, read/write, ecc.) | L'LLM chiama la funzione con parametri tipizzati, il runtime la esegue |
| **Dipendenze**    | Nessuna (solo istruzioni) — può richiedere bins/env nel frontmatter    | Richiede codice, TypeBox schema, import runtime                        |
| **Esempio**       | `weather` — istruzioni per usare `curl wttr.in`                        | `laragoci_speak` — TTS sul device ESP32                                |

**Regola d'oro:** usa una **Skill** quando le istruzioni bastano (l'agente può usare bash/read/write). Usa un **Tool** quando serve logica custom (WebSocket, API interne, stato runtime).

---

## 2. Anatomia di una Skill

### 2.1 Struttura directory

```
skills/
  weather/
    SKILL.md          ← unico file obbligatorio
  session-logs/
    SKILL.md
  dieta/              ← esempio futuro
    SKILL.md
```

### 2.2 SKILL.md — Frontmatter YAML

Ogni SKILL.md inizia con frontmatter YAML delimitato da `---`:

```yaml
---
name: weather
description: "Get current weather and forecasts via wttr.in. Use when user asks about weather."
homepage: https://wttr.in/:help
metadata:
  {
    "openclaw":
      {
        "emoji": "🌤️",
        "always": false,
        "primaryEnv": "ANTHROPIC_API_KEY",
        "requires":
          {
            "bins": ["curl"],
            "anyBins": ["jq", "python3"],
            "env": ["MY_API_KEY"],
            "config": ["messages.tts.provider"],
          },
        "install":
          [
            {
              "kind": "brew",
              "formula": "curl",
              "label": "Install curl via Homebrew",
              "bins": ["curl"],
            },
          ],
      },
  }
disable-model-invocation: false
user-invocable: true
---
# Weather Skill
...contenuto con istruzioni per l'agente...
```

### 2.3 Campi del frontmatter

| Campo                                | Tipo     | Default | Descrizione                                         |
| ------------------------------------ | -------- | ------- | --------------------------------------------------- |
| `name`                               | string   | —       | Identificativo unico della skill                    |
| `description`                        | string   | —       | Descrizione breve (usata nel prompt e nei comandi)  |
| `homepage`                           | string   | —       | URL documentazione                                  |
| `metadata.openclaw.emoji`            | string   | —       | Emoji per display                                   |
| `metadata.openclaw.always`           | boolean  | `false` | Se `true`, sempre inclusa (ignora bins/env/os)      |
| `metadata.openclaw.primaryEnv`       | string   | —       | Variabile env principale per la skill               |
| `metadata.openclaw.os`               | string[] | —       | OS supportati: `linux`, `darwin`, `win32`           |
| `metadata.openclaw.requires.bins`    | string[] | —       | Binari TUTTI richiesti                              |
| `metadata.openclaw.requires.anyBins` | string[] | —       | Almeno UNO di questi binari                         |
| `metadata.openclaw.requires.env`     | string[] | —       | Variabili env TUTTE richieste                       |
| `metadata.openclaw.requires.config`  | string[] | —       | Path config richiesti                               |
| `metadata.openclaw.install`          | array    | —       | Istruzioni installazione (brew/node/go/uv/download) |
| `disable-model-invocation`           | boolean  | `false` | Se `true`, l'LLM non può invocare la skill          |
| `user-invocable`                     | boolean  | `true`  | Se `true`, l'utente può usare `/skillname`          |
| `command-dispatch`                   | string   | —       | Routing comando: `tool`                             |
| `command-tool`                       | string   | —       | Nome del tool da invocare (se dispatch=tool)        |
| `command-arg-mode`                   | string   | `raw`   | Come passare gli argomenti                          |

### 2.4 Esempio reale: weather

File: `skills/weather/SKILL.md`

```yaml
---
name: weather
description: "Get current weather and forecasts via wttr.in or Open-Meteo."
homepage: https://wttr.in/:help
metadata: { "openclaw": { "emoji": "🌤️", "requires": { "bins": ["curl"] } } }
---
```

Il corpo contiene: quando usarla, quando NO, comandi bash (`curl wttr.in/...`), format codes.

### 2.5 Esempio reale: session-logs

```yaml
---
name: session-logs
description: Search and analyze your own session logs using jq.
metadata: { "openclaw": { "emoji": "📜", "requires": { "bins": ["jq", "rg"] } } }
---
```

Richiede sia `jq` che `rg` — senza entrambi, la skill non viene caricata.

---

## 3. Anatomia di un Tool

### 3.1 Pattern di registrazione

File: `extensions/xiaozhi/src/tools.ts`

```typescript
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Helper per risposte
const ok = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

const notConnected = () => ok({ ok: false, error: "No LaraGoci device connected" });

export function registerLaragociTools(
  api: OpenClawPluginApi,
  getBridge: () => XiaozhiBridge | null,
): void {
  api.registerTool({
    name: "laragoci_speak", // ID unico
    label: "LaraGoci Speak", // Display name
    description: "Speak text aloud on the LaraGoci device speaker via TTS.",
    parameters: Type.Object({
      // TypeBox schema
      text: Type.String({ description: "Text to speak on the device." }),
    }),
    async execute(_id, params) {
      // Logica esecuzione
      if (!getBridge()) return notConnected();
      return ok({ ok: true, queued: params.text });
    },
  });
}
```

### 3.2 Struttura di un Tool

```typescript
type AnyAgentTool = {
  name: string; // ID unico (snake_case)
  label?: string; // Nome leggibile
  description: string; // Descrizione per l'LLM
  parameters?: TObject; // Schema TypeBox (diventa JSON Schema)
  ownerOnly?: boolean; // Solo il proprietario può usarlo
  execute: (id: string, params: T) => Promise<AgentToolResult>;
};

// Risultato tool
type AgentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};
```

### 3.3 Tool Factory (contesto runtime)

Un tool può anche essere una factory che riceve il contesto:

```typescript
type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) => AnyAgentTool | AnyAgentTool[] | null | undefined;

type OpenClawPluginToolContext = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
};
```

### 3.4 Guardrail schema

Da CLAUDE.md:

- **No** `Type.Union` negli input schema (no `anyOf`/`oneOf`/`allOf`)
- Usare `stringEnum`/`optionalStringEnum` per enum di stringhe
- Usare `Type.Optional(...)` invece di `... | null`
- Top-level schema deve essere `type: "object"` con `properties`
- Evitare il nome `format` come property (riservato da alcuni validatori)

### 3.5 I 5 tool XiaoZhi attuali

| Tool              | Descrizione          | Stato               |
| ----------------- | -------------------- | ------------------- |
| `laragoci_speak`  | TTS sul device       | Stub (TODO Phase 2) |
| `laragoci_emoji`  | Emozione su LCD      | Stub                |
| `laragoci_volume` | Volume speaker 0-100 | Stub                |
| `laragoci_status` | Stato connessione    | Stub                |
| `laragoci_play`   | Play audio da URL    | Stub                |

Tutti seguono il pattern `getBridge() → notConnected()` per gestire device disconnesso.

---

## 4. Precedenza e Caricamento Skills

### 4.1 Ordine di precedenza (override crescente)

```
1. Extra dirs          config.skills.load.extraDirs + plugin skill dirs
2. Bundled             skills/ dentro openclaw (weather, obsidian, tmux, ecc.)
3. Managed             ~/.openclaw/skills/
4. Personal agents     ~/.agents/skills/
5. Project agents      .agents/skills/ (repo root)
6. Workspace           ./skills/ (workspace corrente)
```

Se due skill hanno lo stesso `name`, vince quella con precedenza più alta (workspace > bundled).

I plugin skill dirs vengono risolti via `resolvePluginSkillDirs()` e mergiati con `extraDirs`.

### 4.2 Limiti di caricamento

| Limite                  | Default | Config path                              |
| ----------------------- | ------- | ---------------------------------------- |
| Max candidati per root  | 300     | `skills.limits.maxCandidatesPerRoot`     |
| Max skills per source   | 200     | `skills.limits.maxSkillsLoadedPerSource` |
| Max skills nel prompt   | 150     | `skills.limits.maxSkillsInPrompt`        |
| Max caratteri prompt    | 30.000  | `skills.limits.maxSkillsPromptChars`     |
| Max dimensione SKILL.md | 256 KB  | `skills.limits.maxSkillFileBytes`        |

Se le skills superano il budget caratteri, viene usata una **binary search** per trovare il massimo prefisso che entra nel limite.

### 4.3 Flusso di caricamento

```
loadSkillEntries(workspaceDir)
  ├── Per ogni source (extra → bundled → managed → personal → project → workspace):
  │   ├── resolveNestedSkillsRoot() — detect skills/*/SKILL.md
  │   ├── listChildDirectories() — scan sottocartelle
  │   ├── loadSkillsFromDir() — carica SKILL.md
  │   └── Enforza limiti (size, count)
  ├── Merge in Map<name, Skill> (later overrides earlier)
  └── Per ogni skill:
      ├── parseFrontmatter() — YAML metadata
      ├── resolveOpenClawMetadata() — metadata.openclaw.*
      └── resolveSkillInvocationPolicy() — user-invocable, disable-model-invocation
```

### 4.4 Eligibility check

```
shouldIncludeSkill(entry, config, eligibility)
  ├── config.skills.entries.<skillKey>.enabled === false → SKIP
  ├── config.skills.allowBundled defined → only allowlisted bundled skills
  └── Runtime eligibility:
      ├── metadata.os → match platform?
      ├── requires.bins → ALL present?
      ├── requires.anyBins → ANY present?
      ├── requires.env → ALL set?
      ├── requires.config → ALL truthy?
      └── metadata.always === true → BYPASS tutto
```

### 4.5 Skill Snapshot (cache)

```typescript
type SkillSnapshot = {
  prompt: string; // Prompt formattato, pronto per system prompt
  skills: Array<{
    name: string;
    primaryEnv?: string;
    requiredEnv?: string[];
  }>;
  skillFilter?: string[]; // Filtro agent-level
  resolvedSkills?: Skill[]; // Skill objects per riuso
  version?: number; // Cache versioning
};
```

Vantaggi: evita ri-caricamento da disco ad ogni run. Pre-formatta il prompt. Supporta filtri per agente.

---

## 5. Policy Pipeline dei Tools

### 5.1 Tool Policy

```typescript
type ToolPolicyLike = {
  allow?: string[]; // Allowlist esplicita (se presente, deny-by-default)
  deny?: string[]; // Denylist specifica
};
```

Se `allow` è definito, SOLO i tool elencati sono disponibili. `deny` rimuove tool specifici.

### 5.2 Owner-only tools

Tool riservati al proprietario:

- Hard-coded: `whatsapp_login`, `cron`, `gateway`
- Qualsiasi tool con `ownerOnly: true`
- Per non-owner: `execute()` wrappata per lanciare errore permessi

### 5.3 Subagent restrictions

**Sempre negati per subagent:**

- `gateway`, `agents_list`, `whatsapp_login`
- `session_status`, `cron`
- `memory_search`, `memory_get`
- `sessions_send`

**Leaf subagent (profondità max):** anche `sessions_list`, `sessions_history`, `sessions_spawn`

### 5.4 disableTools (XiaoZhi)

Il parametro `disableTools: true` in `runEmbeddedPiAgent()` rimuove TUTTI i tool dall'agente. Usato da XiaoZhi per conversazione pura (nessun tool intent detected).

---

## 6. Come XiaoZhi Usa Tutto Questo Oggi

### 6.1 Tool registration

In `extensions/xiaozhi/index.ts`, il bootstrap chiama:

```typescript
registerLaragociTools(api, () => runtime?.bridge ?? null);
```

5 tool stub registrati via `api.registerTool()`. Tutti hanno il guard `if (!getBridge()) return notConnected()`.

### 6.2 Voice agent invocation

In `extensions/xiaozhi/src/audio-pipeline.ts`, il metodo `runAgent()`:

```
Input voce (testo STT)
  │
  ├── routeToInstant(text) → risposta immediata? → TTS (skip LLM)
  │
  ├── hasToolIntent(text) → keyword match → needsTools = true/false
  │
  └── runEmbeddedPiAgent({
        prompt: text,
        disableTools: !needsTools,          ← tool intent routing
        extraSystemPrompt: voicePrompt,     ← regole voce (italiano, no markdown)
        provider/model: da config,
        onPartialReply: streaming callback, ← P1C prefetch TTS
      })
```

### 6.3 Tool Intent Detection

Keywords che attivano i tool: `cerca`, `trova`, `google`, `manda`, `scrivi`, `invia`, `messaggio`, `leggi`, `ricorda`, `calendario`, `promemoria`, `esegui`, `scatta`, `foto`, `apri`, `chiudi`, `accendi`, `spegni`, `timer`, `sveglia`.

Senza keyword match → `disableTools: true` → risposta solo LLM (più veloce, meno token).

### 6.4 Instant Routing

Pre-LLM pattern matching per:

- Saluti (`ciao`, `hey`, `buongiorno`) → risposta random
- Ora (`che ora è`) → `new Date().toLocaleTimeString("it-IT")`
- Meteo → "Non ho accesso al meteo"
- Congedo (`ciao ciao`, `buonanotte`) → risposta + addormentamento
- Input >12 parole → skip instant, vai a LLM

### 6.5 Skills nel voice agent

Attualmente **nessun `skillsSnapshot` esplicito** viene passato a `runEmbeddedPiAgent()`. Questo significa:

- Il runner usa il default: carica tutte le workspace skills da disco
- Le skills bundled (weather, session-logs, ecc.) sono disponibili all'agente voice
- L'agente voice può seguire le istruzioni delle skills se il contesto le attiva

---

## 7. Come XiaoZhi Potrebbe Usare Skills

### 7.1 Workspace skills personalizzate

Creare `skills/<nome>/SKILL.md` nel workspace → automaticamente disponibile all'agente voice:

```
skills/
  dieta/SKILL.md     ← tracking pasti
  domotica/SKILL.md  ← comandi smart home
  memo/SKILL.md      ← promemoria vocali
```

**Nessuna modifica al codice necessaria.** L'agente embedded riceve il prompt della skill nel system prompt e sa come usare read/write per gestire i file.

### 7.2 Filtraggio skills per voce

Se servono solo certe skills nel voice agent, passare `skillFilter`:

```typescript
const result = await deps.runEmbeddedPiAgent({
  // ...
  skillFilter: ["dieta", "domotica"], // solo queste
});
```

Oppure usare `skillsSnapshot` pre-calcolato per performance:

```typescript
const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
  config: cfg,
  skillFilter: ["dieta", "domotica"],
});

const result = await deps.runEmbeddedPiAgent({
  // ...
  skillsSnapshot: snapshot,
});
```

### 7.3 Plugin skills

Un plugin può registrare directory skills nel suo `package.json` o manifest. Risolte da `resolvePluginSkillDirs()` e aggiunte come "extra dirs" nel merge.

### 7.4 Voice-specific skill design

Per skills ottimizzate per voce:

- Descrizione che menziona comandi vocali ("quando l'utente dice...")
- `always: true` se non ha dipendenze bins/env
- Operazioni semplici (read/write file, calcoli)
- Evitare skills che richiedono output visuale complesso (tabelle, grafici)

---

## 8. Esempio Pratico: Skill Dieta

### 8.1 Struttura

```
skills/
  dieta/
    SKILL.md
```

### 8.2 SKILL.md completo

````markdown
---
name: dieta
description: "Traccia i pasti giornalieri in un file Markdown. Usa quando l'utente dice cosa ha mangiato o chiede un riepilogo della dieta."
metadata: { "openclaw": { "emoji": "🍽️", "always": true } }
---

# Dieta — Tracking pasti

Traccia i pasti dell'utente in un file Markdown persistente.

## Quando usare

- L'utente dice cosa ha mangiato: "ho mangiato pasta al pesto a pranzo"
- L'utente chiede un riepilogo: "cosa ho mangiato oggi/questa settimana?"
- L'utente vuole aggiungere/modificare/cancellare una voce

## File dati

Il file dieta vive in: `~/.openclaw/dieta/dieta.md`

Se il file non esiste, crealo con un heading iniziale:

```markdown
# Diario Alimentare
```
````

## Formato

Ogni giorno ha un heading H2 con data ISO. Ogni pasto è una riga con timestamp, tipo pasto e descrizione:

```markdown
## 2026-04-09

- 08:30 | Colazione | caffè e cornetto
- 13:15 | Pranzo | pasta al pesto con insalata
- 16:00 | Spuntino | mela
- 20:00 | Cena | pesce alla griglia con verdure
```

## Come aggiungere un pasto

1. Leggi il file `~/.openclaw/dieta/dieta.md` (crealo se non esiste)
2. Trova o crea la sezione `## YYYY-MM-DD` per la data di oggi
3. Aggiungi la riga `- HH:MM | Tipo | descrizione`
4. Se l'utente non specifica il tipo (colazione/pranzo/cena/spuntino), deducilo dall'ora:
   - 06:00-10:00 → Colazione
   - 11:00-14:30 → Pranzo
   - 15:00-17:30 → Spuntino
   - 18:00-22:00 → Cena
   - Fuori range → Spuntino
5. Scrivi il file aggiornato
6. Conferma con una frase breve: "Aggiunto: pranzo — pasta al pesto"

## Riepilogo

Quando l'utente chiede "cosa ho mangiato oggi/ieri/questa settimana":

1. Leggi il file
2. Filtra le sezioni per il periodo richiesto
3. Rispondi con un elenco conciso in prosa (ricorda: modalità voce, no markdown)

## Note

- Usa sempre l'ora corrente se l'utente non la specifica
- Le date sono in formato ISO (YYYY-MM-DD)
- Il file è append-only: non cancellare voci precedenti salvo richiesta esplicita
- Crea la directory `~/.openclaw/dieta/` se non esiste

````

### 8.3 Come funziona

1. L'utente dice (voce o chat): *"ho mangiato un'insalata a pranzo"*
2. L'agente riceve la skill "dieta" nel system prompt (grazie a `always: true`)
3. L'agente riconosce l'intent → usa **read** per leggere `~/.openclaw/dieta/dieta.md`
4. Se il file non esiste → usa **write** per crearlo con heading
5. Aggiunge la voce sotto la data corrente
6. Risponde: *"Aggiunto: pranzo — insalata"*

### 8.4 Verifica

```bash
# La skill è visibile?
openclaw skills list | grep dieta

# Test manuale
openclaw message send "ho mangiato un'insalata a pranzo"

# Controlla il file
cat ~/.openclaw/dieta/dieta.md
````

### 8.5 Integrazione voce XiaoZhi

**Nessuna modifica al codice.** La skill viene caricata nel system prompt dell'agente voice perché:

- `always: true` → nessun requisito bins/env da verificare
- L'agente embedded riceve tutte le workspace skills
- `runEmbeddedPiAgent()` già include le skills nel prompt

L'unica accortezza: aggiungere `"dieta"` ai `TOOL_INTENT_KEYWORDS` in `audio-pipeline.ts` non è necessario perché la skill non usa tool — usa read/write che sono sempre disponibili (a meno che `disableTools: true`).

**Potenziale problema:** se `disableTools: true` (nessun tool intent), l'agente potrebbe non avere accesso a read/write. In quel caso, aggiungere keywords come `mangiato`, `dieta`, `pasto` a `TOOL_INTENT_KEYWORDS` per forzare `disableTools: false` quando l'utente parla di cibo.

---

## 9. File di Riferimento

| File                                       | Contenuto                                                    |
| ------------------------------------------ | ------------------------------------------------------------ |
| `src/agents/skills/types.ts`               | Tipi: `SkillEntry`, `SkillSnapshot`, `OpenClawSkillMetadata` |
| `src/agents/skills/workspace.ts`           | Caricamento, precedenza, snapshot, prompt generation         |
| `src/agents/skills/frontmatter.ts`         | Parsing YAML frontmatter                                     |
| `src/agents/skills/config.ts`              | `shouldIncludeSkill()` — eligibility check                   |
| `src/agents/skills/filter.ts`              | `normalizeSkillFilter()` — filtro per agente                 |
| `src/agents/skills/plugin-skills.ts`       | `resolvePluginSkillDirs()` — skills da plugin                |
| `src/agents/tools/common.ts`               | `AnyAgentTool` — tipo base tool                              |
| `src/agents/tool-policy.ts`                | Allow/deny, owner-only, grouping                             |
| `src/agents/pi-tools.policy.ts`            | Subagent restrictions                                        |
| `src/plugins/types.ts`                     | `OpenClawPluginApi`, `registerTool()`, factory, context      |
| `extensions/xiaozhi/index.ts`              | Bootstrap plugin XiaoZhi                                     |
| `extensions/xiaozhi/src/tools.ts`          | 5 tool stub LaraGoci                                         |
| `extensions/xiaozhi/src/audio-pipeline.ts` | State machine voce, routing, TTS                             |
| `skills/weather/SKILL.md`                  | Esempio skill semplice (solo curl)                           |
| `skills/session-logs/SKILL.md`             | Esempio skill con bins (jq + rg)                             |

---

## 10. Tool e Voice System Prompt — Lezione Appresa

### Problema (2026-04-12)

I tool sono definiti in `TOOLS.md` e `SKILLS.md` (workspace) e l'agente voice li vede tutti (30+ tool disponibili). Tuttavia **Mistral Small non sceglie spontaneamente il tool corretto** per task ambigui come "salva nella memoria". Invece di chiamare `write`, allucina l'azione ("Fatto!") senza mai invocare il tool.

### Causa root

- `TOOLS.md`/`SKILLS.md` definiscono **cosa** fanno i tool (schema, parametri)
- Il `VOICE_EXTRA_SYSTEM_PROMPT` deve dire **quando** usarli nel contesto vocale
- Modelli piccoli (Mistral Small) con 30+ tool scelgono il path con meno attrito: fingere di aver fatto l'azione

### Regola pratica

**NON serve esplicitare tutti i tool nel voice prompt.** Aggiungere istruzioni esplicite solo per i tool dove il modello allucina invece di chiamarli. Tool con mapping ovvio (es. "che tempo fa" -> weather, "cerca su Google" -> web_search) funzionano senza istruzioni extra.

### Fix applicato

Aggiunto blocco `GESTIONE MEMORIA` nel `VOICE_EXTRA_SYSTEM_PROMPT` (`extensions/xiaozhi/src/audio-pipeline.ts` riga 29+):

```
GESTIONE MEMORIA — quando l'utente chiede di salvare/ricordare/memorizzare qualcosa:
- Usa il tool "write" per scrivere nel file ~/.openclaw/workspace/memory/YYYY-MM-DD.md
- NON fingere di aver salvato: devi SEMPRE chiamare il tool "write"
- Per ricordare eventi passati: usa "memory_search" + "memory_get"
```

La riga chiave e' l'ultima: `NON fingere di aver salvato` — istruzione negativa esplicita che forza il modello a usare il tool.

### Checklist per nuovi tool problematici

1. Testare il tool a voce — se il modello dice "Fatto" senza tool call, serve istruzione esplicita
2. Aggiungere nel `VOICE_EXTRA_SYSTEM_PROMPT` un blocco dedicato con:
   - QUANDO usare il tool (trigger vocale)
   - QUALE tool chiamare (nome esatto)
   - Istruzione negativa ("NON fingere", "NON rispondere senza chiamare il tool")
3. Se il tool richiede read/write, aggiungere le keyword al `TOOL_INTENT_KEYWORDS` per evitare `disableTools: true`

---

## 11. Decisioni Aperte / TODO

- [ ] **Creare `skills/dieta/SKILL.md`** — il file effettivo (copia da sezione 8.2)
- [ ] **Aggiungere keyword "dieta/pasto/mangiato"** a `TOOL_INTENT_KEYWORDS` in `audio-pipeline.ts` se serve tool intent per read/write
- [ ] **Verificare se `disableTools: true` blocca read/write** — se sì, la skill dieta non funziona senza tool intent
- [ ] **Skill filtraggio per voce** — valutare se passare `skillFilter` per ridurre token nel prompt voice
- [ ] **Skill domotica** — prossima skill: comandi smart home via voce
- [ ] **Monitorare tool allucinati** — testare periodicamente i tool voce con Mistral Small e aggiungere istruzioni esplicite quando necessario
