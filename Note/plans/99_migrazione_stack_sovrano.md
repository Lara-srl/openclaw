# Piano: 99_migrazione_stack_sovrano — Stack EU su Scaleway

## Context

Obiettivo: sostituire Gemini (Google), Groq (USA) ed ElevenLabs (USA) con servizi EU-sovrani
su Scaleway (Francia/Amsterdam) per garantire GDPR compliance e zero dati fuori UE.
Il documento risponde a: cosa è fattibile, quanto codice serve, quando conviene migrare,
e se PostgreSQL ha senso come storage per le sessioni.

---

## 1. LLM — Scaleway Generative APIs ✅ Fattibile subito, ZERO codice

**Servizio**: Managed SaaS, OpenAI-compatible, data center Parigi/Amsterdam.

**Modelli disponibili (2026):**

- `llama-3.1-8b-instruct` / `llama-3.3-70b-instruct` — buon rapporto velocità/qualità
- `mistral-small-3.1-24b-instruct` — ottimo per dialogo voce
- `qwen3-235b` — modello grande, più lento

**Integrazione OpenClaw:** ZERO codice — il sistema supporta già provider OpenAI-compatible
via `models.providers` in config. Basta aggiungere al config YAML:

```yaml
models:
  providers:
    scaleway:
      baseUrl: "https://api.scaleway.ai/v1"
      apiKey: SCALEWAY_API_KEY
      api: "openai-completions"
      models:
        - id: "mistral-small-3.1-24b-instruct-2503"
          name: "Mistral Small 3.1"
          reasoning: false
          input: ["text"]
          cost: { input: 0.0001, output: 0.0003, cacheRead: 0, cacheWrite: 0 }
          contextWindow: 32768
          maxTokens: 4096
```

Poi: `pnpm openclaw config set agents.defaults.model scaleway/mistral-small-3.1-24b-instruct`

**File coinvolti:** solo `~/.openclaw/openclaw.json` (config runtime) — nessun file sorgente.

**Performance attesa:** Mistral Small ~1-2s (simile a Gemini Flash). Llama 3.3 70B ~2-4s.

---

## 2. STT — Situazione reale Scaleway

**⚠️ Managed Whisper NON esiste come SaaS stabile** — è in feature request aperta su Scaleway.
L'unica opzione Scaleway per STT è **self-host Whisper su GPU L4/L40S** (~€1.4/h on-demand).

**Opzioni:**

| Opzione                               | Costo              | Sforzo | Consiglio           |
| ------------------------------------- | ------------------ | ------ | ------------------- |
| Groq Whisper-large-v3-turbo (attuale) | ~$0.00 / min       | 0      | ✅ Mantieni per ora |
| Self-host Whisper su Scaleway L4      | ~€1.4/h VM + setup | Alto   | Post-MVP            |
| Aspettare Managed Whisper Scaleway    | —                  | 0      | Monitorare roadmap  |

**Codice da modificare (quando pronto):** solo `extensions/xiaozhi/src/audio-pipeline.ts`
funzione `whisperTranscribe()` (riga ~507) — cambiare URL e API key. ~5 righe.

**Raccomandazione:** Groq è USA ma i soli audio clip (~3-5s) transitano su loro infra,
nessun dato utente persistente. Accettabile in fase MVP. Rivalutare a produzione.

---

## 3. TTS — Scaleway Moshi vs self-host

**Moshi (Scaleway Managed, experimental):**

- Speech-to-Speech nativo — ascolta audio, genera audio direttamente, latenza 160ms
- Gestisce tutto in un solo modello: niente STT/LLM/TTS separati
- **Limitazioni bloccanti per LaraGoci:**
  1. **Solo inglese** — nessuna versione italiana/multilingue annunciata (2026-03)
  2. **Niente tool integration** — è un modello conversazionale puro, non può chiamare
     tools, MCP, calendario, WhatsApp. La pipeline attuale (STT→Agent→TTS) è più potente.
- **Quando diventerebbe interessante:** se Kyutai rilascia versione multilingue (italiano)
  E LaraGoci vuole una modalità "companion puro" senza tools — latenza 160ms nativa è imbattibile
- Monitorare: https://labs.scaleway.com/en/moshi/ per aggiornamenti lingua

**Piper TTS (self-host su Scaleway GPU):**

- Open source, qualità buona, ~50ms su GPU L4
- **Codice richiesto in OpenClaw (~3-4 ore):**
  1. `src/config/types.tts.ts` — aggiungere `"piper"` a `TtsProvider`
  2. `src/tts/tts-core.ts` — implementare `piperTTS()` (fetch HTTP endpoint)
  3. `src/tts/tts.ts` — aggiungere case nel loop provider
  4. `src/config/zod-schema.ts` — aggiungere schema config per piper
- Richiede anche: VM Scaleway GPU con server Piper deployato

**Raccomandazione a breve termine:** ElevenLabs rimane più maturo e già integrato.
Valutare Piper TTS dopo migrazione VM su Scaleway.

---

## 4. VM Openclaw → Scaleway

**Migrazione infrastrutturale** (non blocca nulla lato codice):

Passi:

1. Creare Scaleway Instance (tipo DEV1-M o GP1-S, Parigi)
2. Installare openclaw, configurare gateway
3. Aggiornare DNS `laragoci.lara-ai.eu` → nuovo IP Scaleway
4. Migrare `~/.openclaw/` (workspace, sessions, credentials)
5. Verificare nginx/reverse proxy per WS + OTA paths
6. Shutdown exe.dev VM

**Quando:** dopo che lo stack è stabile e testato. Non fare infra migration insieme a code migration.

---

## 5. PostgreSQL vs File JSON per sessioni

**Verdetto: NON vale la pena ora.**

OpenClaw usa file-based storage (sessions.json + JSONL transcript). Non esiste alcun supporto
PG nel codebase. Migrare richiederebbe:

- Nuovo schema SQL (~50 campi da `SessionEntry`)
- Riscrittura `store.ts` (1159 righe) con transazioni PG
- Connection pooling, migration scripts
- Gestione transcript JSONL ibrida o riscrittura completa

**Per una VM singola con pochi utenti:** il file-based è più che sufficiente, zero overhead.
SQLite esiste già per memory embeddings — se servisse un DB leggero per sessioni, SQLite
sarebbe molto più rapido da integrare di PostgreSQL.

**Raccomandazione:** file JSON + JSONL restano il sistema di storage. Rivalutare solo se:

- Multi-tenant (più utenti su stesso gateway)
- Analytics su storico sessioni (query SQL)
- Alta concorrenza (>10 richieste simultanee)

---

## 6. Caching con Scaleway LLM

Scaleway Generative APIs (OpenAI-compatible) **non ha prompt caching automatico** come Anthropic.
Il TO_DO T1 (Gemini context caching esplicito) rimane valido anche per Scaleway — stessa problematica.
Nessun nuovo codice rispetto a quanto già pianificato in TO_DO.md.

---

## Decisioni prese (2026-03-29)

| Componente | Decisione                                        | Motivazione                                                   |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------- |
| LLM        | ✅ Scaleway Mistral Small — implementare subito  | OpenAI-compatible, zero codice, EU data                       |
| STT        | ✅ Groq — mantenere                              | Groq esegue solo computazione, non persiste dati utente       |
| TTS        | ⏳ Piper self-host su Scaleway GPU — da valutare | Richiede VM GPU + verifica multi-utenza                       |
| Moshi      | ❌ Bocciato                                      | Solo inglese + niente tool integration = inutile per LaraGoci |
| PostgreSQL | ❌ Non ora                                       | Troppo refactoring, nessun beneficio concreto per single-VM   |

---

## Roadmap aggiornata

```
ORA (zero codice):
  → Attivare Scaleway API key
  → Configurare provider scaleway in openclaw.json (baseUrl + modello)
  → Test latenza/qualità Mistral Small vs Gemini 3 Flash sul device reale

DOPO P1c streaming:
  → Deploy VM Scaleway con Piper TTS (server HTTP)
  → Verifica: qualità voce italiana, latenza, comportamento multi-utenza
  → Se ok: implementare provider "piper" in src/tts/ (~3-4 ore codice)

DOPO stack Piper validato:
  → Migrazione VM exe.dev → Scaleway (infra/DNS, non blocca sviluppo)
  → Rivalutare STT se Scaleway Managed Whisper diventa disponibile

MONITORARE:
  → Moshi multilingue (italiano) — https://labs.scaleway.com/en/moshi/
  → Scaleway Managed Whisper roadmap
```

---

## File da creare/modificare per implementazione completa

| Modifica               | File                                                                                           | Sforzo          |
| ---------------------- | ---------------------------------------------------------------------------------------------- | --------------- |
| LLM Scaleway           | `~/.openclaw/openclaw.json` (config)                                                           | 0 codice        |
| STT Scaleway self-host | `extensions/xiaozhi/src/audio-pipeline.ts:507`                                                 | ~5 righe        |
| TTS Piper              | `src/tts/tts-core.ts`, `src/tts/tts.ts`, `src/config/types.tts.ts`, `src/config/zod-schema.ts` | ~3-4 ore        |
| VM migration           | infra/DNS/nginx                                                                                | operativo       |
| PostgreSQL             | `src/config/sessions/store.ts` + schema SQL                                                    | NON consigliato |
