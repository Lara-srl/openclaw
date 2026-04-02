# Piano TTFT — XiaoZhi Context Router

> Data: 2026-04-01 | Ultimo aggiornamento: 2026-04-03
> Branch: `feat/ttft-voice-context`
> Commit: `86ecf86b8` (fix) + `97f6835d8` (feat)
> Obiettivo: ridurre il Time To First Token (TTFT) eliminando token inutili per il canale vocale.

---

## Stato implementazione: COMPLETATO

Tutti e 3 i livelli implementati e testati dal vivo.

| Livello                               | Stato | Commit                    |
| ------------------------------------- | ----- | ------------------------- |
| Voice Profile (`promptMode: "voice"`) | done  | `97f6835d8`               |
| Instant routing (bypass LLM)          | done  | `97f6835d8` + `86ecf86b8` |
| Conversation router (`disableTools`)  | done  | `97f6835d8`               |
| TTS sanitizer (strip markdown)        | done  | `86ecf86b8`               |
| Voice prompt rafforzato               | done  | `86ecf86b8`               |

---

## Risultati misurati (sessione 2026-04-03)

### TTFT per livello

| Scenario                        | TTFT medio | Totale medio | Livello      |
| ------------------------------- | ---------- | ------------ | ------------ |
| "Ciao" (instant)                | **~500ms** | ~1.3-2.2s    | instant      |
| "Come ti chiami?" (instant)     | **~900ms** | ~3.9s        | instant      |
| "Che tempo fa?" (instant meteo) | **~500ms** | ~4.9s        | instant      |
| "Quanto fa 10+10?" (LLM)        | **~2.2s**  | 3.4s         | conversation |
| "Raccontami una storia" (LLM)   | **~1.8s**  | 8.9s         | conversation |
| Domanda complessa (LLM)         | **~2.6s**  | 12-19s       | conversation |

### Breakdown tempo per fase

```
              Instant        LLM (no tools)
              ---------      --------------
STT           ~320ms (52%)   ~350ms (13%)
Router        ~0ms           ~0ms
LLM 1a frase  -              ~1800ms (69%)
TTS prefetch  ~230ms (38%)   ~350ms (13%)
1o frame      60ms (10%)     60ms (2%)
              ---------      --------------
TTFT          ~600ms         ~2600ms
```

---

## Architettura

### Flusso

```
Audio -> STT -> testo
                |
                +-- routeToInstant(text)?
                |     +-- match -> risposta locale -> TTS -> done   (~500ms)
                |
                +-- hasToolIntent(text)?
                |     +-- no  -> runAgent(disableTools:true,  promptMode:"voice")
                |     +-- si  -> runAgent(disableTools:false, promptMode:"voice")
                |
                +-- (voice profile sempre attivo in entrambi i casi)
```

### File modificati

| File                                                | Modifica                                                    |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `src/agents/system-prompt.ts:17`                    | `PromptMode` include `"voice"`                              |
| `src/agents/system-prompt.ts:377`                   | `isVoice` guard su 8 sezioni                                |
| `src/agents/pi-embedded-runner/run/attempt.ts:177`  | `resolvePromptModeForSession` con `messageProvider`         |
| `extensions/xiaozhi/src/audio-pipeline.ts`          | `routeToInstant()` + `hasToolIntent()` + `sanitizeForTts()` |
| `extensions/xiaozhi/src/core-bridge.ts:28`          | `disableTools` nel tipo params                              |
| `src/agents/pi-embedded-runner/run/attempt.test.ts` | 3 test nuovi per voice mode                                 |

---

## Instant routing — pattern e risposte

### Pattern attuali (regex parziali, case-insensitive dopo normalizzazione)

| Pattern                                           | Trigger esempi              | Risposta                                                              |
| ------------------------------------------------- | --------------------------- | --------------------------------------------------------------------- |
| `^(ciao\|hey\|ehi\|salve\|buongiorno...)(\s\|$)`  | "ciao", "ehi", "buongiorno" | random: "Ciao!", "Ehi, ciao!", "Ciao, dimmi tutto!", "Eccomi, dimmi!" |
| `^(grazie\|ti ringrazio\|perfetto grazie)`        | "grazie", "grazie mille"    | random: "Di niente!", "Figurati!", "Prego!"                           |
| `^(arrivederci\|ciao ciao\|ci vediamo...)(\s\|$)` | "arrivederci", "a dopo"     | random: "Ciao, a presto!", "A dopo!"                                  |
| `(chi sei\|come ti chiami\|qual e il tuo nome)`   | "chi sei", "come ti chiami" | random: "Sono il tuo assistente vocale OpenClaw!"                     |
| `^(come stai\|tutto bene\|come va)`               | "come stai", "come va"      | random: "Tutto bene, grazie!", "Alla grande!"                         |
| `(che ora e\|che ore sono\|dimmi lora)`           | "che ore sono"              | dinamico: "Sono le HH:MM."                                            |
| `(che giorno e\|che data e\|data di oggi)`        | "che giorno e oggi"         | dinamico: "Oggi e [data]."                                            |
| `(che tempo fa\|meteo\|previsioni\|piove...)`     | "che tempo fa", "piove?"    | random: "Non ho accesso al meteo..."                                  |

### Bug noti nei pattern

1. **Priorita "ciao" vs "come ti chiami"**: "Ciao. Come ti chiami?" matcha "ciao" (primo pattern) e risponde "Eccomi, dimmi!" invece di "Sono OpenClaw". Fix: invertire ordine pattern o gestire match multipli.
2. **Skip >12 parole**: frasi lunghe saltano l'instant routing per evitare falsi positivi. Threshold da calibrare.
3. **STT noise**: "Che risuono?", "Che finzione ti gustasera?" — Voxtral STT interpreta male audio rumoroso/veloce. Non risolvibile lato router.

---

## Tool intent — keyword detection

### Keyword attuali

```
cerca, trova, google, manda, scrivi, invia, messaggio,
leggi, ricorda, calendario, promemoria, esegui, scatta,
foto, apri, chiudi, accendi, spegni, timer, sveglia, alarm
```

Match: `startsWith(keyword)` su ogni parola normalizzata.

Se nessuna keyword trovata -> `disableTools: true` (LLM senza tool).

---

## TTS sanitizer

`sanitizeForTts(text)` applicata a ogni chunk prima di mandare a Mistral TTS.

Rimuove:

- `**bold**`, `*italic*`, `__underline__` -> testo pulito
- `` `code` `` -> testo pulito
- `## Header` -> testo pulito
- `- item` / `1. item` -> testo pulito
- Smart quotes -> straight quotes
- `[link](url)` -> solo testo
- `~`, `` ` ``, `>` stray
- Newline multipli -> spazio singolo

Motivo: Mistral TTS ritorna HTTP 500 su testo con virgolette speciali, backtick, markdown.

---

## Voice prompt (extraSystemPrompt)

```
MODALITA VOCALE — priorita assoluta su tutto il resto:
- Domanda semplice -> 1-2 frasi. Domanda complessa -> max 4-5 frasi.
- VIETATO usare markdown: niente **, *, `, #, elenchi con - o numeri. Rispondi SOLO in prosa fluente.
- VIETATO premesse, intro o recap — vai diretto alla risposta.
- Il tuo output viene letto ad alta voce da un sintetizzatore TTS. Scrivi come parleresti.
- Se non sai qualcosa, dillo in una frase. Non elencare alternative.
```

### Problemi osservati

L'LLM (mistral-small-latest) ignora parzialmente queste istruzioni:

- Genera ancora elenchi puntati su risposte lunghe
- Usa `**bold**` occasionalmente
- Risposte troppo verbose (>5 frasi) su domande aperte
- Il sanitizer TTS mitiga ma non risolve il problema alla radice

---

## Voice Profile — sezioni system prompt

`promptMode: "voice"` salta queste sezioni (tramite `isVoice` guard):

| Sezione                       | Risparmio stimato              | Motivo skip                    |
| ----------------------------- | ------------------------------ | ------------------------------ |
| Messaging (routing canali)    | ~600 ch                        | XiaoZhi non ha cross-session   |
| Docs (openclaw docs path)     | ~200 ch                        | Irrilevante per voce           |
| Self-Update (gateway restart) | ~300 ch                        | Non serve per voce             |
| Model Aliases                 | ~200 ch                        | Non serve per voce             |
| Silent Replies                | ~200 ch                        | Voice ha silentAck dedicato    |
| Heartbeats                    | ~200 ch                        | Non serve per voce             |
| Memory Recall                 | ~100 ch                        | Nessun memory tool attivo      |
| Authorized Senders            | ~100 ch                        | Device fisico, no multi-sender |
| Reply Tags                    | ~300 ch                        | Nessun reply tag per voce      |
| **Totale**                    | **~2200 ch / ~800-1000 token** |                                |

Sezioni mantenute: Safety, Skills, Workspace, Runtime, Voice TTS, Tooling, Tool Call Style, CLI Reference.

---

## Log e debug

### Log prefix

| Prefix                             | Significato                                      |
| ---------------------------------- | ------------------------------------------------ |
| `[XZ INSTANT] MATCH`               | Pattern instant matchato — bypass LLM            |
| `[XZ INSTANT] no match`            | Nessun match — passa a LLM                       |
| `[XZ INSTANT] skip`                | Input troppo lungo (>12 parole) — skip instant   |
| `[XZ ROUTER] tool intent detected` | Keyword tool trovata — tools attivi              |
| `[XZ ROUTER] conversation only`    | Nessun tool intent — `disableTools=true`         |
| `[XZ 2.5] TTS prefetch FAILED`     | Errore TTS (tipicamente Mistral 500 su markdown) |

### File di trace

- `/tmp/xiaozhi-llm-trace.jsonl` — trace JSONL di ogni chiamata LLM (input, output, timing, sessionFile)

### Avvio gateway (test)

```bash
MKEY=$(grep MISTRAL_API_KEY ~/.bashrc | cut -d= -f2-)
pkill -9 -f openclaw-gateway 2>/dev/null; sleep 1
MISTRAL_API_KEY="$MKEY" OPENAI_TTS_BASE_URL="https://api.mistral.ai/v1" \
  pnpm openclaw gateway run --bind loopback --port 18789 --force
```

---

## Prossimi step (TODO)

### P1 — Fix prioritari

- [ ] **Fix priorita pattern instant**: "Ciao. Come ti chiami?" matcha "ciao" invece di "come ti chiami". Opzioni: invertire ordine, longest-match, o match multipli.
- [ ] **Personalizzare risposte instant**: cambiare "Sono OpenClaw" con nome/personalita da SOUL.md (es. "Sono Lara").
- [ ] **Aggiungere pattern**: "cosa fai", "a cosa servi", "perfetto", "ok", "va bene" (frequenti nei test).

### P2 — Ottimizzazioni

- [ ] **Risposte LLM troppo verbose**: testare prompt piu aggressivo o `max_tokens` basso per conversazione senza tool.
- [ ] **TTS error retry**: su 500, ritentare una volta con testo ulteriormente semplificato (solo alfanumerico).
- [ ] **Misura token reali**: confrontare token input prima/dopo voice profile con log Mistral usage.

### P3 — Funzionalita future

- [ ] **Instant routing multilingua**: pattern inglese/spagnolo per utenti non italiani.
- [ ] **Instant routing da config**: pattern custom in `openclaw.json` invece che hardcoded.
- [ ] **Context-aware instant**: usare ultima risposta per gestire "grazie" / "ok" / "perfetto" in modo piu naturale.
