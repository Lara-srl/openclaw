# 01 — Piano di Scaffolding: estensione `xiaozhi`

_Data: 2026-03-14 — Aggiornato: 2026-03-14_

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

## Stato file (aggiornato 2026-03-14 task 1.2/1.3/1.4)

```
extensions/xiaozhi/
├── openclaw.plugin.json      # manifest plugin ✅
├── package.json              # dipendenze estensione ✅
├── index.ts                  # entry point — channel + tools + lifecycle + WS handler ✅
└── src/
    ├── bridge.ts             # WebSocket bridge COMPLETO ✅ (1.4)
    ├── protocol.ts           # parser + buildHello/Stt/Llm/Tts ✅ (1.3)
    ├── audio-pipeline.ts     # Opus ↔ PCM, VAD, Whisper STT, TTS (stub — Phase 2) ✅
    ├── channel.ts            # ChannelPlugin "xiaozhi" completo ✅
    ├── config.ts             # configurazione estensione ✅
    ├── ota.ts                # endpoint OTA HTTP — implementato ✅ (1.5)
    ├── tools.ts              # 5 tool MCP stub (Phase 2 li implementa) ✅
    └── types.ts              # tipi TypeScript condivisi ✅
```

### File core modificati (task 1.2)

```
src/plugins/types.ts              # OpenClawPluginWsUpgradeHandler + registerWsUpgradeHandler ✅
src/plugins/registry.ts           # PluginWsUpgradeRegistration + wsUpgradeHandlers[] ✅
src/gateway/server/plugins-ws.ts  # createGatewayPluginWsUpgradeHandler (NUOVO) ✅
src/gateway/server-http.ts        # attachGatewayUpgradeHandler: pluginUpgradeHandler param ✅
src/gateway/server-runtime-state.ts  # crea handler + lo passa all'upgrade handler ✅
src/plugin-sdk/index.ts           # export OpenClawPluginWsUpgradeHandler ✅
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

## Modifica al core (completata 2026-03-14)

Implementato pattern `registerWsUpgradeHandler` end-to-end:

- `OpenClawPluginWsUpgradeHandler` nel tipo + `PluginRegistry.wsUpgradeHandlers[]`
- `createGatewayPluginWsUpgradeHandler` factory (analogo a `plugins-http.ts`)
- `attachGatewayUpgradeHandler` accetta `pluginUpgradeHandler?` opzionale
- `server-runtime-state.ts` crea e passa il handler composito
- `plugin-sdk/index.ts` esporta il tipo per le estensioni

## Step successivi

1. ~~Completare `src/channel.ts`~~ ✅
2. ~~Completare `src/tools.ts`~~ ✅
3. ~~Collegare `index.ts` al channel e ai tools~~ ✅
4. ~~**Patch WS upgrade handler** — plugin SDK + registry + server-http + bridge WS~~ ✅ (1.2+1.3+1.4)
5. ~~**SSL/TLS su `laragoci.lara-ai.eu`**~~ ✅ — Cloudflare Tunnel attivo, OTA verificato 2026-03-15
6. **⏭ Prossimo step: Flash firmware XiaoZhi su ESP32-S3-BOX-3** (P3 roadmap) — vedi `Note/02_device.md`
7. Test locale con wscat: `wscat -c ws://127.0.0.1:18789/xiaozhi/v1/ -H "Device-Id: test-001"`
8. Test con ESP32 fisico
9. Fase 2: audio pipeline (Opus, VAD, Whisper, TTS)

## Dipendenze da aggiungere

- `ws` — WebSocket server
- `opusscript` o `@discordjs/opus` — codec Opus
- `openai` (Whisper) — già disponibile nel core OpenClaw
