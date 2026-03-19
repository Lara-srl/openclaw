import type { XiaozhuMessage } from "./types.js";

/**
 * Parse a raw WebSocket message from a XiaoZhi device.
 * TODO: implement full XiaoZhi protocol framing (Phase 2).
 */
export function parseMessage(data: string | Buffer): XiaozhuMessage {
  const text = typeof data === "string" ? data : data.toString("utf8");
  // TODO: validate against XiaoZhi protocol schema
  return JSON.parse(text) as XiaozhuMessage;
}

/**
 * Build the initial hello frame sent to a connecting device.
 * version, session_id, transport and audio_params are all required —
 * the firmware crashes in ParseServerHello() if any field is missing.
 */
export function buildHello(sessionId: string): string {
  return JSON.stringify({
    type: "hello",
    version: 3,
    session_id: sessionId,
    transport: "websocket",
    audio_params: {
      format: "opus",
      sample_rate: 16000,
      channels: 1,
      frame_duration: 60,
    },
  });
}

/** Build a speech-to-text result frame. */
export function buildStt(text: string): string {
  return JSON.stringify({ type: "stt", text });
}

/** Build an LLM response frame. */
export function buildLlm(text: string, emotion = "neutral"): string {
  return JSON.stringify({ type: "llm", text, emotion });
}

/** Build a TTS control frame (start / sentence_start / stop). */
export function buildTts(action: "start" | "sentence_start" | "stop", text?: string): string {
  return JSON.stringify({ type: "tts", action, ...(text ? { text } : {}) });
}
