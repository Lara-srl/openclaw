import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { XiaozhiBridge } from "./bridge.js";
import { getActiveBridge } from "./channel.js";
import { AdaUiState, buildEyeColor, buildUiState } from "./ui-state.js";

const ok = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

const notConnected = () => ok({ ok: false, error: "No device connected" });

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
    label: "Ada Status",
    description: "Controlla il mio stato di connessione e se sono online.",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const bridge = getBridge();
      if (!bridge) return ok({ connected: false });
      return ok({ connected: true, sessions: bridge.sessionCount });
    },
  });

  api.registerTool({
    name: "laragoci_speak",
    label: "Ada Speak",
    description: "Parlo ad alta voce tramite il mio altoparlante usando TTS.",
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
    label: "Ada Emoji",
    description: "Mostro un'emozione sul mio schermo LCD (la mia faccia).",
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
    label: "Ada Volume",
    description: "Regolo il volume del mio altoparlante (0-100).",
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
    label: "Ada Play",
    description:
      "Riproduco un suono dal mio altoparlante. Suoni disponibili: success, vibration, exclamation, popup, welcome. Usa repeat per ripetere.",
    parameters: Type.Object({
      url: Type.String({
        description: "Sound name: success, vibration, exclamation, popup, welcome.",
      }),
      repeat: Type.Optional(
        Type.Number({
          description: "How many times to play the sound (default 1, max 20).",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    async execute(_id, params) {
      const bridge = getBridge();
      if (!bridge) return notConnected();
      const count = Math.min(Math.max(Math.round(params.repeat ?? 1), 1), 20);
      for (let i = 0; i < count; i++) {
        bridge.queueDeferredHwAction({
          key: `play-${Date.now()}-${i}`,
          mcpName: "self.audio_player.play",
          args: { url: params.url },
          durationMs: 0,
          persist: false,
        });
      }
      return ok({ ok: true, queued: true, url: params.url, repeat: count });
    },
  });

  api.registerTool({
    name: "laragoci_eye_color",
    label: "Ada Eye Color",
    description:
      "Cambio il colore dei miei occhi sul display. DEVO usare questo tool quando l'utente chiede di cambiare colore degli occhi. Colori comuni: rosso=FF0000, verde=00FF00, blu=0000FF, giallo=FFFF00, viola=800080, arancione=FF8C00, bianco=FFFFFF, azzurro=00AAFF (default).",
    parameters: Type.Object({
      hex_color: Type.String({
        description:
          "Eye color as 6-char hex string. Common colors: FF0000=red, 00FF00=green, 0000FF=blue, FFFF00=yellow, 800080=purple, FF8C00=orange, FFFFFF=white, 00AAFF=default blue.",
      }),
    }),
    async execute(_id, params) {
      const bridge = getBridge();
      if (!bridge) return notConnected();
      console.log(`[laragoci_eye_color] setting color to #${params.hex_color}`);
      bridge.sendToActiveSession(buildEyeColor(params.hex_color));
      return ok({ ok: true, color: params.hex_color });
    },
  });

  // --- Hardware MCP tools ---

  api.registerTool({
    name: "laragoci_led",
    label: "Ada LED",
    description:
      "Controllo il mio LED. Imposto colore (hex), modalità (static/pulse/blink) e durata.",
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
        persist: true,
      });
      return ok({ ok: true, queued: true, color: params.hex_color, mode: mcpArgs.mode });
    },
  });

  api.registerTool({
    name: "laragoci_haptic",
    label: "Ada Haptic",
    description:
      "Attivo il mio buzzer/vibrazione. Usa repeat per ripetere (es. 'vibra 5 volte' → repeat=5).",
    parameters: Type.Object({
      pattern: Type.String({
        description: "Feedback pattern: 'short', 'double', or 'long'.",
      }),
      repeat: Type.Optional(
        Type.Number({
          description: "How many times to repeat the feedback (default 1, max 20).",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    async execute(_id, params) {
      const bridge = getBridge();
      if (!bridge) return notConnected();
      const count = Math.min(Math.max(Math.round(params.repeat ?? 1), 1), 20);
      for (let i = 0; i < count; i++) {
        bridge.queueDeferredHwAction({
          key: `haptic-${Date.now()}-${i}`,
          mcpName: "self.haptic.feedback",
          args: { pattern: params.pattern },
          durationMs: 0,
          persist: false,
        });
      }
      return ok({ ok: true, queued: true, pattern: params.pattern, repeat: count });
    },
  });

  api.registerTool({
    name: "laragoci_sensor",
    label: "Ada Sensor",
    description: "Leggo i miei sensori: livello batteria, stato ricarica, volume.",
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
    label: "Ada Photo",
    description:
      "Scatto una foto con la MIA fotocamera e descrivo quello che vedo IO. Opzionalmente ricevo una domanda sull'immagine.",
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

        // Device captures photo → POSTs to /xiaozhi/vision → returns description
        const result = (await bridge.callDeviceMcp(
          "tools/call",
          {
            name: "self.camera.take_photo",
            arguments: { question: photoQuestion },
          },
          30_000, // Camera capture + vision proxy analysis needs longer timeout
        )) as Record<string, unknown> | undefined;

        console.log("[laragoci_photo] MCP result:", JSON.stringify(result));

        // Firmware returns {"success": true, "result": "description"} from vision proxy
        const description =
          typeof result?.result === "string"
            ? result.result
            : typeof result?.description === "string"
              ? result.description
              : typeof result?.text === "string"
                ? result.text
                : null;

        return ok({
          ok: true,
          description: description ?? "Photo taken but no description received from device.",
          question: photoQuestion,
        });
      } catch (err) {
        return ok({ ok: false, error: String(err) });
      }
    },
  });
}
