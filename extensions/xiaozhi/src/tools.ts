import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { XiaozhiBridge } from "./bridge.js";
import { getActiveBridge } from "./channel.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";
import { AdaUiState, buildUiState } from "./ui-state.js";

const ok = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

const notConnected = () => ok({ ok: false, error: "No LaraGoci device connected" });

/** Register all LaraGoci MCP tools on the plugin API. */
export function registerLaragociTools(
  api: OpenClawPluginApi,
  _getBridge: () => XiaozhiBridge | null,
): void {
  // Use module-level singleton from channel.ts instead of the closure-captured
  // getBridge — the closure's `runtime` is null when tools are loaded fresh
  // by resolvePluginTools() in a separate plugin-registry cache context.
  const getBridge = (): XiaozhiBridge | null => getActiveBridge();
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
        return ok({ ok: true, level: params.level, result });
      } catch (err) {
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
      const bridge = getBridge();
      if (!bridge) return notConnected();
      // Deferred: queue for execution after voice turn completes
      bridge.queueDeferredHwAction({
        key: "play",
        mcpName: "self.audio_player.play",
        args: { url: params.url },
        durationMs: 0,
      });
      return ok({ ok: true, queued: true, url: params.url });
    },
  });

  // --- Hardware MCP tools ---

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
      // Bug 3A: deferred — LED fires AFTER voice turn completes so firmware
      // SET_UI IDLE doesn't reset the timer. Full duration starts post-IDLE.
      const mcpArgs = {
        hex_color: params.hex_color,
        mode: params.mode ?? "static",
        duration_ms: params.duration_ms ?? 0,
      };
      bridge.queueDeferredHwAction({
        key: "led",
        mcpName: "self.led.set",
        args: mcpArgs,
        durationMs: mcpArgs.duration_ms,
      });
      return ok({ ok: true, queued: true, color: params.hex_color, mode: mcpArgs.mode });
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
      // Deferred: haptic fires after voice turn so user feels it at the right moment
      bridge.queueDeferredHwAction({
        key: "haptic",
        mcpName: "self.haptic.feedback",
        args: { pattern: params.pattern },
        durationMs: 0,
      });
      return ok({ ok: true, queued: true, pattern: params.pattern });
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
        const photoQuestion = params.question ?? "Describe what you see.";
        const result = await bridge.callDeviceMcp(
          "tools/call",
          {
            name: "self.camera.take_photo",
            arguments: { question: photoQuestion },
          },
          10_000, // Camera capture needs longer timeout
        );

        console.log("[laragoci_photo] MCP result:", JSON.stringify(result));

        // Path A: device returned a text description (explain URL configured on firmware)
        const textDescription = extractTextDescription(result);
        if (textDescription) {
          return ok({
            ok: true,
            description: textDescription,
            question: photoQuestion,
          });
        }

        // Path B: device returned base64 JPEG — analyze via vision model
        const imageBase64 = extractImageBase64(result);
        if (imageBase64) {
          bridge.sendToActiveSession(buildUiState(AdaUiState.ACTING, { text: "Analizzo..." }));
          const description = await analyzeImageViaAgent(imageBase64, photoQuestion);
          return ok({
            ok: true,
            description: description ?? "Photo taken but vision analysis failed.",
            question: photoQuestion,
          });
        }

        // Neither text nor image found — return raw result for debugging
        return ok({
          ok: true,
          description: "Photo taken but no image data or description received from device.",
          question: photoQuestion,
          rawResult: result,
        });
      } catch (err) {
        return ok({ ok: false, error: String(err) });
      }
    },
  });
}

// ─── Photo helpers (Bug 3B) ──────────────────────────────────────────────────

/** Extract a text description from the device MCP result (explain URL path). */
function extractTextDescription(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  // Direct text field from explain URL response
  if (typeof r.description === "string" && r.description.length > 0) return r.description;
  if (typeof r.text === "string" && r.text.length > 0) return r.text;
  if (typeof r.explanation === "string" && r.explanation.length > 0) return r.explanation;
  // MCP content array — look for short text (not base64)
  if (Array.isArray(r.content)) {
    for (const item of r.content) {
      if (item && typeof item === "object") {
        const c = item as Record<string, unknown>;
        if (c.type === "text" && typeof c.text === "string" && c.text.length > 0) {
          // Heuristic: if it looks like prose (not base64), treat as description
          if (c.text.length < 500 || !/^[A-Za-z0-9+/=\s]+$/.test(c.text.slice(0, 200))) {
            return c.text;
          }
        }
      }
    }
  }
  return null;
}

/** Extract base64 JPEG from device MCP result (various shapes). */
function extractImageBase64(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.image === "string") return r.image;
  if (typeof r.image_base64 === "string") return r.image_base64;
  if (typeof r.jpeg === "string") return r.jpeg;
  // Nested in content array (MCP standard)
  if (Array.isArray(r.content)) {
    for (const item of r.content) {
      if (item && typeof item === "object") {
        const c = item as Record<string, unknown>;
        if (c.type === "image" && typeof c.data === "string") return c.data;
        // Long text that looks like base64
        if (c.type === "text" && typeof c.text === "string" && c.text.length > 500) {
          if (/^[A-Za-z0-9+/=\s]+$/.test(c.text.slice(0, 200))) return c.text.trim();
        }
      }
    }
  }
  return null;
}

/** Analyze a base64 JPEG image using runEmbeddedPiAgent with vision model. */
async function analyzeImageViaAgent(base64: string, question: string): Promise<string | null> {
  let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
  try {
    deps = await loadCoreAgentDeps();
  } catch (err) {
    console.error("[laragoci_photo] core deps unavailable:", err);
    return null;
  }

  const sessionId = `vision-${Date.now()}`;
  const sessionFile = join(tmpdir(), `xiaozhi-vision-${sessionId}.jsonl`);

  try {
    const result = await deps.runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir: process.cwd(),
      prompt: question,
      provider: "mistral",
      model: "pixtral-large-latest",
      images: [{ type: "image", data: base64, mimeType: "image/jpeg" }],
      timeoutMs: 15_000,
      runId: `photo-${randomUUID()}`,
      disableTools: true,
    });

    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    return texts.join(" ") || null;
  } catch (err) {
    console.error("[laragoci_photo] vision agent error:", err);
    return null;
  }
}
