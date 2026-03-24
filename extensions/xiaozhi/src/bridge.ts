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

    let audioFrameCount = 0;
    ws.on("message", (data) => {
      try {
        const msg = parseMessage(data as Buffer | string);
        switch (msg.type) {
          case "audio":
            // Raw Opus frame from device mic
            audioFrameCount++;
            if (audioFrameCount === 1 || audioFrameCount % 50 === 0) {
              console.log(
                `[XZ bridge] audio frame #${audioFrameCount} (${(data as Buffer).length}b)`,
              );
            }
            if (msg.payload) pipeline.onAudioFrame(msg.payload);
            break;
          case "listen":
            console.log(`[XZ bridge] listen state=${msg.state}`);
            if (msg.state === "start") pipeline.onListenStart();
            if (msg.state === "stop") pipeline.onListenStop();
            break;
          case "abort":
            console.log(`[XZ bridge] abort`);
            pipeline.onAbort();
            break;
          default:
            console.log(`[XZ bridge] unknown type=${msg.type}`);
        }
      } catch (err) {
        const raw = Buffer.isBuffer(data)
          ? `binary[${(data as Buffer).length}b] 0x${(data as Buffer)[0]?.toString(16)}`
          : String(data).substring(0, 120);
        console.error(`[XZ bridge] parse error — raw: ${raw} — err: ${String(err)}`);
      }
    });

    // B3/B5/B6/B7: keepalive every 8s.
    // - Data frame (ws.send) keeps Cloudflare Tunnel alive (control frames don't count).
    // - ws.ping() removed (B7): during active listen the device streams audio frames every ~60ms,
    //   providing sufficient bidirectional traffic for Fritz!Box NAT (9.2s timeout).
    //   In idle, the JSON ping data frame alone is enough for Cloudflare.
    //   ws.ping() was suspected to cause SSL reset (MBEDTLS_ERR_NET_RECV_FAILED ~4.8s after first ping).
    const keepalive = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "ping" })); // data frame for Cloudflare
      }
    }, 8_000);

    ws.on("close", (code, reason) => {
      clearInterval(keepalive);
      // B8: implicit listen:stop on abnormal close (device disconnects instead
      // of sending listen:stop — listen:stop is lost in the TCP RST race).
      pipeline.flushOnDisconnect();
      this.sessions.delete(sessionId);
      console.log(
        `[xiaozhi] disconnected session=${sessionId} code=${code} reason=${reason.toString()}`,
      );
    });

    ws.on("error", (err) => {
      clearInterval(keepalive);
      pipeline.flushOnDisconnect();
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
