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
  /** listen mode: "auto" (VAD), "manual" (hold-to-talk), "realtime" (continuous) */
  mode?: "auto" | "manual" | "realtime";
  text?: string;
  emotion?: string;
  /** For type:"audio" — raw Opus frame buffer (protocol v1, no header) */
  payload?: Buffer;
  /** For type:"mcp" — parsed JSON-RPC response from device. */
  mcpPayload?: McpJsonRpcResponse;
};

/** JSON-RPC 2.0 response from device MCP tool call. */
export type McpJsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: { content: Array<{ type: string; text: string }>; isError: boolean };
  error?: { code: number; message: string };
};

/** Pending MCP call awaiting device response. */
export type McpPendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
