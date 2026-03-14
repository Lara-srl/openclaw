import { Type } from "@sinclair/typebox";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import type { XiaozhiBridge } from "./bridge.js";
import { parseXiaozhuConfig } from "./config.js";

// ─── Account shape ────────────────────────────────────────────────────────────

export type ResolvedXiaozhuAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  wsPath: string;
};

const DEFAULT_ACCOUNT_ID = "default";

// ─── Bridge reference (set by index.ts when service starts) ───────────────────

let activeBridge: XiaozhiBridge | null = null;

export function setActiveBridge(bridge: XiaozhiBridge | null): void {
  activeBridge = bridge;
}

export function getActiveBridge(): XiaozhiBridge | null {
  return activeBridge;
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
    chatTypes: ["dm"],
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

  configSchema: {
    jsonSchema: Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      secret: Type.Optional(Type.String()),
      wsPath: Type.Optional(Type.String()),
      otaPath: Type.Optional(Type.String()),
    }),
  },

  status: {
    buildChannelSummary({ account }) {
      const bridge = activeBridge;
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        wsPath: account.wsPath,
        bridgeRunning: bridge !== null,
      };
    },
  },
};
