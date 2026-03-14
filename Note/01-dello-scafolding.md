# 01 — Piano di Scaffolding: estensione `xiaozhi`

_Data: 2026-03-14_

## Obiettivo

Creare l'estensione `extensions/xiaozhi/` nel repo OpenClaw che fa da bridge tra il firmware XiaoZhi (ESP32-S3-BOX-3) e l'agent loop OpenClaw (LaraGoci AI Companion Device).

## Flusso

```
ESP32 (XiaoZhi firmware)
  --WSS--> OpenClaw Gateway (extensions/xiaozhi bridge)
    --> Agente Claude (sessione main)
```

Il firmware parla protocollo XiaoZhi (7 messaggi JSON + audio Opus binario).
Il bridge traduce: Opus → Whisper STT → agente → TTS → Opus → device.

## Stato file (aggiornato 2026-03-14)

```
extensions/xiaozhi/
├── openclaw.plugin.json      # manifest plugin ✅
├── package.json              # dipendenze estensione ✅
├── index.ts                  # entry point — channel + tools + lifecycle ✅
└── src/
    ├── bridge.ts             # WebSocket bridge (stub — Phase 2) ✅
    ├── protocol.ts           # parser protocollo XiaoZhi (stub — Phase 2) ✅
    ├── audio-pipeline.ts     # Opus ↔ PCM, VAD, Whisper STT, TTS (stub — Phase 2) ✅
    ├── channel.ts            # ChannelPlugin "xiaozhi" completo ✅
    ├── config.ts             # configurazione estensione ✅
    ├── ota.ts                # endpoint OTA HTTP (stub 501) ✅
    ├── tools.ts              # 5 tool MCP stub (Phase 2 li implementa) ✅
    └── types.ts              # tipi TypeScript condivisi ✅
```

### Tool MCP registrati (stub)

| Tool              | Descrizione                     |
| ----------------- | ------------------------------- |
| `laragoci_speak`  | TTS testo → speaker device      |
| `laragoci_emoji`  | Emozione → display LCD          |
| `laragoci_volume` | Volume 0–100 via MCP tools/call |
| `laragoci_status` | Stato connessione device        |
| `laragoci_play`   | Play audio URL → speaker        |

### Note tecniche emerse

- `ChatType` corretto: `"direct"` (non `"dm"`)
- `ChannelConfigSchema` vuole `{ schema: Record<string,unknown> }` → usare `buildChannelConfigSchema(ZodSchema)`
- `AgentToolResult<T>`: `details` è obbligatorio (non optional) — usare pattern voice-call (type inferred, no alias locale)
- `Type.Union` in tool schema: vietato (CLAUDE.md guardrail) — un `Type.Object` per tool

## Modello architetturale

Studiato `extensions/voice-call/` (Twilio) come riferimento:

- struttura channel plugin
- gestione sessione audio bidirezionale
- integrazione con l'agent loop

## Unica modifica prevista al core

`src/gateway/server-http.ts` → aggiungere path `/xiaozhi/v1/` nell'upgrade handler WS.
Richiede: `registerWsUpgradeRoute` nel plugin registry + plugin-SDK + `plugins-http.ts`.

## Step successivi

1. ~~Completare `src/channel.ts`~~ ✅
2. ~~Completare `src/tools.ts`~~ ✅
3. ~~Collegare `index.ts` al channel e ai tools~~ ✅
4. **Patch WS upgrade handler** — `src/gateway/server-http.ts` + plugin-SDK (prossimo)
5. Test locale con ESP32 fisico
6. Documentazione in `docs/channels/xiaozhi.md`

## Dipendenze da aggiungere

- `ws` — WebSocket server
- `opusscript` o `@discordjs/opus` — codec Opus
- `openai` (Whisper) — già disponibile nel core OpenClaw
