import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { AudioPipeline } from "./audio-pipeline.js";
import { buildHello, parseMessage } from "./protocol.js";
import type { BridgeDeps, DeviceSession } from "./types.js";

export class XiaozhiBridge {
  private sessions = new Map<string, DeviceSession>();
  private wss: WebSocketServer;

  constructor(private deps: BridgeDeps) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) =>
      this.handleConnection(ws, req),
    );
  }

  /**
   * Called from the plugin WS upgrade handler.
   * Returns true if the request path matches and the upgrade was handled.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/xiaozhi/v1")) {
      return false;
    }
    // Cast needed: ws expects net.Socket but Duplex is compatible at runtime.
    this.wss.handleUpgrade(req, socket as never, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
    return true;
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const sessionId = randomUUID();
    const deviceId = req.headers["device-id"] as string | undefined;
    const session: DeviceSession = {
      id: sessionId,
      ws,
      req,
      connectedAt: Date.now(),
      deviceId,
    };
    this.sessions.set(sessionId, session);
    console.log(`[xiaozhi] connected session=${sessionId} device=${deviceId ?? "unknown"}`);

    // Handshake: send hello frame
    ws.send(buildHello(sessionId));

    // One AudioPipeline per device session
    const pipeline = new AudioPipeline(ws, this.deps);

    ws.on("message", (data) => {
      try {
        const msg = parseMessage(data as Buffer | string);
        switch (msg.type) {
          case "audio":
            // Raw Opus frame from device mic
            if (msg.payload) pipeline.onAudioFrame(msg.payload);
            break;
          case "listen":
            if (msg.state === "start") pipeline.onListenStart();
            if (msg.state === "stop") pipeline.onListenStop();
            break;
          case "abort":
            pipeline.onAbort();
            break;
        }
      } catch {
        // Malformed frame — ignore silently
      }
    });

    // B3: keepalive every 10s — prevents NAT/Cloudflare idle timeout.
    // Must send a WebSocket DATA frame (not just PING control frames): Cloudflare Tunnel
    // counts only data frames as activity; after ~60s without data it closes the connection.
    const keepalive = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 10_000);

    ws.on("close", (code, reason) => {
      clearInterval(keepalive);
      pipeline.destroy();
      this.sessions.delete(sessionId);
      console.log(
        `[xiaozhi] disconnected session=${sessionId} code=${code} reason=${reason.toString()}`,
      );
    });

    ws.on("error", (err) => {
      clearInterval(keepalive);
      pipeline.destroy();
      this.sessions.delete(sessionId);
      console.error(`[xiaozhi] ws error session=${sessionId}`, err);
    });
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Gracefully stop the bridge and close all device sessions. */
  async stop(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.ws.close();
    }
    this.sessions.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
