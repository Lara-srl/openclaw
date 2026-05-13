# XiaoZhi Extension — Ada Voice Gateway

OpenClaw plugin that turns the gateway into a real-time voice assistant bridge for ESP32 devices (SenseCAP Watcher, ESP32-S3-BOX-3).

Audio streams over WebSocket (Opus codec), gets transcribed, processed by an LLM, and spoken back — all within the EU.

```
[ESP32 Device] ←—WS/Opus—→ [OpenClaw Gateway] ←—API—→ [Mistral Paris]
    firmware                  extensions/xiaozhi/         STT + LLM + TTS
```

## Voice Pipeline (EU Stack)

| Stage | Model                                  | Provider        |
| ----- | -------------------------------------- | --------------- |
| STT   | Voxtral Mini                           | Mistral (Paris) |
| LLM   | Mistral Small (fallback: Claude, Groq) | Mistral (Paris) |
| TTS   | Voxtral Mini TTS                       | Mistral (Paris) |

All processing stays on EU servers. Custom voice cloning supported via [Mistral Console](https://console.mistral.ai).

## Features

### Audio Pipeline (`audio-pipeline.ts` — 1,126 LOC)

State machine: **IDLE → LISTENING → PROCESSING → SPEAKING → IDLE**

- **Opus codec**: 16kHz mono upload, 24kHz mono download (60ms frames)
- **Sentence splitter**: Extracts complete sentences from streaming LLM output
- **1-ahead TTS prefetch**: While chunk N plays on device, chunk N+1 is already being synthesized — zero gap between sentences
- **PCM normalization**: Bidirectional gain control (configurable via `XIAOZHI_TTS_GAIN`)
- **Voxtral handling**: JSON unwrap, float32-to-int16 conversion, resampling
- **NO_REPLY suppression**: Silent token detection prevents empty TTS calls
- **Model fallback**: Automatic retry with alternative LLM on failure (`runWithModelFallback`)

### MCP Hardware Tools (`tools.ts`)

Control device hardware through voice or chat:

| Tool            | Description                                         |
| --------------- | --------------------------------------------------- |
| `ada_status`    | Check device connectivity                           |
| `ada_speak`     | Queue text-to-speech                                |
| `ada_emoji`     | Display emotion on LCD                              |
| `ada_volume`    | Speaker volume (0-100)                              |
| `ada_play`      | Sound effects (success, vibration, exclamation)     |
| `ada_eye_color` | Set eye color (hex)                                 |
| `ada_led`       | RGB LED (color, mode: static/pulse/blink, duration) |
| `ada_haptic`    | Vibration feedback                                  |
| `ada_sleep`     | Enter sleep mode via voice command                  |

### Session Rotation (`context-manager.ts`)

Automatic session management to prevent context overflow:

- **Nightly rotation**: Scheduled at configurable hour (default 3 AM), minimum token threshold
- **Threshold rotation**: Post-response check against max tokens (default 25K)
- **Memory persistence**: LLM summary of last 15 messages saved to `workspace/memory/YYYY-MM-DD-<slug>.md`
- **Seamless**: New session auto-loads MEMORY.md as bootstrap context

### Camera Vision (`vision-proxy.ts`)

- Device POSTs JPEG + question via `/xiaozhi/vision`
- Image analyzed by Pixtral (multimodal LLM)
- Response returned as JSON

### OTA Configuration (`ota.ts`)

- Endpoint: `/xiaozhi/ota/` — returns WebSocket URL, server time, firmware info
- HMAC-SHA256 token authentication for device identity

### Bridge & Device Management (`bridge.ts`)

- WebSocket server with per-device session tracking
- Auto-reconnect support with pending TTS queue (frames replayed on reconnect)
- MCP JSON-RPC 2.0 routing with 5s timeout
- Hardware effect persistence (LED survives UI state changes)
- Deferred action queue with 400ms inter-action delay

## Core OpenClaw Modifications

### TTS Core (`src/tts/tts-core.ts`)

- Voxtral voice_id support (UUID instead of OpenAI voice name)
- JSON response unwrapping for Mistral TTS API
- Float32-to-int16 PCM conversion
- Configurable resampling and normalization

### Session Reset (`src/agents/pi-embedded-runner/reset.ts`)

- `resetEmbeddedPiSession()` primitive exported via extension API
- Fires `command/new` hook for memory persistence
- Atomic session store update (new UUID, reset tokens, preserve model)
- Transcript archival (`.jsonl.reset.<timestamp>`)

## Supported Devices

| Device                      | Button Mode   | Features                                           |
| --------------------------- | ------------- | -------------------------------------------------- |
| **SenseCAP Watcher** (~$59) | Click-to-talk | Auto-sleep 30s, deep sleep, charging sleep, camera |
| **ESP32-S3-BOX-3**          | Hold-to-talk  | Development board                                  |

Firmware repository: [Lara-srl/xiaozhi-openclaw](https://github.com/Lara-srl/xiaozhi-openclaw)

## Quick Start

### Environment

```bash
export MISTRAL_API_KEY=<your-key>
export OPENAI_TTS_BASE_URL=https://api.mistral.ai/v1
export XIAOZHI_TTS_GAIN=0.85  # optional, default 0.85
```

### Plugin Config (`~/.openclaw/openclaw.json`)

```json
{
  "messages": {
    "stt": { "provider": "mistral" },
    "llm": { "provider": "mistral", "model": "mistral-small-latest" },
    "tts": {
      "provider": "openai",
      "openai": { "voice": "<your-voice-uuid>" }
    }
  },
  "plugins": {
    "xiaozhi": {
      "enabled": true,
      "secret": "<optional-hmac-secret>",
      "compaction": {
        "enabled": true,
        "nightly": { "enabled": true, "hour": 3, "minTokens": 8000 },
        "threshold": { "enabled": true, "maxTokens": 25000 }
      },
      "personality": {
        "name": "Ada",
        "language": "it"
      }
    }
  }
}
```

### Run

```bash
openclaw gateway run --bind loopback --port 18789 --force
```

### Connect Device

On first boot, the ESP32 enters AP mode (captive portal). Configure your WiFi credentials and the gateway server address.

## Environment Variables

| Variable              | Required | Description                                      |
| --------------------- | -------- | ------------------------------------------------ |
| `MISTRAL_API_KEY`     | Yes      | Voxtral STT + Mistral LLM auth                   |
| `OPENAI_TTS_BASE_URL` | Yes      | TTS endpoint (`https://api.mistral.ai/v1`)       |
| `XIAOZHI_TTS_GAIN`    | No       | PCM normalization target (0.1-1.0, default 0.85) |
| `GROQ_API_KEY`        | No       | Groq fallback LLM                                |
| `ANTHROPIC_API_KEY`   | No       | Claude fallback LLM                              |

## File Structure

```
extensions/xiaozhi/
├── src/
│   ├── audio-pipeline.ts    # State machine, STT/TTS pipeline, streaming
│   ├── bridge.ts            # WebSocket server, device sessions, MCP routing
│   ├── tools.ts             # Ada MCP hardware tools (9 tools)
│   ├── context-manager.ts   # Session rotation (nightly + threshold)
│   ├── config.ts            # Plugin config schemas (Zod)
│   ├── core-bridge.ts       # Core agent dependency bridge
│   ├── vision-proxy.ts      # Camera vision HTTP handler
│   ├── channel.ts           # Channel plugin registration
│   ├── protocol.ts          # XiaoZhi protocol message builders
│   ├── types.ts             # TypeScript type definitions
│   ├── ui-state.ts          # Ada UI state constants (13 states)
│   ├── ota.ts               # OTA configuration endpoint
│   └── index.ts             # Plugin lifecycle
└── package.json
```

## Docker Deployment

```bash
docker build -t openclaw:multi-tenant .
docker run -d \
  --name gw-user1 \
  -v /data/users/user1/state:/home/node/.openclaw \
  --env-file /data/shared/env.shared \
  -p 18789:18789 \
  openclaw:multi-tenant \
  node dist/index.js gateway --bind lan --port 18789 --force
```

## License

MIT
