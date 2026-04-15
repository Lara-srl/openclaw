import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { XiaozhiBridge } from "./bridge.js";
import { AdaUiState, buildUiState } from "./ui-state.js";

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
    name: "laragoci_status",
    label: "LaraGoci Status",
    description: "Get the current connection status of the LaraGoci device.",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const bridge = getBridge();
      if (!bridge) return ok({ connected: false });
      return ok({ connected: true, sessions: bridge.sessionCount });
    },
  });

  api.registerTool({
    name: "laragoci_speak",
    label: "LaraGoci Speak",
    description: "Speak text aloud on the LaraGoci device speaker via TTS.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to speak on the device." }),
    }),
    async execute(_id, params) {
      if (!getBridge()) return notConnected();
      // TTS is handled by the audio pipeline, not by a device MCP tool.
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
      const bridge = getBridge();
      if (!bridge) return notConnected();
      bridge.sendToActiveSession(buildUiState(AdaUiState.ACTING, { text: params.emotion }));
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
      const bridge = getBridge();
      if (!bridge) return notConnected();
      try {
        bridge.sendToActiveSession(buildUiState(AdaUiState.ACTING, { text: "Volume..." }));
        const result = await bridge.callDeviceMcp("tools/call", {
          name: "self.audio_speaker.set_volume",
          arguments: { volume: params.level },
        });
        bridge.sendToActiveSession(buildUiState(AdaUiState.IDLE));
        return ok({ ok: true, level: params.level, result });
      } catch (err) {
        bridge.sendToActiveSession(buildUiState(AdaUiState.IDLE));
        return ok({ ok: false, error: String(err) });
      }
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
      // No firmware MCP tool for audio URL playback yet.
      return ok({ ok: true, url: params.url });
    },
  });

  // --- New hardware MCP tools ---

  api.registerTool({
    name: "laragoci_led",
    label: "LaraGoci LED",
    description:
      "Control the LED on the LaraGoci device. Set color (hex), mode (static/pulse/blink), and optional duration.",
    parameters: Type.Object({
      hex_color: Type.String({
        description: "LED color as 6-char hex string, e.g. 'FF0000' for red, '00FF00' for green.",
      }),
      mode: Type.Optional(
        Type.String({
          description: "LED mode: 'static' (default), 'pulse', or 'blink'.",
        }),
      ),
      duration_ms: Type.Optional(
        Type.Number({
          description: "Auto-off duration in milliseconds (0 = stay on). Max 60000.",
          minimum: 0,
          maximum: 60000,
        }),
      ),
    }),
    async execute(_id, params) {
      const bridge = getBridge();
      if (!bridge) return notConnected();
      try {
        bridge.sendToActiveSession(buildUiState(AdaUiState.ACTING, { text: "LED..." }));
        const result = await bridge.callDeviceMcp("tools/call", {
          name: "self.led.set",
          arguments: {
            hex_color: params.hex_color,
            mode: params.mode ?? "static",
            duration_ms: params.duration_ms ?? 0,
          },
        });
        bridge.sendToActiveSession(buildUiState(AdaUiState.IDLE));
        return ok({ ok: true, color: params.hex_color, mode: params.mode ?? "static", result });
      } catch (err) {
        bridge.sendToActiveSession(buildUiState(AdaUiState.IDLE));
        return ok({ ok: false, error: String(err) });
      }
    },
  });

  api.registerTool({
    name: "laragoci_haptic",
    label: "LaraGoci Haptic",
    description: "Trigger haptic/audio feedback on the LaraGoci device.",
    parameters: Type.Object({
      pattern: Type.String({
        description: "Feedback pattern: 'short', 'double', or 'long'.",
      }),
    }),
    async execute(_id, params) {
      const bridge = getBridge();
      if (!bridge) return notConnected();
      try {
        const result = await bridge.callDeviceMcp("tools/call", {
          name: "self.haptic.feedback",
          arguments: { pattern: params.pattern },
        });
        return ok({ ok: true, pattern: params.pattern, result });
      } catch (err) {
        return ok({ ok: false, error: String(err) });
      }
    },
  });

  api.registerTool({
    name: "laragoci_sensor",
    label: "LaraGoci Sensor",
    description:
      "Read sensor data from the LaraGoci device (battery level, charging status, volume).",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const bridge = getBridge();
      if (!bridge) return notConnected();
      try {
        const result = await bridge.callDeviceMcp("tools/call", {
          name: "self.sensor.read",
          arguments: {},
        });
        return ok({ ok: true, data: result });
      } catch (err) {
        return ok({ ok: false, error: String(err) });
      }
    },
  });

  api.registerTool({
    name: "laragoci_photo",
    label: "LaraGoci Photo",
    description:
      "Take a photo with the LaraGoci device camera. Optionally provide a question for the vision model to answer about the image.",
    parameters: Type.Object({
      question: Type.Optional(
        Type.String({
          description: "Question to ask about the captured image (e.g. 'What do you see?').",
        }),
      ),
    }),
    async execute(_id, params) {
      const bridge = getBridge();
      if (!bridge) return notConnected();
      try {
        bridge.sendToActiveSession(buildUiState(AdaUiState.ACTING, { text: "Foto..." }));
        const result = await bridge.callDeviceMcp(
          "tools/call",
          {
            name: "self.camera.take_photo",
            arguments: { question: params.question ?? "Describe what you see." },
          },
          10_000, // Camera + vision API needs longer timeout
        );
        bridge.sendToActiveSession(buildUiState(AdaUiState.IDLE));
        return ok({ ok: true, result });
      } catch (err) {
        bridge.sendToActiveSession(buildUiState(AdaUiState.IDLE));
        return ok({ ok: false, error: String(err) });
      }
    },
  });
}
