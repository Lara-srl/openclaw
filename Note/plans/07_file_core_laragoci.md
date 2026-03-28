# File Core LaraGoci — Struttura e Configurazione

> Data: 2026-03-28

---

## Struttura workspace agente (runtime, NON nel repo)

```
~/.openclaw/workspace/          ← workspace GLOBALE (tutti i canali)
    SOUL.md                     ← personalità base dell'agente
    AGENTS.md                   ← istruzioni operative (memoria, heartbeat, stile voice)
    USER.md                     ← chi è l'utente
    IDENTITY.md                 ← identità pubblica
    TOOLS.md                    ← strumenti disponibili
    HEARTBEAT.md                ← task periodici heartbeat
    BOOTSTRAP.md                ← primo avvio (si elimina dopo)
    MEMORY.md                   ← memoria long-term (solo sessione main)
    memory/                     ← log giornalieri (memory/YYYY-MM-DD.md)
```

**NON** usare `~/.openclaw/agents/main/AGENTS.md` — il path atteso da `resolveAgentDir`
sarebbe `~/.openclaw/agents/main/agent/AGENTS.md` (sottocartella `agent/`), che non
viene creata automaticamente. Il file verrebbe ignorato silenziosamente.

---

## Personalizzazione LaraGoci

### Sezione Voice in `~/.openclaw/workspace/AGENTS.md`

Aggiunta in fondo al file (sezione `## Voice`):

```markdown
## Voice

**Stile di risposta**

1. Rispondi sempre in modo conciso: 1-2 frasi se la domanda è semplice.
2. Usa risposte più lunghe solo per spiegazioni tecniche o richieste complesse.
3. Niente premesse, niente conclusioni ridondanti.
4. Niente elenchi puntati o markdown — parla come se stessi conversando.
5. Usa un tono naturale e diretto, come in una conversazione verbale.
```

---

## Note operative

- I file in `~/.openclaw/workspace/` NON sono nel repo Git — sono dati utente runtime.
- Per backup/versioning del profilo agente, copiare manualmente o usare un repo privato.
- Modifiche a `SOUL.md` / `AGENTS.md` hanno effetto immediato alla prossima sessione agente.
