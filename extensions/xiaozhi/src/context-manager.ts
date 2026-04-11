/**
 * Plan 12 — Compaction proattiva per xiaozhi.
 *
 * Due trigger combinati, entrambi POST-response (mai prima della risposta vocale):
 *   Trigger A (nightly, principale): setTimeout all'ora configurata (default 3:00)
 *   Trigger B (safety net, post-response): fire-and-forget dopo ogni runAgent()
 *
 * Sorgente di verità per il conteggio token: ULTIMO entry assistant del JSONL
 * (`message.usage.totalTokens`). Il runtime cache `sessionEntry.totalTokens` è
 * spesso `null` anche con conversazione reale — non ci affidiamo a quello.
 */

import fs from "node:fs/promises";
import type { WebSocket } from "ws";
import { readXiaozhiCompactionConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { buildLlm } from "./protocol.js";

const TAG = "[xiaozhi:context-manager]";

/** Ultimi 16 KB del JSONL bastano ampiamente a contenere l'ultima entry. */
const HANDLE_TAIL = 16 * 1024;

/**
 * Debounce post-success: il JSONL post-compact mantiene l'ultima `assistant` entry
 * con `usage.totalTokens` elevato finché non arriva un nuovo turno utente.
 * Senza debounce chiameremmo compaction in loop su `readLatestSessionTokens`.
 */
const COMPACTION_DEBOUNCE_SUCCESS_MS = 10 * 60 * 1000;

/**
 * Debounce post-cancelled: quando la compaction viene annullata dalla safeguard Pi
 * (tipico caso iniziale: sessione troppo giovane, `keepRecentTokens=20000` hardcoded
 * di Pi lascia 0 messaggi da riassumere), lo stato non cambia → possiamo ritentare
 * rapidamente al prossimo turno voice. 60s evita comunque hammering.
 */
const COMPACTION_DEBOUNCE_CANCELLED_MS = 60 * 1000;

type DebounceEntry = {
  at: number;
  windowMs: number;
  outcome: "success" | "cancelled" | "error";
};

const lastCompactedAt = new Map<string, DebounceEntry>();

// ─── Token reader ─────────────────────────────────────────────────────────────

/**
 * Legge solo gli ultimi 16 KB del sessionFile e ritorna il `totalTokens`
 * dell'ultima entry `{type:"message", role:"assistant"}` trovata.
 * Ritorna 0 su qualsiasi errore I/O o sessione vuota.
 */
export async function readLatestSessionTokens(sessionFile: string): Promise<number> {
  try {
    const stat = await fs.stat(sessionFile);
    if (stat.size === 0) return 0;
    const start = Math.max(0, stat.size - HANDLE_TAIL);
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    const fd = await fs.open(sessionFile, "r");
    try {
      await fd.read(buf, 0, length, start);
    } finally {
      await fd.close();
    }
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]!) as {
          type?: string;
          message?: { role?: string; usage?: { totalTokens?: number } };
        };
        if (
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          typeof entry.message.usage?.totalTokens === "number" &&
          entry.message.usage.totalTokens > 0
        ) {
          return entry.message.usage.totalTokens;
        }
      } catch {
        // linea troncata (possibile all'inizio del tail): ignora e continua
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

// ─── Compaction runner ────────────────────────────────────────────────────────

export type MaybeCompactParams = {
  deps: CoreAgentDeps;
  cfg: CoreConfig;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  provider?: string;
  model?: string;
  thinkLevel?: string;
  /** Minimum token count to trigger compaction (configurable per call site). */
  minTokens: number;
  /** Active device WS — used to render "Sto organizzando i ricordi..." on screen. */
  ws?: WebSocket | null;
  /** Human-readable origin for logs ("nightly" | "threshold"). */
  origin: "nightly" | "threshold";
};

/**
 * Fire-and-forget compaction runner: debounce → read tokens from JSONL →
 * (optional) memory flush → compactEmbeddedPiSession → incrementCompactionCount.
 * Fallimenti loggati ma MAI propagati (voice pipeline non deve crashare).
 */
export async function maybeCompactSession(params: MaybeCompactParams): Promise<void> {
  const { deps, cfg, sessionKey, sessionFile, origin, minTokens } = params;

  // Runtime guard: se il build core non espone compactEmbeddedPiSession
  // (dist/ vecchio), skip silenzioso.
  if (typeof deps.compactEmbeddedPiSession !== "function") {
    console.log(`${TAG} skip origin=${origin} reason=compactEmbeddedPiSession-not-exported`);
    return;
  }

  // Debounce split (Opzione A): success=10min, cancelled/failed=60s.
  // Usa il valore più restrittivo presente nella mappa; se l'ultimo giro è stato
  // un success restiamo fermi 10min, se è stato un cancel ritentiamo dopo 60s.
  const debounceKey = `${sessionKey}|${origin}`;
  const lastEntry = lastCompactedAt.get(debounceKey);
  if (lastEntry) {
    const sinceLast = Date.now() - lastEntry.at;
    if (sinceLast < lastEntry.windowMs) {
      console.log(
        `${TAG} skip origin=${origin} reason=debounce sinceLastMs=${sinceLast} windowMs=${lastEntry.windowMs} lastOutcome=${lastEntry.outcome}`,
      );
      return;
    }
  }

  let tokens = 0;
  try {
    tokens = await readLatestSessionTokens(sessionFile);
  } catch (err) {
    console.error(`${TAG} readLatestSessionTokens error (treating as 0):`, err);
    tokens = 0;
  }

  if (tokens < minTokens) {
    console.log(`${TAG} tokens=${tokens} threshold=${minTokens} origin=${origin} outcome=skip`);
    return;
  }

  console.log(`${TAG} tokens=${tokens} threshold=${minTokens} origin=${origin} outcome=compacting`);

  const ws = params.ws;
  const wsOpen = ws && ws.readyState === ws.OPEN;

  // Feedback schermo: inizio compaction
  if (wsOpen) {
    try {
      ws!.send(buildLlm("🔄 Sto organizzando i ricordi...", "neutral"));
    } catch {
      // non bloccante
    }
  }

  // Helper per impostare il debounce in base all'esito.
  const setDebounce = (outcome: "success" | "cancelled" | "error") => {
    const windowMs =
      outcome === "success" ? COMPACTION_DEBOUNCE_SUCCESS_MS : COMPACTION_DEBOUNCE_CANCELLED_MS;
    lastCompactedAt.set(debounceKey, { at: Date.now(), windowMs, outcome });
  };

  try {
    // Memory flush (solo se core lo espone e soglie raggiunte)
    await maybeRunMemoryFlush(params).catch((err) => {
      console.error(`${TAG} memory flush error (continuing with compaction):`, err);
    });

    // Compaction nativa
    console.log(`${TAG} compaction start origin=${origin}`);
    const compactResult = await deps.compactEmbeddedPiSession!({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messageProvider: "xiaozhi",
      sessionFile: params.sessionFile,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: cfg,
      provider: params.provider,
      model: params.model,
      thinkLevel: params.thinkLevel,
      trigger: "manual",
      senderIsOwner: true,
    });

    if (compactResult?.ok && compactResult.compacted) {
      const tokensAfter = compactResult.result?.tokensAfter;
      console.log(
        `${TAG} compaction completed origin=${origin} tokensBefore=${compactResult.result?.tokensBefore ?? tokens} tokensAfter=${tokensAfter ?? "?"}`,
      );

      // Aggiorna session store (compactionCount + tokensAfter)
      if (typeof deps.incrementCompactionCount === "function") {
        try {
          const storePath = deps.resolveStorePath(cfg.session?.store, { agentId: "main" });
          const sessionStore = deps.loadSessionStore(storePath) as Record<
            string,
            Record<string, unknown>
          >;
          await deps.incrementCompactionCount({
            sessionEntry: sessionStore[sessionKey] as Record<string, unknown> | undefined,
            sessionStore,
            sessionKey,
            storePath,
            tokensAfter,
          });
        } catch (err) {
          console.error(`${TAG} incrementCompactionCount error:`, err);
        }
      }

      // Feedback schermo: fine OK
      if (wsOpen) {
        try {
          ws!.send(buildLlm("✅ Ricordi organizzati!", "happy"));
        } catch {
          // non bloccante
        }
      }

      setDebounce("success");
    } else {
      // Caso tipico: safeguard Pi cancella perché keepRecentTokens=20000 non lascia
      // messaggi da riassumere. Stato invariato → retry rapido al prossimo turno.
      console.log(
        `${TAG} compaction not executed origin=${origin} ok=${compactResult?.ok} reason=${compactResult?.reason ?? "unknown"} (retry in ${COMPACTION_DEBOUNCE_CANCELLED_MS / 1000}s)`,
      );
      setDebounce("cancelled");
    }
  } catch (err) {
    // Nessun feedback schermo su errore — resta silenzioso (solo log server-side).
    console.error(`${TAG} compaction error origin=${origin}:`, err);
    setDebounce("error");
  }
}

/**
 * Pre-compaction memory flush. Gira un turno silenzioso sull'agente embedded
 * per salvare memorie durable su disco (memory/YYYY-MM-DD.md).
 *
 * NON passa extraSystemPrompt voice: le regole "1-2 frasi, no markdown" non
 * devono influenzare il flush (che scrive su file markdown).
 *
 * Se `compaction.memoryFlush.alwaysRun === true` (default per xiaozhi), bypassa
 * `shouldRunMemoryFlush()` del core: con soglie xiaozhi basse (25K) la sessione
 * non raggiungerebbe mai la near-overflow (~117K su mistral-small 131K) e il
 * flush non scatterebbe mai — quindi memoria utente vuota per sempre.
 */
async function maybeRunMemoryFlush(params: MaybeCompactParams): Promise<void> {
  const { deps, cfg, sessionKey } = params;
  if (
    typeof deps.resolveMemoryFlushSettings !== "function" ||
    typeof deps.resolveMemoryFlushPromptForRun !== "function"
  ) {
    return;
  }

  const settings = deps.resolveMemoryFlushSettings(cfg);
  if (!settings?.enabled) return;

  // Config xiaozhi — se alwaysRun=true saltiamo shouldRunMemoryFlush().
  const xiaozhiCompaction = readXiaozhiCompactionConfig(cfg);
  const alwaysRun = xiaozhiCompaction.memoryFlush.alwaysRun === true;

  const tokensForDecision = await readLatestSessionTokens(params.sessionFile);

  if (!alwaysRun) {
    // Path "core-compatible": usa la decision function standard (gate near-overflow).
    if (
      typeof deps.shouldRunMemoryFlush !== "function" ||
      typeof deps.resolveMemoryFlushContextWindowTokens !== "function"
    ) {
      return;
    }

    // Legge la session entry dal runtime cache — anche se totalTokens è
    // inaffidabile, compactionCount / memoryFlushCompactionCount sono corretti.
    let sessionEntry: Record<string, unknown> | undefined;
    try {
      const storePath = deps.resolveStorePath(cfg.session?.store, { agentId: "main" });
      const sessionStore = deps.loadSessionStore(storePath);
      sessionEntry = sessionStore[sessionKey] as Record<string, unknown> | undefined;
    } catch (err) {
      console.error(`${TAG} memory flush: unable to load session store:`, err);
    }

    const entryForDecision = {
      ...(sessionEntry ?? {}),
      totalTokens: tokensForDecision,
      totalTokensFresh: true,
    } as {
      totalTokens?: number;
      totalTokensFresh?: boolean;
      compactionCount?: number;
      memoryFlushCompactionCount?: number;
    };

    const contextWindowTokens = deps.resolveMemoryFlushContextWindowTokens({
      modelId: params.model,
    });
    const shouldFlush = deps.shouldRunMemoryFlush({
      entry: entryForDecision,
      contextWindowTokens,
      reserveTokensFloor: settings.reserveTokensFloor,
      softThresholdTokens: settings.softThresholdTokens,
    });

    if (!shouldFlush) {
      console.log(
        `${TAG} memory flush skipped (shouldRunMemoryFlush=false) tokens=${tokensForDecision}`,
      );
      return;
    }
  } else {
    console.log(`${TAG} memory flush forced (alwaysRun=true) tokens=${tokensForDecision}`);
  }

  const flushPrompt = deps.resolveMemoryFlushPromptForRun({
    prompt: settings.prompt,
    cfg,
  });

  const runId = `xiaozhi-flush:${params.sessionId}:${Date.now()}`;
  const timeoutMs = deps.resolveAgentTimeoutMs({ cfg });

  console.log(`${TAG} memory flush start`);
  await deps.runEmbeddedPiAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    messageProvider: "xiaozhi",
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: cfg,
    prompt: flushPrompt,
    provider: params.provider,
    model: params.model,
    thinkLevel: params.thinkLevel,
    verboseLevel: "off",
    timeoutMs,
    runId,
    lane: "xiaozhi",
    agentDir: params.agentDir,
    disableTools: false, // il flush DEVE poter scrivere file su disco
    // NON passiamo extraSystemPrompt: le regole vocali non si applicano al flush
  });
  console.log(`${TAG} memory flush completed`);
}

// ─── Session context resolver ────────────────────────────────────────────────

/**
 * Resolve the "main" xiaozhi session context (paths + provider/model) from
 * the session store. Returns null if the session store can't be read or the
 * main session doesn't exist yet (no voice turn ever played).
 *
 * Shared by nightly scheduler and (future) status surfaces.
 */
export function resolveMainSessionContext(
  deps: CoreAgentDeps,
  cfg: CoreConfig,
): {
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  provider?: string;
  model?: string;
  thinkLevel?: string;
} | null {
  try {
    const agentId = "main";
    const sessionKey = "main";
    const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
    const sessionStore = deps.loadSessionStore(storePath);
    const entry = sessionStore[sessionKey] as { sessionId?: string } | undefined;
    if (!entry?.sessionId) return null;

    const agentDir = deps.resolveAgentDir(cfg, agentId);
    const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);
    const sessionFile = deps.resolveSessionFilePath(entry.sessionId, entry, { agentId });

    // Resolve provider/model from cfg.agents.defaults.model (same logic as runAgent).
    const rawModel = (() => {
      const m = (cfg as Record<string, unknown>).agents as Record<string, unknown> | undefined;
      const d = m?.defaults as Record<string, unknown> | undefined;
      const val = d?.model;
      if (typeof val === "string") return val.trim();
      if (val && typeof val === "object" && "primary" in val)
        return String((val as Record<string, unknown>).primary ?? "").trim();
      return "";
    })();
    const slashIdx = rawModel.indexOf("/");
    const provider = slashIdx > 0 ? rawModel.slice(0, slashIdx) : undefined;
    const model = slashIdx > 0 ? rawModel.slice(slashIdx + 1) : rawModel || undefined;
    const thinkLevel = deps.resolveThinkingDefault({ cfg, provider, model });

    return {
      sessionId: entry.sessionId,
      sessionKey,
      sessionFile,
      workspaceDir,
      agentDir,
      provider,
      model,
      thinkLevel,
    };
  } catch (err) {
    console.error(`${TAG} resolveMainSessionContext error:`, err);
    return null;
  }
}

// ─── Nightly scheduler (Trigger A) ────────────────────────────────────────────

export type NightlyCompactionConfig = {
  enabled: boolean;
  hour: number;
  minTokens: number;
  timezone: string;
};

export type ScheduleNightlyParams = {
  deps: CoreAgentDeps;
  cfg: CoreConfig;
  config: NightlyCompactionConfig;
  /** Resolver for the currently active device WS (null if no device connected). */
  getActiveWs: () => WebSocket | null;
  /** Resolver for the active session context (sessionId / sessionFile / etc). */
  getSessionContext: () => {
    sessionId: string;
    sessionKey: string;
    sessionFile: string;
    workspaceDir: string;
    agentDir?: string;
    provider?: string;
    model?: string;
    thinkLevel?: string;
  } | null;
};

let nightlyTimer: ReturnType<typeof setTimeout> | null = null;

function computeNextNightlyDelayMs(hour: number, timezone: string): number {
  // Calcola la prossima istanza di HH:00 nel timezone dato.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const curYear = get("year");
  const curMonth = get("month");
  const curDay = get("day");
  const curHour = get("hour") === 24 ? 0 : get("hour"); // Intl quirk: sometimes returns 24
  const curMinute = get("minute");
  const curSecond = get("second");

  // Target in TZ wall time: today HH:00:00, oppure domani HH:00:00 se già passato.
  let targetYear = curYear;
  let targetMonth = curMonth;
  let targetDay = curDay;
  if (curHour > hour || (curHour === hour && (curMinute > 0 || curSecond > 0))) {
    // Già oltre l'ora target → domani. Usiamo Date aritmetica in UTC per
    // incrementare il giorno; il piccolo drift DST è ~0 perché ricalcoliamo
    // ogni giorno.
    const tmp = new Date(Date.UTC(curYear, curMonth - 1, curDay + 1));
    targetYear = tmp.getUTCFullYear();
    targetMonth = tmp.getUTCMonth() + 1;
    targetDay = tmp.getUTCDate();
  }

  // Calcola il timestamp UTC del target interpretando la wall-clock come TZ.
  // Usiamo il trucco "costruisci Date UTC, misura offset TZ, sottrai".
  const fakeUtc = Date.UTC(targetYear, targetMonth - 1, targetDay, hour, 0, 0);
  const tzOffsetMs = tzOffsetAtInstant(fakeUtc, timezone);
  const targetUtcMs = fakeUtc - tzOffsetMs;

  const delay = targetUtcMs - now.getTime();
  // Minimo 60s per evitare tight loops se il calcolo produce un valore negativo/prossimo.
  return delay > 60_000 ? delay : 60_000;
}

/** Offset in ms del timezone al dato istante UTC (positivo a est di UTC). */
function tzOffsetAtInstant(utcMs: number, timezone: string): number {
  const date = new Date(utcMs);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const localHour = get("hour") === 24 ? 0 : get("hour");
  const localAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    localHour,
    get("minute"),
    get("second"),
  );
  return localAsUtc - utcMs;
}

export function scheduleNightlyCompaction(params: ScheduleNightlyParams): void {
  if (!params.config.enabled) {
    console.log(`${TAG} nightly compaction disabled by config`);
    return;
  }
  stopNightlyCompaction();

  const delayMs = computeNextNightlyDelayMs(params.config.hour, params.config.timezone);
  const targetDate = new Date(Date.now() + delayMs);
  console.log(
    `${TAG} nightly compaction scheduled for ${targetDate.toISOString()} (in ${Math.round(delayMs / 1000)}s, hour=${params.config.hour} tz=${params.config.timezone})`,
  );

  nightlyTimer = setTimeout(() => {
    void runNightlyTick(params);
  }, delayMs);
}

async function runNightlyTick(params: ScheduleNightlyParams): Promise<void> {
  const ctx = params.getSessionContext();
  if (!ctx) {
    console.log(`${TAG} nightly tick: no active session context, skip`);
  } else {
    try {
      await maybeCompactSession({
        deps: params.deps,
        cfg: params.cfg,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        sessionFile: ctx.sessionFile,
        workspaceDir: ctx.workspaceDir,
        agentDir: ctx.agentDir,
        provider: ctx.provider,
        model: ctx.model,
        thinkLevel: ctx.thinkLevel,
        minTokens: params.config.minTokens,
        ws: params.getActiveWs(),
        origin: "nightly",
      });
    } catch (err) {
      console.error(`${TAG} nightly tick error:`, err);
    }
  }
  // Rischedula comunque per domani.
  scheduleNightlyCompaction(params);
}

export function stopNightlyCompaction(): void {
  if (nightlyTimer) {
    clearTimeout(nightlyTimer);
    nightlyTimer = null;
  }
}
