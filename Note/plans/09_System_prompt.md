# Piano: Fix System Prompt 25k token — workspace voce minimale

## Context

Il sistema prompt attuale di ogni chiamata LLM per xiaozhi è ~25.000 chars:

- Workspace files (AGENTS.md 7.8k + SOUL.md + USER.md + HEARTBEAT.md ecc.): ~13k chars
- Tools schema: ~15k chars (inevitabile)
- Skills: ~2.5k chars (inevitabile)

Questo causa:

1. Agent latency 4-8s invece di ~1s atteso per Gemini Flash
2. Istruzioni Voice diluite da 13k di istruzioni generiche → risposte lunghe con markdown
3. Costo token elevato ad ogni chiamata vocale

**Perché prima di P1c streaming:** P1c riduce la latenza _percepita_ (l'utente sente audio prima) ma il tempo al primo token di Gemini è ancora 4-8s. Con il workspace minimale, il primo token scende a ~1s → P1c diventa molto più efficace.

## Soluzione

Creare un workspace voce minimale e usarlo in `runAgent()` invece del workspace globale.

**Meccanismo disponibile:** `runEmbeddedPiAgent` accetta `workspaceDir` — se puntiamo a una directory con solo un `SOUL.md` voce (~300 chars), i workspace tokens scendono da 13k a 300 chars.

**Fallback sicuro:** se il workspace voce non esiste, usa quello di default — zero breaking changes.

## File da modificare

### 1. `extensions/xiaozhi/src/audio-pipeline.ts`

Nel metodo `runAgent()` (riga ~389), sostituire:

```ts
const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);
```

con:

```ts
const defaultWorkspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);
const voiceWorkspaceDir = path.join(os.homedir(), ".openclaw", "workspace-voice");
const workspaceDir = existsSync(voiceWorkspaceDir) ? voiceWorkspaceDir : defaultWorkspaceDir;
```

Aggiungere import:

```ts
import { existsSync } from "node:fs";
import os from "node:os";
```

### 2. Creare `~/.openclaw/workspace-voice/SOUL.md` (runtime, non nel repo)

Contenuto minimo (~300 chars):

```markdown
# LaraGoci — Assistente vocale

Sei LaraGoci, assistente vocale su ESP32. Le tue risposte vengono lette ad alta voce.

## Regole assolute

- MAX 2 frasi brevi per ogni risposta
- Niente emoji, niente markdown, niente elenchi
- Tono conversazionale diretto
```

### 3. Creare `extensions/xiaozhi/workspace-voice/SOUL.md` (nel repo, come template)

Stesso contenuto — l'utente lo copia in `~/.openclaw/workspace-voice/` al setup.

## Impatto atteso

| Metrica              | Prima      | Dopo                |
| -------------------- | ---------- | ------------------- |
| Workspace tokens     | ~13k chars | ~300 chars          |
| System prompt totale | ~25k chars | ~18k chars          |
| Agent latency attesa | 4-8s       | ~1-2s               |
| Istruzioni Voice     | diluite    | uniche e vincolanti |

## Verifica

1. Riavviare gateway
2. Verificare log: `[XZ 2.4] Agent:` deve scendere a ~1-2s
3. Risposta deve essere max 2 frasi, no emoji, no markdown
4. Test interrupt B10 (press durante risposta)
