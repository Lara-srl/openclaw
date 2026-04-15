import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import type { XiaozhiBridge } from "./bridge.js";
import { parseXiaozhuConfig, XiaozhuConfigSchema } from "./config.js";

// ─── Account shape ────────────────────────────────────────────────────────────

export type ResolvedXiaozhuAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  wsPath: string;
};

const DEFAULT_ACCOUNT_ID = "default";

// ─── Bridge reference (set by index.ts when service starts) ───────────────────
// Process-global via Symbol.for so the bridge is reachable across module-loader
// contexts (the gateway sets it in one jiti instance; resolvePluginTools may load
// channel.ts in a different module instance during agent tool resolution).

const BRIDGE_KEY = Symbol.for("openclaw.xiaozhi.bridge");

export function setActiveBridge(bridge: XiaozhiBridge | null): void {
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = bridge;
}

export function getActiveBridge(): XiaozhiBridge | null {
  return ((globalThis as Record<symbol, unknown>)[BRIDGE_KEY] as XiaozhiBridge | null) ?? null;
}

// ─── Config adapter ───────────────────────────────────────────────────────────

function resolveXiaozhuAccount(cfg: OpenClawConfig): ResolvedXiaozhuAccount {
  // Plugin config lives under cfg.plugins?.xiaozhi (injected at runtime).
  const raw = (cfg as unknown as Record<string, unknown>).plugins;
  const pluginRaw =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>).xiaozhi : undefined;
  const pluginCfg = parseXiaozhuConfig(pluginRaw);
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: pluginCfg.enabled,
    configured: true,
    wsPath: pluginCfg.wsPath,
  };
}

// ─── Channel plugin ───────────────────────────────────────────────────────────

export const xiaozhiChannelPlugin: ChannelPlugin<ResolvedXiaozhuAccount> = {
  id: "xiaozhi",

  meta: {
    id: "xiaozhi",
    label: "XiaoZhi",
    selectionLabel: "XiaoZhi (ESP32-S3-BOX-3)",
    docsPath: "/channels/xiaozhi",
    docsLabel: "xiaozhi",
    blurb: "ESP32-S3-BOX-3 AI companion device via WebSocket bridge.",
    order: 90,
  },

  capabilities: {
    // Voice-only device — single DM conversation, no group/thread/media support.
    chatTypes: ["direct"],
    media: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    threads: false,
    nativeCommands: false,
  },

  config: {
    listAccountIds(_cfg: OpenClawConfig): string[] {
      return [DEFAULT_ACCOUNT_ID];
    },

    resolveAccount(cfg: OpenClawConfig): ResolvedXiaozhuAccount {
      return resolveXiaozhuAccount(cfg);
    },

    isEnabled(account: ResolvedXiaozhuAccount): boolean {
      return account.enabled;
    },

    isConfigured(account: ResolvedXiaozhuAccount): boolean {
      return account.configured;
    },

    describeAccount(account: ResolvedXiaozhuAccount) {
      return {
        accountId: account.accountId,
        label: `XiaoZhi (${account.wsPath})`,
        enabled: account.enabled,
        configured: account.configured,
      };
    },
  },

  configSchema: buildChannelConfigSchema(XiaozhuConfigSchema),

  status: {
    buildChannelSummary({ account }) {
      const bridge = getActiveBridge();
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        wsPath: account.wsPath,
        bridgeRunning: bridge !== null,
      };
    },
  },
};
