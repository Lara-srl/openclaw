/**
 * Lazy-loads the core OpenClaw extensionAPI for agent execution.
 * Mirrors the pattern used in extensions/voice-call/src/core-bridge.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type CoreConfig = {
  session?: { store?: string };
  [key: string]: unknown;
};

/** Session entry shape (loose — core uses a more precise type). */
export type CoreSessionEntry = {
  sessionId?: string;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  compactionCount?: number;
  memoryFlushCompactionCount?: number;
  updatedAt?: number;
  [key: string]: unknown;
};

/** Memory flush settings resolved from config. */
export type CoreMemoryFlushSettings = {
  enabled: boolean;
  softThresholdTokens: number;
  prompt: string;
  systemPrompt: string;
  reserveTokensFloor: number;
};

/** Compaction result from compactEmbeddedPiSession. */
export type CoreCompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

export type CoreAgentDeps = {
  resolveAgentDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentWorkspaceDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentIdentity: (
    cfg: CoreConfig,
    agentId: string,
  ) => { name?: string | null } | null | undefined;
  resolveThinkingDefault: (params: {
    cfg: CoreConfig;
    provider?: string;
    model?: string;
  }) => string;
  runEmbeddedPiAgent: (params: {
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    sessionFile: string;
    workspaceDir: string;
    config?: CoreConfig;
    prompt: string;
    provider?: string;
    model?: string;
    thinkLevel?: string;
    verboseLevel?: string;
    timeoutMs: number;
    runId: string;
    lane?: string;
    extraSystemPrompt?: string;
    agentDir?: string;
    /** Disable built-in tools for this run (LLM-only mode). */
    disableTools?: boolean;
    /** P1C streaming: called (fire-and-forget) with each partial LLM text delta. */
    onPartialReply?: (payload: { text?: string }) => void;
    /** Agent event stream callback (used for compaction/memory-flush observability). */
    onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  }) => Promise<{
    payloads?: Array<{ text?: string; isError?: boolean }>;
    meta?: { aborted?: boolean };
  }>;
  resolveAgentTimeoutMs: (opts: { cfg: CoreConfig }) => number;
  ensureAgentWorkspace: (params?: { dir: string }) => Promise<void>;
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  loadSessionStore: (storePath: string) => Record<string, unknown>;
  saveSessionStore: (storePath: string, store: Record<string, unknown>) => Promise<void>;
  resolveSessionFilePath: (
    sessionId: string,
    entry: unknown,
    opts?: { agentId?: string },
  ) => string;
  DEFAULT_MODEL: string;
  DEFAULT_PROVIDER: string;

  // Plan 12 — compaction proattiva per xiaozhi
  /** Native compaction (same function used by /compact). Runtime-optional. */
  compactEmbeddedPiSession?: (params: {
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    sessionFile: string;
    workspaceDir: string;
    agentDir?: string;
    config?: CoreConfig;
    provider?: string;
    model?: string;
    thinkLevel?: string;
    trigger?: "overflow" | "manual";
    senderIsOwner?: boolean;
  }) => Promise<CoreCompactResult>;
  /** Decide if pre-compaction memory flush should run. Runtime-optional. */
  shouldRunMemoryFlush?: (params: {
    entry?: CoreSessionEntry;
    contextWindowTokens: number;
    reserveTokensFloor: number;
    softThresholdTokens: number;
  }) => boolean;
  /** Resolve memory flush settings from config. Runtime-optional. */
  resolveMemoryFlushSettings?: (cfg?: CoreConfig) => CoreMemoryFlushSettings | null;
  /** Resolve effective context window tokens for the active model. Runtime-optional. */
  resolveMemoryFlushContextWindowTokens?: (params: {
    modelId?: string;
    agentCfgContextTokens?: number;
  }) => number;
  /** Resolve the final memory flush prompt (date stamp + current time line). Runtime-optional. */
  resolveMemoryFlushPromptForRun?: (params: {
    prompt: string;
    cfg?: CoreConfig;
    nowMs?: number;
  }) => string;
  /** Mark the session as compacted in the session store. Runtime-optional. */
  incrementCompactionCount?: (params: {
    sessionEntry?: CoreSessionEntry;
    sessionStore?: Record<string, CoreSessionEntry>;
    sessionKey?: string;
    storePath?: string;
    now?: number;
    tokensAfter?: number;
  }) => Promise<number | undefined>;
};

let coreRootCache: string | null = null;
let coreDepsPromise: Promise<CoreAgentDeps> | null = null;

function findPackageRoot(startDir: string, name: string): string | null {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name === name) return dir;
      }
    } catch {
      // ignore
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveOpenClawRoot(): string {
  if (coreRootCache) return coreRootCache;

  const override = process.env.OPENCLAW_ROOT?.trim();
  if (override) {
    coreRootCache = override;
    return override;
  }

  const candidates = new Set<string>();
  if (process.argv[1]) candidates.add(path.dirname(process.argv[1]));
  candidates.add(process.cwd());
  try {
    candidates.add(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // ignore
  }

  for (const start of candidates) {
    const found = findPackageRoot(start, "openclaw");
    if (found) {
      coreRootCache = found;
      return found;
    }
  }

  throw new Error("Unable to resolve core root. Set OPENCLAW_ROOT to the package root.");
}

export async function loadCoreAgentDeps(): Promise<CoreAgentDeps> {
  if (coreDepsPromise) return coreDepsPromise;

  coreDepsPromise = (async () => {
    const distPath = path.join(resolveOpenClawRoot(), "dist", "extensionAPI.js");
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `Missing core module at ${distPath}. Run \`pnpm build\` or install the official package.`,
      );
    }
    return (await import(pathToFileURL(distPath).href)) as CoreAgentDeps;
  })();

  return coreDepsPromise;
}
