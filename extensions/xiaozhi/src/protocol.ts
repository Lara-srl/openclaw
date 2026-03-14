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
 */
export function buildHello(sessionId: string): string {
  return JSON.stringify({ type: "hello", sessionId });
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
