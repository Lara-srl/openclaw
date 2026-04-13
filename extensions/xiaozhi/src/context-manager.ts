/**
 * Plan 12 — Session rotation proattiva per xiaozhi (TODO 3).
 *
 * Post-analisi F3/F4 (vedi Note/plans/12_Compaction.md): `compactEmbeddedPiSession`
 * su sessioni vocali xiaozhi produce cut points che lasciano ~0 messaggi da
 * riassumere (Pi usa `keepRecentTokens=20000` + heuristic chars/4 non allineato
 * ai token reali del LLM → cutIndex=0 → safeguard "no real conversation messages
 * to summarize" → compaction cancelled in loop).
 *
 * Strategia nuova (questa implementazione): ROTAZIONE di sessione tramite
 * `resetEmbeddedPiSession` (equivalente extension-side di `/new` dal gateway).
 * L'hook bundled `session-memory` genera automaticamente
 * `memory/YYYY-MM-DD-<slug>.md` con summary LLM dell'ultima finestra di 15
 * messaggi, il transcript vecchio viene archiviato come `.jsonl.reset.<ts>`,
 * e il prossimo turno voice parte con contesto pulito + `MEMORY.md`
 * auto-iniettato come bootstrap file (è first-class in `workspace.ts`, vedi
 * `MINIMAL_BOOTSTRAP_ALLOWLIST` — xiaozhi usa sessionKey="agent:main:voice" quindi NON
 * viene filtrato).
 *
 * Due trigger combinati, entrambi POST-response (mai prima della risposta vocale):
 *   Trigger A (nightly, principale): setTimeout a `config.nightly.hour` (default 3:00)
 *   Trigger B (safety net, post-response): fire-and-forget dopo ogni `runAgent()`
 *
 * Sorgente di verità per il conteggio token: ULTIMO entry assistant del JSONL
 * (`message.usage.totalTokens`). Il runtime cache `sessionEntry.totalTokens` è
 * spesso `null` anche con conversazione reale — non ci affidiamo a quello.
 */

import fs from "node:fs/promises";
import type { WebSocket } from "ws";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { buildLlm } from "./protocol.js";
import { AdaUiState, buildUiState } from "./ui-state.js";

const TAG = "[xiaozhi:context-manager]";

/** Ultimi 16 KB del JSONL bastano ampiamente a contenere l'ultima entry. */
const HANDLE_TAIL = 16 * 1024;

/**
 * Debounce post-success: dopo una rotation riuscita il nuovo session file è
 * vuoto (tokens=0) quindi la soglia non scatta da sola, ma teniamo comunque
 * 10 minuti di silenzio per evitare nightly+threshold concorrenti sullo stesso
 * turno e dare tempo all'utente di accumulare contesto fresco.
 */
const ROTATION_DEBOUNCE_SUCCESS_MS = 10 * 60 * 1000;

/**
 * Debounce post-error/skip: 60s è sufficiente ad assorbire race condition di
 * un errore transitorio (es. file lock) senza bloccare l'utente per l'intera
 * finestra success.
 */
const ROTATION_DEBOUNCE_FALLBACK_MS = 60 * 1000;

type DebounceEntry = {
  at: number;
  windowMs: number;
  outcome: "success" | "error";
};

const lastRotatedAt = new Map<string, DebounceEntry>();

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

// ─── Rotation runner ──────────────────────────────────────────────────────────

export type MaybeRotateParams = {
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
  /** Minimum token count to trigger rotation (configurable per call site). */
  minTokens: number;
  /** Active device WS — usato per il feedback "Sto organizzando i ricordi...". */
  ws?: WebSocket | null;
  /** Human-readable origin for logs ("nightly" | "threshold"). */
  origin: "nightly" | "threshold";
};

/**
 * Fire-and-forget session rotation: debounce → read tokens from JSONL →
 * `resetEmbeddedPiSession` (minta un nuovo sessionId, fires `command/new` hook
 * → `session-memory` handler scrive `memory/<date>-<slug>.md`, archivia
 * vecchio transcript come `.jsonl.reset.<ts>`).
 *
 * Chiamato post-response: al prossimo turno voice `resolveMainSessionContext`
 * leggerà il nuovo sessionId dallo store e Pi creerà un session file pulito.
 *
 * Fallimenti loggati ma MAI propagati (voice pipeline non deve crashare).
 */
export async function maybeRotateSession(params: MaybeRotateParams): Promise<void> {
  const { deps, cfg, sessionKey, sessionFile, origin, minTokens, sessionId } = params;

  // Runtime guard: se il build core non espone resetEmbeddedPiSession
  // (dist/ vecchio), skip silenzioso.
  if (typeof deps.resetEmbeddedPiSession !== "function") {
    console.log(`${TAG} skip origin=${origin} reason=resetEmbeddedPiSession-not-exported`);
    return;
  }

  // Debounce: success=10min, error=60s.
  const debounceKey = `${sessionKey}|${origin}`;
  const lastEntry = lastRotatedAt.get(debounceKey);
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

  console.log(`${TAG} tokens=${tokens} threshold=${minTokens} origin=${origin} outcome=rotating`);

  const ws = params.ws;
  const wsOpen = ws && ws.readyState === ws.OPEN;

  // Feedback schermo: inizio rotation
  if (wsOpen) {
    try {
      const frame = buildUiState(AdaUiState.COMPACTION, { text: "Organizzo i ricordi..." });
      console.log(`${TAG} [UI] → ${frame}`);
      ws!.send(frame);
    } catch {
      // non bloccante
    }
  }

  const setDebounce = (outcome: "success" | "error") => {
    const windowMs =
      outcome === "success" ? ROTATION_DEBOUNCE_SUCCESS_MS : ROTATION_DEBOUNCE_FALLBACK_MS;
    lastRotatedAt.set(debounceKey, { at: Date.now(), windowMs, outcome });
  };

  try {
    console.log(`${TAG} rotation start origin=${origin} oldSessionId=${sessionId}`);
    const result = await deps.resetEmbeddedPiSession!({
      sessionKey,
      reason: "new",
      cfg,
      commandSource: `xiaozhi:${origin}`,
    });

    console.log(
      `${TAG} rotation completed origin=${origin} oldSessionId=${result.oldSessionId ?? "(none)"} newSessionId=${result.newSessionId} archived=${result.archivedFiles.length}`,
    );

    // Feedback schermo: fine OK
    if (wsOpen) {
      try {
        const frame = buildUiState(AdaUiState.IDLE);
        console.log(`${TAG} [UI] → ${frame}`);
        ws!.send(frame);
      } catch {
        // non bloccante
      }
    }

    setDebounce("success");
  } catch (err) {
    // Nessun feedback schermo su errore — resta silenzioso (solo log server-side).
    console.error(`${TAG} rotation error origin=${origin}:`, err);
    setDebounce("error");
  }
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
    const sessionKey = "agent:main:voice";
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
    console.log(`${TAG} nightly rotation disabled by config`);
    return;
  }
  stopNightlyCompaction();

  const delayMs = computeNextNightlyDelayMs(params.config.hour, params.config.timezone);
  const targetDate = new Date(Date.now() + delayMs);
  console.log(
    `${TAG} nightly rotation scheduled for ${targetDate.toISOString()} (in ${Math.round(delayMs / 1000)}s, hour=${params.config.hour} tz=${params.config.timezone})`,
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
      await maybeRotateSession({
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
