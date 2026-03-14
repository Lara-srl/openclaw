import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { buildHello, parseMessage } from "./protocol.js";
import type { DeviceSession } from "./types.js";

export class XiaozhiBridge {
  private sessions = new Map<string, DeviceSession>();
  private wss: WebSocketServer;

  constructor() {
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

    // Handshake: send hello frame
    ws.send(buildHello(sessionId));

    ws.on("message", (data) => {
      try {
        const msg = parseMessage(data as Buffer | string);
        // Phase 2: route msg.type → audio pipeline / agent
        void msg;
      } catch {
        // Malformed frame — ignore silently
      }
    });

    ws.on("close", () => {
      this.sessions.delete(sessionId);
    });

    ws.on("error", () => {
      this.sessions.delete(sessionId);
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
