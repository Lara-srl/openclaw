# Analisi Contesto LLM — XiaoZhi (Embedded Agent)

> Analisi del contesto inviato all'LLM ad ogni call vocale XiaoZhi.
> Data: 2026-03-31

---

## Architettura generale

Ogni call vocale XiaoZhi usa `runEmbeddedPiAgent()` (core OpenClaw).
Il contesto è **ricostruito da zero** ad ogni call (stateless per-call, stato persistito in JSONL).

Flusso: **Audio → STT → Agent LLM → TTS → Device**

---

## Componenti del contesto (per call)

### Breakdown tipico (hold-to-talk, 1–3 turns)

| Componente                          | Dimensione   | Tokens                | Fisso?      |
| ----------------------------------- | ------------ | --------------------- | ----------- |
| System Prompt (base)                | ~6 KB        | ~3000                 | Per agent   |
| Extra System (voice + data/ora)     | ~0.5 KB      | ~250                  | Runtime     |
| Context Files (workspace/MEMORY.md) | 0–2 KB       | 0–1000                | Workspace   |
| Session History (1–3 turns)         | 0.5–1.5 KB   | 250–750               | Per session |
| User Prompt (STT output)            | ~0.2 KB      | ~100                  | Dinamico    |
| **TOTALE TIPICO**                   | **~7–10 KB** | **~3600–5100 tokens** |             |

### Worst-case (dialog lungo + tool calls)

| Componente                        | Dimensione                 |
| --------------------------------- | -------------------------- |
| System Prompt + extra             | 8.5 KB                     |
| Context Files (MEMORY.md pieno)   | 10 KB                      |
| History (15 turns + tool results) | 20 KB                      |
| User Prompt                       | 1 KB                       |
| **TOTALE MAX**                    | **~39.5 KB → ~20k tokens** |

Mistral Small ha 32k context → ~24–26k tokens liberi per output.

---

## System Prompt — struttura interna

Costruito da `buildEmbeddedSystemPrompt()` → `src/agents/system-prompt.ts:189–704`

| #   | Sezione            | Dimensione   | Fisso?             |
| --- | ------------------ | ------------ | ------------------ |
| 1   | Identity/Intro     | ~100 ch      | No                 |
| 2   | Safety Rules       | ~400 ch      | No                 |
| 3   | Skills Section     | 0–2000 ch    | Sì (workspace)     |
| 4   | Memory Recall      | ~300 ch      | No                 |
| 5   | Authorized Senders | ~100 ch      | Sì (config)        |
| 6   | Date & Time        | ~100 ch      | Sì (runtime)       |
| 7   | Reply Tags         | ~300 ch      | No                 |
| 8   | Messaging Section  | ~600 ch      | Sì (tools + hints) |
| 9   | Voice (TTS) Hint   | ~200 ch      | Sì                 |
| 10  | Documentation      | ~200 ch      | Sì                 |
| 11  | Reasoning Hint     | ~250 ch      | No                 |
| 12  | Tool Descriptions  | 1000–3000 ch | Sì                 |
| 13  | Model Aliases      | ~200 ch      | Sì                 |
| 14  | User Timezone      | ~100 ch      | Sì                 |
| 15  | Context Files      | 500–5000 ch  | Sì                 |
| 16  | Workspace Notes    | ~200 ch      | Sì                 |

**Senza context files**: 5–8 KB (~2500–4500 tokens)
**Con context files**: 10–15 KB (~5000–8000 tokens)

---

## Extra System Prompt (XiaoZhi-specifico)

Definito in `extensions/xiaozhi/src/audio-pipeline.ts:19–37`

```
Data e ora attuale: {now}

MODALITÀ VOCALE — priorità assoluta su tutto il resto:
- La lunghezza della risposta dipende dalla domanda: ...
- MAI markdown, emoji, elenchi puntati o numerati
- MAI premesse, intro o recap
- Tono conversazionale naturale
```

Dimensione: ~430 chars / ~250 tokens — iniettato ad ogni call.

---

## Session History

- **Formato**: JSONL — `~/.openclaw/sessions/{sessionId}.jsonl`
- **Caricato da**: `SessionManager.open(sessionFile)` ad ogni call
- **XiaoZhi tipico**: 1–3 turns → 500–1500 tokens
- **Auto-compaction**: se overflow context window (max 3 tentativi via `compactEmbeddedPiSessionDirect`)

---

## Context Files (workspace injection)

Da `src/agents/bootstrap-files.ts`:

- `README.md`, `.openclaw.md`, `MEMORY.md`, `memory/*.md`, skill `.md`
- Limit: ~5 KB per file, ~50 KB totale
- **XiaoZhi tipico**: 0–2 KB (workspace minimale)

---

## Ottimizzazioni possibili per XiaoZhi vocale

### Cosa si può eliminare senza perdere funzionalità vocale

| Sezione                       | Risparmio stimato | Rischio                           |
| ----------------------------- | ----------------- | --------------------------------- |
| Reply Tags (formato messaggi) | ~300 ch           | Basso — XiaoZhi non usa tag       |
| Tool Descriptions complete    | 500–2000 ch       | Medio — ridurre a tool voice-only |
| Reasoning Hint                | ~250 ch           | Basso                             |
| Documentation path            | ~200 ch           | Basso                             |
| Model Aliases                 | ~200 ch           | Basso                             |
| Memory Recall hints           | ~300 ch           | Basso                             |
| **Totale potenziale**         | **~1750–3250 ch** |                                   |

### Risparmio token potenziale (XiaoZhi voice-only prompt)

- **Attuale tipico**: ~3600–5100 tokens input
- **Con profilo voice-stripped**: ~2500–3500 tokens input
- **Risparmio**: ~1000–1600 tokens (~25–30%)
- **Latenza**: -50–150ms per primo token (meno contesto da processare)

### Meccanismo consigliato

Aggiungere un `voiceProfile: true` flag in `runEmbeddedPiAgent` params che:

1. Skippa sezioni non-vocali del system prompt
2. Limita tool descriptions ai soli tool rilevanti (es. no file tools se XiaoZhi non li usa)
3. Limita history a N turns (es. 5) invece del default

---

## File chiave

| Path                                               | Ruolo                                           |
| -------------------------------------------------- | ----------------------------------------------- |
| `extensions/xiaozhi/src/audio-pipeline.ts:467–558` | `runAgent()` — entry point, extra system prompt |
| `src/agents/pi-embedded-runner/run/attempt.ts`     | Session creation, system prompt build, LLM call |
| `src/agents/system-prompt.ts:189–704`              | Core system prompt assembly (30+ sezioni)       |
| `src/agents/bootstrap-files.ts:72–90`              | Context file loading                            |
| `src/agents/pi-embedded-runner/run/params.ts`      | `RunEmbeddedPiAgentParams` type definition      |
