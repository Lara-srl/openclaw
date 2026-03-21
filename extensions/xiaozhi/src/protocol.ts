import type { XiaozhuMessage } from "./types.js";

/**
 * Parse a raw WebSocket message from a XiaoZhi device.
 * Protocol v1: binary frames are raw Opus (no 4-byte header) — not JSON.
 */
export function parseMessage(data: string | Buffer): XiaozhuMessage {
  // B4: Opus binary frames start with any byte except '{' (0x7b)
  if (Buffer.isBuffer(data) && data[0] !== 0x7b) {
    return { type: "audio", payload: data };
  }
  const text = typeof data === "string" ? data : data.toString("utf8");
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
      sample_rate: 24000, // B1: device output sample rate is 24kHz
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
export function buildTts(state: "start" | "sentence_start" | "stop", text?: string): string {
  // B2: field name must be 'state', not 'action'
  return JSON.stringify({ type: "tts", state, ...(text ? { text } : {}) });
}
