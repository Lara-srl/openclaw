import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { XiaozhuConfig } from "./config.js";

/**
 * Build the WSS URL the device should connect to.
 * Derives the host from the incoming request (Host header) so the endpoint
 * works transparently whether served over HTTP (local dev) or HTTPS (production).
 */
function resolveWsUrl(req: IncomingMessage, wsPath: string): string {
  const host = req.headers.host ?? "localhost";
  const isSecure =
    req.headers["x-forwarded-proto"] === "https" ||
    (req.socket as { encrypted?: boolean }).encrypted === true;
  const scheme = isSecure ? "wss" : "ws";
  const path = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  return `${scheme}://${host}${path}`;
}

/**
 * Generate HMAC-SHA256 token for the device.
 * Used by the device to authenticate the WS connection.
 * Returns empty string when no secret is configured (open mode).
 */
function generateToken(deviceId: string, secret: string): string {
  return createHmac("sha256", secret).update(deviceId).digest("hex");
}

/**
 * Handle OTA configuration requests from XiaoZhi devices.
 * The device calls this on boot to discover the WebSocket URL and auth token.
 */
export function handleOtaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: XiaozhuConfig,
): void {
  const deviceId = (req.headers["device-id"] as string | undefined) ?? "";
  const wsUrl = resolveWsUrl(req, config.wsPath);
  const token = config.secret ? generateToken(deviceId, config.secret) : "";

  const body = JSON.stringify({
    websocket: { url: wsUrl, token },
    server_time: {
      timestamp: Math.floor(Date.now() / 1000),
      timezone_offset: 3600, // UTC+1 (Italy)
    },
    firmware: { version: "", url: "" },
  });
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
