import type { IncomingMessage } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { WebSocket } from "ws";
import type { XiaozhuConfig } from "./config.js";

export type { XiaozhuConfig };

export type XiaozhuRuntime = {
  bridge: import("./bridge.js").XiaozhiBridge;
  config: XiaozhuConfig;
  stop: () => Promise<void>;
};

/** Dependencies injected into XiaozhiBridge and AudioPipeline. */
export type BridgeDeps = {
  config: OpenClawConfig;
  runtime: PluginRuntime;
};

/** Represents a connected ESP32-S3-BOX-3 device session. */
export type DeviceSession = {
  id: string;
  ws: WebSocket;
  req: IncomingMessage;
  connectedAt: number;
  deviceId?: string;
};

/** XiaoZhi protocol message (JSON envelope). */
export type XiaozhuMessage = {
  type: string;
  /** listen / tts control state: "start" | "stop" | "detect" | "sentence_start" */
  state?: string;
  text?: string;
  emotion?: string;
  /** For type:"audio" — raw Opus frame buffer (protocol v1, no header) */
  payload?: Buffer;
};
