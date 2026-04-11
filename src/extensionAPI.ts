export { resolveAgentDir, resolveAgentWorkspaceDir } from "./agents/agent-scope.ts";

export { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./agents/defaults.ts";
export { resolveAgentIdentity } from "./agents/identity.ts";
export { resolveThinkingDefault } from "./agents/model-selection.ts";
export { runEmbeddedPiAgent } from "./agents/pi-embedded.ts";
// Compaction nativa (Plan 12 — xiaozhi proactive compaction)
export { compactEmbeddedPiSession } from "./agents/pi-embedded-runner.ts";
export type { CompactEmbeddedPiSessionParams } from "./agents/pi-embedded-runner/compact.ts";
export type { EmbeddedPiCompactResult } from "./agents/pi-embedded-runner/types.ts";
export { resolveAgentTimeoutMs } from "./agents/timeout.ts";
export { ensureAgentWorkspace } from "./agents/workspace.ts";
// Memory flush primitives (Plan 12 — pre-compaction memory save)
export {
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./auto-reply/reply/memory-flush.ts";
// Session compaction counter (Plan 12 — mark session as compacted in store)
export { incrementCompactionCount } from "./auto-reply/reply/session-updates.ts";
export {
  resolveStorePath,
  loadSessionStore,
  saveSessionStore,
  resolveSessionFilePath,
} from "./config/sessions.ts";
