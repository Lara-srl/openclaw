import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { AudioPipeline } from "./audio-pipeline.js";
import { readXiaozhiCompactionConfig, readXiaozhiVisionUrl } from "./config.js";
import {
  resolveMainSessionContext,
  scheduleNightlyCompaction,
  stopNightlyCompaction,
} from "./context-manager.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";
import { buildHello, buildMcpRequest, parseMessage } from "./protocol.js";
import type {
  ActiveHwEffect,
  BridgeDeps,
  DeferredHwAction,
  DeviceSession,
  McpJsonRpcResponse,
  McpPendingCall,
} from "./types.js";

export class XiaozhiBridge {
  private sessions = new Map<string, DeviceSession>();
  private wss: WebSocketServer;
  /** B9: pending TTS frames keyed by deviceId — sent on next reconnect. */
  private pendingTts = new Map<string, Buffer[]>();
  /** Set when nightly scheduler is active. Cleared on stop(). */
  private nightlyScheduled = false;
  /** MCP JSON-RPC request counter (auto-incrementing). */
  private mcpRequestId = 0;
  /** Pending MCP calls awaiting device response, keyed by JSON-RPC id. */
  private pendingMcpCalls = new Map<number, McpPendingCall>();
  /** Bug 3A: active hardware effects re-applied after SET_UI IDLE. */
  private activeHwEffects = new Map<string, ActiveHwEffect>();
  /** Bug 3A deferred: hardware actions queued during LLM turn, executed post-IDLE. */
  private deferredHwActions: DeferredHwAction[] = [];

  constructor(private deps: BridgeDeps) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) =>
      this.handleConnection(ws, req),
    );
    // Plan 12 — Trigger A: schedule nightly compaction (fire-and-forget).
    // Non-blocking: if loadCoreAgentDeps() fails, just log.
    void this.startNightlyCompaction().catch((err) => {
      console.error("[xiaozhi] nightly compaction bootstrap failed:", err);
    });
  }

  /** First-active session's WebSocket (for compaction screen feedback). */
  private getActiveWs(): WebSocket | null {
    for (const s of this.sessions.values()) {
      if (s.ws.readyState === s.ws.OPEN) return s.ws;
    }
    return null;
  }

  private async startNightlyCompaction(): Promise<void> {
    const compactionCfg = readXiaozhiCompactionConfig(this.deps.config);
    if (!compactionCfg.enabled || !compactionCfg.nightly.enabled) {
      console.log(
        `[xiaozhi] nightly compaction not scheduled (enabled=${compactionCfg.enabled} nightly.enabled=${compactionCfg.nightly.enabled})`,
      );
      return;
    }

    let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
    try {
      deps = await loadCoreAgentDeps();
    } catch (err) {
      console.error("[xiaozhi] nightly compaction: core deps unavailable:", err);
      return;
    }

    const cfg = this.deps.config as unknown as CoreConfig;
    scheduleNightlyCompaction({
      deps,
      cfg,
      config: compactionCfg.nightly,
      getActiveWs: () => this.getActiveWs(),
      getSessionContext: () => resolveMainSessionContext(deps, cfg),
    });
    this.nightlyScheduled = true;
  }

  /** Send a JSON string to the first active (OPEN) device session. */
  sendToActiveSession(json: string): boolean {
    const ws = this.getActiveWs();
    if (!ws) return false;
    ws.send(json);
    return true;
  }

  /**
   * Register a hardware effect that should persist across SET_UI state changes.
   * Called by tool handlers after a successful MCP call with a duration.
   */
  registerHwEffect(
    key: string,
    mcpName: string,
    args: Record<string, unknown>,
    durationMs: number,
  ): void {
    const prev = this.activeHwEffects.get(key);
    if (prev?.expiryTimer) clearTimeout(prev.expiryTimer);

    const expiresAt = durationMs > 0 ? Date.now() + durationMs : 0;
    const expiryTimer =
      durationMs > 0
        ? setTimeout(() => {
            this.activeHwEffects.delete(key);
            console.log(`[XZ bridge] hw effect expired: ${key}`);
          }, durationMs)
        : null;

    this.activeHwEffects.set(key, { mcpName, args, expiresAt, expiryTimer });
    console.log(
      `[XZ bridge] hw effect registered: ${key} (${durationMs > 0 ? `${durationMs}ms` : "permanent"})`,
    );
  }

  /** Remove a hardware effect (e.g. when explicitly turned off). */
  clearHwEffect(key: string): void {
    const effect = this.activeHwEffects.get(key);
    if (effect) {
      if (effect.expiryTimer) clearTimeout(effect.expiryTimer);
      this.activeHwEffects.delete(key);
    }
  }

  /** Queue a hardware action for execution after the voice turn completes (post-IDLE). */
  queueDeferredHwAction(action: DeferredHwAction): void {
    // Replace any existing action with the same key (e.g. multiple LED calls in one turn)
    this.deferredHwActions = this.deferredHwActions.filter((a) => a.key !== action.key);
    this.deferredHwActions.push(action);
    console.log(`[XZ bridge] deferred hw action queued: ${action.key} (${action.mcpName})`);
  }

  /** Execute all deferred hardware actions (called after voice turn IDLE). */
  async executeDeferredHwActions(): Promise<void> {
    const actions = this.deferredHwActions;
    this.deferredHwActions = [];
    if (actions.length === 0) return;

    console.log(`[XZ bridge] executing ${actions.length} deferred hw action(s)`);
    for (const action of actions) {
      try {
        await this.callDeviceMcp("tools/call", {
          name: action.mcpName,
          arguments: action.args,
        });
        // Only persistent effects (LED) survive SET_UI resets; fire-and-forget (haptic/play) don't
        if (action.persist && action.durationMs >= 0) {
          this.registerHwEffect(action.key, action.mcpName, action.args, action.durationMs);
        }
        console.log(`[XZ bridge] deferred hw action executed: ${action.key}`);
      } catch (err) {
        console.log(`[XZ bridge] deferred hw action failed: ${action.key}: ${err}`);
      }
    }
  }

  /** Re-send MCP commands for all active hardware effects after a state reset. */
  async restoreActiveHwEffects(): Promise<void> {
    const now = Date.now();
    for (const [key, effect] of this.activeHwEffects) {
      // Skip expired effects
      if (effect.expiresAt > 0 && now >= effect.expiresAt) {
        this.activeHwEffects.delete(key);
        continue;
      }
      // Adjust remaining duration
      const args = { ...effect.args };
      if (effect.expiresAt > 0 && typeof args.duration_ms === "number") {
        args.duration_ms = Math.max(0, effect.expiresAt - now);
      }
      try {
        await this.callDeviceMcp("tools/call", { name: effect.mcpName, arguments: args });
        console.log(`[XZ bridge] hw effect restored: ${key}`);
      } catch (err) {
        console.log(`[XZ bridge] hw effect restore failed: ${key}: ${err}`);
      }
    }
  }

  /**
   * Send an MCP JSON-RPC request to the device and await the response.
   * Resolves with the result content or rejects on timeout/error.
   */
  callDeviceMcp(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<unknown> {
    const ws = this.getActiveWs();
    if (!ws) return Promise.reject(new Error("No device connected"));

    // Find session id for the active WS
    let sessionId = "";
    for (const s of this.sessions.values()) {
      if (s.ws === ws) {
        sessionId = s.id;
        break;
      }
    }

    const id = ++this.mcpRequestId;
    const frame = buildMcpRequest(sessionId, id, method, params);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMcpCalls.delete(id);
        reject(new Error(`MCP call timeout after ${timeoutMs}ms (id=${id})`));
      }, timeoutMs);

      this.pendingMcpCalls.set(id, { resolve, reject, timer });
      ws.send(frame);
      console.log(`[XZ bridge] MCP request id=${id} method=${method}`);
    });
  }

  /** Resolve/reject a pending MCP call based on the device JSON-RPC response. */
  private handleMcpResponse(response: McpJsonRpcResponse): void {
    const pending = this.pendingMcpCalls.get(response.id);
    if (!pending) {
      console.log(`[XZ bridge] MCP response id=${response.id} — no pending call (stale/duplicate)`);
      return;
    }
    this.pendingMcpCalls.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      console.log(`[XZ bridge] MCP response id=${response.id} error: ${response.error.message}`);
      pending.reject(new Error(response.error.message));
      return;
    }

    // Extract text from MCP result content array
    const text = response.result?.content?.[0]?.text;
    console.log(`[XZ bridge] MCP response id=${response.id} ok`);

    // Try to parse JSON text result, fall back to raw text
    if (text) {
      try {
        pending.resolve(JSON.parse(text));
      } catch {
        pending.resolve(text);
      }
    } else {
      pending.resolve(response.result);
    }
  }

  /** Reject all pending MCP calls (e.g. on device disconnect). */
  private rejectAllPendingMcp(reason: string): void {
    for (const [id, call] of this.pendingMcpCalls) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
      this.pendingMcpCalls.delete(id);
    }
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

    // Send MCP initialize with vision capabilities so firmware knows where to POST photos
    const visionUrl = readXiaozhiVisionUrl(this.deps.config);
    const initId = ++this.mcpRequestId;
    ws.send(
      buildMcpRequest(sessionId, initId, "initialize", {
        capabilities: {
          vision: {
            url: visionUrl,
            token: "",
          },
        },
      }),
    );
    console.log(`[XZ bridge] MCP request id=${initId} method=initialize vision_url=${visionUrl}`);

    // B9: inject pending TTS from previous B8 session before new listen cycle
    const pending = deviceId ? this.pendingTts.get(deviceId) : undefined;
    if (pending) {
      this.pendingTts.delete(deviceId!);
    }

    // One AudioPipeline per device session
    const pipeline = new AudioPipeline(ws, this.deps, (frames) => {
      // B9: WS closed during speak() — store for next reconnect
      if (deviceId) {
        this.pendingTts.set(deviceId, frames);
        console.log(`[XZ bridge] B9: stored ${frames.length} TTS frames for device=${deviceId}`);
      }
    });

    // B9: send pending TTS from previous session (blocks listen:start via state guard)
    if (pending) {
      void pipeline.injectTts(pending);
    }

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
          case "listen": {
            const modeTag = msg.mode ? ` mode=${msg.mode}` : "";
            console.log(`[XZ bridge] listen state=${msg.state}${modeTag}`);
            if (msg.state === "start") pipeline.onListenStart(msg.mode);
            if (msg.state === "stop") pipeline.onListenStop(msg.mode);
            break;
          }
          case "mcp":
            if (msg.mcpPayload) this.handleMcpResponse(msg.mcpPayload);
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
      this.rejectAllPendingMcp("Device disconnected");
      this.sessions.delete(sessionId);
      console.log(
        `[xiaozhi] disconnected session=${sessionId} code=${code} reason=${reason.toString()}`,
      );
    });

    ws.on("error", (err) => {
      clearInterval(keepalive);
      pipeline.flushOnDisconnect();
      this.rejectAllPendingMcp("Device connection error");
      this.sessions.delete(sessionId);
      console.error(`[xiaozhi] ws error session=${sessionId}`, err);
    });
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Gracefully stop the bridge and close all device sessions. */
  async stop(): Promise<void> {
    // Plan 12 — cleanup nightly scheduler before closing sessions.
    if (this.nightlyScheduled) {
      stopNightlyCompaction();
      this.nightlyScheduled = false;
    }
    for (const s of this.sessions.values()) {
      s.ws.close();
    }
    this.sessions.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
