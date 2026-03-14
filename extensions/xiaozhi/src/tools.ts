import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { XiaozhiBridge } from "./bridge.js";

const ok = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

const notConnected = () => ok({ ok: false, error: "No LaraGoci device connected" });

/** Register all LaraGoci MCP tools on the plugin API. */
export function registerLaragociTools(
  api: OpenClawPluginApi,
  getBridge: () => XiaozhiBridge | null,
): void {
  api.registerTool({
    name: "laragoci_speak",
    label: "LaraGoci Speak",
    description: "Speak text aloud on the LaraGoci device speaker via TTS.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to speak on the device." }),
    }),
    async execute(_id, params) {
      if (!getBridge()) return notConnected();
      // TODO Phase 2: bridge.speak(params.text)
      return ok({ ok: true, queued: params.text });
    },
  });

  api.registerTool({
    name: "laragoci_emoji",
    label: "LaraGoci Emoji",
    description: "Display an emotion on the LaraGoci LCD screen.",
    parameters: Type.Object({
      emotion: Type.String({
        description: "Emotion to display (e.g. happy, sad, thinking, neutral).",
      }),
    }),
    async execute(_id, params) {
      if (!getBridge()) return notConnected();
      // TODO Phase 2: bridge.sendEmotion(params.emotion)
      return ok({ ok: true, emotion: params.emotion });
    },
  });

  api.registerTool({
    name: "laragoci_volume",
    label: "LaraGoci Volume",
    description: "Set the speaker volume on the LaraGoci device (0–100).",
    parameters: Type.Object({
      level: Type.Number({ description: "Volume level 0–100.", minimum: 0, maximum: 100 }),
    }),
    async execute(_id, params) {
      if (!getBridge()) return notConnected();
      // TODO Phase 2: bridge MCP tools/call → self.audio_speaker.set_volume
      return ok({ ok: true, level: params.level });
    },
  });

  api.registerTool({
    name: "laragoci_status",
    label: "LaraGoci Status",
    description: "Get the current connection status of the LaraGoci device.",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const bridge = getBridge();
      if (!bridge) return ok({ connected: false });
      // TODO Phase 2: return bridge.getDeviceStatus()
      return ok({ connected: true, sessions: 0 });
    },
  });

  api.registerTool({
    name: "laragoci_play",
    label: "LaraGoci Play",
    description: "Play an audio URL on the LaraGoci device speaker.",
    parameters: Type.Object({
      url: Type.String({ description: "Audio URL to play." }),
    }),
    async execute(_id, params) {
      if (!getBridge()) return notConnected();
      // TODO Phase 2: bridge.playAudio(params.url)
      return ok({ ok: true, url: params.url });
    },
  });
}
