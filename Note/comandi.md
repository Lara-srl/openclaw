# Comandi utili — LaraGoci / XiaoZhi

## Avvia / riavvia gateway

```bash
# IMPORTANTE: usare KEY esplicita per evitare che il gateway erediti chiave sbagliata
KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2-)
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
ANTHROPIC_API_KEY="$KEY" nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
sleep 3 && tail -5 /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'
```

## Log in tempo reale

```bash
tail -f /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'
tail -f /tmp/openclaw-gateway.log | grep --line-buffered "XZ\|xiaozhi"
```

## Verifica chiave API nel gateway attivo

```bash
ps aux | grep "openclaw gateway" | grep -v grep | awk '{print $2}' | head -1 \
  | xargs -I{} cat /proc/{}/environ 2>/dev/null | tr '\0' '\n' | grep ANTHROPIC | cut -c-40
```

## Test API key

```bash
KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2-)
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"ping"}]}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('type')=='message' else d.get('error'))"
```

## Mock client (test pipeline senza device fisico)

```bash
# silenzio sintetico
bun scripts/xiaozhi-mock-client.ts

# con audio WAV reale (16kHz mono)
bun scripts/xiaozhi-mock-client.ts --wav /path/to/audio.wav --out received-tts.wav
```

# Verificare se il gateway è attivo

```bash

# Vedere i log in tempo reale:

#Se il gateway non è attivo, riavvialo con : Chiave Antropic. ma il modello
KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2-); pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1; ANTHROPIC_API_KEY="$KEY" nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 & sleep 3 && tail -5 /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'

#Se il gateway non è attivo, riavvialo con : Modello Gemini
#GKEY=$(grep GEMINI_API_KEY ~/.bashrc | cut -d= -f2-); GROQ_API_KEY=$(grep GROQ_API_KEY ~/.bashrc | cut -d= -f2-); pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1; GEMINI_API_KEY="$GKEY" GROQ_API_KEY="$GROQ_API_KEY" nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 & sleep 5 && tail -20 /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'


cd ~/openclaw && GKEY=$(grep GEMINI_API_KEY ~/.bashrc | cut -d= -f2-); GROQ_API_KEY=$(grep GROQ_API_KEY ~/.bashrc | cut -d= -f2-); pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1; GEMINI_API_KEY="$GKEY"; GROQ_API_KEY="$GROQ_API_KEY" nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 & sleep 5 && tail -20 /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'


# Solo log XiaoZhi (filtrati):
# Questo senza colori
tail -f /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'

# Questo piu utile per debug
tail -f /tmp/openclaw-gateway.log | grep --line-buffered "XZ\|xiaozhi\|hello"

tail -f /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'

# utilizzo pnpm openclaw in quanto simao in sorgente
pnpm openclaw login
pnpm openclaw config set agent.model google/gemini-3-flash-preview


#trace
jq -r '"[\(.ms)ms]\n  IN:  \(.input)\n  OUT: \(.output)"' /tmp/xiaozhi-llm-trace.jsonl
```

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

---

## Avvia gateway — stack Mistral EU (foreground)

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
MISTRAL_API_KEY="$MKEY" OPENAI_TTS_BASE_URL="https://api.mistral.ai/v1" \
  pnpm openclaw gateway run --bind loopback --port 18789 --force

```

Con TTS gain custom (default 0.85):

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
XIAOZHI_TTS_GAIN=1.0 MISTRAL_API_KEY="$MKEY" OPENAI_TTS_BASE_URL="https://api.mistral.ai/v1" \
  pnpm openclaw gateway run --bind loopback --port 18789 --force
```

## Avvia gateway — stack Mistral EU (background)

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
MISTRAL_API_KEY="$MKEY" OPENAI_TTS_BASE_URL="https://api.mistral.ai/v1" \
  nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
sleep 5 && tail -20 /tmp/openclaw-gateway.log | sed 's/\x1b\[[0-9;]*m//g'
```

## per vedere i log come in foregound

```bash
tail -f nohup.out
tail -f /tmp/openclaw/openclaw-2026-04-03.log | grep --line-buffered -oP '"0":"\K[^"]*'
```

## Test STT Voxtral

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
curl -s https://api.mistral.ai/v1/audio/transcriptions \
  -H "Authorization: Bearer $MKEY" \
  -F "file=@/dev/null;type=audio/wav" \
  -F "model=voxtral-mini-latest"
```

## Verifica gateway attivo

```bash
ps aux | grep openclaw | grep -v grep
```

```bash
/home/openclaw/.openclaw/openclaw.json
```

allowBundled: ["_none"] permette solo una skill chiamata \_none che non esiste → tutte le bundled sono disattivate.Le skill workspace (quelle che crei tu in skills/ nel repo) e le skill dei plugin restano attive — l'allowlist filtra solo le bundled.Per riattivarne alcune in futuro, basta sostituire ["_none"] con i nomi che vuoi, es. ["weather", "gog"]. Per riattivare tutte, rimuovi la sezione skills dal JSON.

MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)pkill -9 -f openclaw-gateway 2>/dev/null; 
sleep 1 MISTRAL_API_KEY="$MKEY" OPENAI_TTS_BASE_URL="https://api.mistral.ai/v1" pnpm openclaw gateway run --bind loopback --port 18789 --force

---

Bash(cp ~/.openclaw/agents/main/sessions/42a93d39-9cae-4672-84de-37a9d381acfe.jsonl ~/.openclaw/agents/main/sessions/42a93d39-9cae-4672-84de-37a9d381acfe.jsonl.bak &…)  
 ⎿ Interrupted · What should Claude do instead? 11

❯ quindi mi stai dicendo che non è mai stato fatto il pruning della conversazione?

● Buona domanda. 566 righe dal 28 marzo con ttl: "1h" configurato — chiaramente il pruning non sta funzionando. Vediamo perché.

● Task(Investigate context pruning for embedded agent)  
 ⎿ Done (36 tool uses · 72.0k tokens · 2m 1s)  
 (ctrl+o to expand)

❯ del contesto^

● Esatto, il pruning non è MAI stato eseguito. Ecco perché:

cache-ttl funziona SOLO con Anthropic

Il codice in src/agents/pi-embedded-runner/cache-ttl.ts ha una whitelist esplicita:

const CACHE_TTL_NATIVE_PROVIDERS = new Set(["anthropic", "moonshot", "zai"]);

Mistral non c'è. Quando il provider è mistral, il pruning viene completamente saltato — l'extension non viene nemmeno creata. Il ttl: "1h" nel tuo config è stato ignorato da sempre.

Cosa puoi fare

Il compaction (safeguard — che hai già configurato) è provider-agnostic e funziona con Mistral, ma scatta solo quando il contesto si avvicina al limite della context window. Con messaggi vocali corti, non lo
raggiunge mai → la sessione cresce senza fine.

L'opzione più pratica adesso è resettare la sessione manualmente:

mv ~/.openclaw/agents/main/sessions/42a93d39-9cae-4672-84de-37a9d381acfe.jsonl \
 ~/.openclaw/agents/main/sessions/42a93d39-9cae-4672-84de-37a9d381acfe.jsonl.bak

Al prossimo PTT ne crea una nuova. Il primo input dovrebbe scendere da ~38K a ~2-4K token. Il .bak resta come backup se vuoi recuperarlo.

Vuoi che lo faccia?

✻ Churned for 2m 22s

─────────────────────────────────────────────────────────────────

#token=b3b4ea68210eb76a9b069b183f2b27de1f54d12151b7d462

pnpm openclaw devices approve --latest

pnpm openclaw dashboard --no-open
