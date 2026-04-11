/**
 * resetEmbeddedPiSession — extension-facing primitive that mimics the native
 * gateway `sessions.reset` RPC, minus the pieces that aren't safe/needed when
 * called from post-response extension code:
 *
 *   - no `ensureSessionRuntimeCleanup` (caller guarantees no run in flight;
 *     xiaozhi calls this from `context-manager.ts` right after the assistant
 *     response has flushed).
 *   - no `closeAcpRuntimeForSession` (not relevant for voice/xiaozhi — no ACP
 *     client is bound to a xiaozhi session).
 *   - no `emitSessionUnboundLifecycleEvent` (no thread bindings or subagent
 *     lifecycle hooks to unwind).
 *
 * What it *does* do (matching the native flow so the bundled `session-memory`
 * hook and archive machinery still run):
 *   1. Fire an internal `command/new` (or `command/reset`) hook with the old
 *      entry in `previousSessionEntry` — this triggers the bundled
 *      `session-memory` handler which writes a summary to
 *      `memory/YYYY-MM-DD-<slug>.md` via LLM before the old entry disappears.
 *   2. Atomically `updateSessionStore()` so the entry gets a fresh `sessionId`
 *      and zeroed token counters, preserving model / thinking / label /
 *      origin / lastChannel etc. (same shape as sessions.ts:468-491).
 *   3. Archive the old `.jsonl` transcript as `.jsonl.reset.<timestamp>` (so
 *      the session-memory hook's reset-fallback path can still find content
 *      if it needs to re-read).
 *
 * Used by Plan 12 (xiaozhi proactive compaction → session rotation) — see
 * `Note/plans/12_Compaction.md` TODO 3 and `extensions/xiaozhi/src/context-manager.ts`.
 */

import { randomUUID } from "node:crypto";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import {
  snapshotSessionOrigin,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import {
  archiveSessionTranscripts,
  loadSessionEntry,
  pruneLegacyStoreKeys,
  resolveGatewaySessionStoreTarget,
} from "../../gateway/session-utils.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/pi-embedded-runner/reset");

export type ResetEmbeddedPiSessionParams = {
  /** Session key to rotate (e.g. "agent:xiaozhi:main"). */
  sessionKey: string;
  /**
   * Hook action label. `"new"` mirrors a user typing `/new` (fresh topic) and
   * `"reset"` mirrors `/reset` (context cleared). Both trigger the bundled
   * session-memory handler. Defaults to `"new"`.
   */
  reason?: "new" | "reset";
  /** Optional pre-loaded config; falls back to `loadConfig()`. */
  cfg?: OpenClawConfig;
  /**
   * Free-form origin label stored in the hook event context (for downstream
   * handler diagnostics). Defaults to `"extension:reset"`.
   */
  commandSource?: string;
};

export type ResetEmbeddedPiSessionResult = {
  ok: true;
  /** Canonical key under which the new entry was written. */
  canonicalKey: string;
  /** Fresh sessionId minted for the new entry. */
  newSessionId: string;
  /** Old sessionId, if an entry existed before the reset. */
  oldSessionId?: string;
  /** Old sessionFile path (pre-archive), if any. */
  oldSessionFile?: string;
  /** Archived transcript paths (`.jsonl.reset.<timestamp>`). Empty if nothing to archive. */
  archivedFiles: string[];
};

/**
 * Rotate an embedded Pi session by minting a new `sessionId`, archiving the
 * old transcript, and firing `command/new` so the session-memory hook writes
 * a summary to `memory/YYYY-MM-DD-<slug>.md`.
 *
 * Callers are responsible for ensuring no run is in flight on the target
 * session (xiaozhi guarantees this by calling post-response).
 */
export async function resetEmbeddedPiSession(
  params: ResetEmbeddedPiSessionParams,
): Promise<ResetEmbeddedPiSessionResult> {
  const cfg = params.cfg ?? loadConfig();
  const key = params.sessionKey.trim();
  if (!key) {
    throw new Error("resetEmbeddedPiSession: sessionKey required");
  }

  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  const { entry } = loadSessionEntry(key);

  const reason: "new" | "reset" = params.reason === "reset" ? "reset" : "new";
  const commandSource = params.commandSource ?? "extension:reset";

  // 1. Fire command/new|reset so session-memory handler writes memory/<date>-<slug>.md
  //    *before* the old entry disappears from the store.
  try {
    const hookEvent = createInternalHookEvent("command", reason, target.canonicalKey, {
      sessionEntry: entry,
      previousSessionEntry: entry,
      commandSource,
      cfg,
    });
    await triggerInternalHook(hookEvent);
  } catch (err) {
    // Hook failure must never block rotation — log and continue.
    log.warn(
      `command/${reason} hook failed for ${target.canonicalKey}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 2. Atomically swap the store entry (new UUID, reset token counters,
  //    preserve stable fields).
  let oldSessionId: string | undefined;
  let oldSessionFile: string | undefined;
  const next = await updateSessionStore(target.storePath, (store) => {
    // Migrate legacy case-variant keys into the canonical slot.
    const canonicalKey = target.canonicalKey;
    if (!store[canonicalKey]) {
      const existingKey = target.storeKeys.find((candidate) => Boolean(store[candidate]));
      if (existingKey) {
        store[canonicalKey] = store[existingKey];
      }
    }
    pruneLegacyStoreKeys({
      store,
      canonicalKey,
      candidates: target.storeKeys,
    });

    const prev = store[canonicalKey];
    oldSessionId = prev?.sessionId;
    oldSessionFile = prev?.sessionFile;

    const now = Date.now();
    const nextEntry: SessionEntry = {
      sessionId: randomUUID(),
      updatedAt: now,
      systemSent: false,
      abortedLastRun: false,
      thinkingLevel: prev?.thinkingLevel,
      verboseLevel: prev?.verboseLevel,
      reasoningLevel: prev?.reasoningLevel,
      responseUsage: prev?.responseUsage,
      model: prev?.model,
      modelProvider: prev?.modelProvider,
      contextTokens: prev?.contextTokens,
      sendPolicy: prev?.sendPolicy,
      label: prev?.label,
      origin: snapshotSessionOrigin(prev),
      lastChannel: prev?.lastChannel,
      lastTo: prev?.lastTo,
      skillsSnapshot: prev?.skillsSnapshot,
      // Reset token counts to 0 on session reset (mirrors #1523).
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    };
    store[canonicalKey] = nextEntry;
    return nextEntry;
  });

  // 3. Archive old transcript as `.jsonl.reset.<timestamp>` so it doesn't
  //    accumulate and so the session-memory hook's reset-fallback can still
  //    find content if it re-runs.
  const archivedFiles = oldSessionId
    ? archiveSessionTranscripts({
        sessionId: oldSessionId,
        storePath: target.storePath,
        sessionFile: oldSessionFile,
        agentId: target.agentId,
        reason: "reset",
      })
    : [];

  log.info(
    `session ${target.canonicalKey} rotated: ${oldSessionId ?? "(none)"} → ${
      next.sessionId
    }, archived=${archivedFiles.length}`,
  );

  return {
    ok: true,
    canonicalKey: target.canonicalKey,
    newSessionId: next.sessionId,
    oldSessionId,
    oldSessionFile,
    archivedFiles,
  };
}
