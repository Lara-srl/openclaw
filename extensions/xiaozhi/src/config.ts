import { z } from "zod";

// ─── Compaction config (Plan 12) ───────────────────────────────────────────────

/** Defaults mirrored in Note/plans/12_Compaction.md. */
export const XIAOZHI_COMPACTION_DEFAULTS = {
  enabled: true,
  nightly: {
    enabled: true,
    hour: 3,
    minTokens: 8_000,
    timezone: "Europe/Rome",
  },
  threshold: {
    enabled: true,
    maxTokens: 25_000,
  },
  memoryFlush: {
    alwaysRun: true,
  },
} as const;

const XiaozhuCompactionNightlySchema = z
  .object({
    enabled: z.boolean().default(XIAOZHI_COMPACTION_DEFAULTS.nightly.enabled),
    hour: z.number().int().min(0).max(23).default(XIAOZHI_COMPACTION_DEFAULTS.nightly.hour),
    minTokens: z
      .number()
      .int()
      .nonnegative()
      .default(XIAOZHI_COMPACTION_DEFAULTS.nightly.minTokens),
    timezone: z.string().min(1).default(XIAOZHI_COMPACTION_DEFAULTS.nightly.timezone),
  })
  .strict()
  .default(XIAOZHI_COMPACTION_DEFAULTS.nightly);

const XiaozhuCompactionThresholdSchema = z
  .object({
    enabled: z.boolean().default(XIAOZHI_COMPACTION_DEFAULTS.threshold.enabled),
    maxTokens: z.number().int().positive().default(XIAOZHI_COMPACTION_DEFAULTS.threshold.maxTokens),
  })
  .strict()
  .default(XIAOZHI_COMPACTION_DEFAULTS.threshold);

const XiaozhuCompactionMemoryFlushSchema = z
  .object({
    /**
     * Se true, il memory flush gira PRIMA di ogni compaction xiaozhi bypassando
     * la decision function `shouldRunMemoryFlush()` del core. Necessario perché
     * con soglie xiaozhi basse (25K) la sessione non raggiunge mai la soglia
     * near-overflow del core (~117K) e il flush non scatterebbe mai.
     */
    alwaysRun: z.boolean().default(XIAOZHI_COMPACTION_DEFAULTS.memoryFlush.alwaysRun),
  })
  .strict()
  .default(XIAOZHI_COMPACTION_DEFAULTS.memoryFlush);

const XiaozhuCompactionSchema = z
  .object({
    enabled: z.boolean().default(XIAOZHI_COMPACTION_DEFAULTS.enabled),
    nightly: XiaozhuCompactionNightlySchema,
    threshold: XiaozhuCompactionThresholdSchema,
    memoryFlush: XiaozhuCompactionMemoryFlushSchema,
  })
  .strict()
  .default(XIAOZHI_COMPACTION_DEFAULTS);

export const XiaozhuConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** HMAC-SHA256 key for OTA token authentication */
    secret: z.string().optional(),
    /** WebSocket path for device connections */
    wsPath: z.string().default("/xiaozhi/v1/"),
    /** HTTP path for OTA endpoint */
    otaPath: z.string().default("/xiaozhi/ota/"),
    /** Plan 12 — proactive compaction (nightly + post-response safety net). */
    compaction: XiaozhuCompactionSchema,
  })
  .strict();

export type XiaozhuConfig = z.infer<typeof XiaozhuConfigSchema>;
export type XiaozhuCompactionConfig = XiaozhuConfig["compaction"];

export function parseXiaozhuConfig(value: unknown): XiaozhuConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return XiaozhuConfigSchema.parse(raw);
}

/**
 * Read compaction config from xiaozhi plugin config, regardless of the host
 * loader's storage shape. Checks, in order:
 *   1. `cfg.plugins.entries.xiaozhi.config` (canonical plugin config path)
 *   2. `cfg.plugins.entries.xiaozhi`        (flat shape used in openclaw.json)
 *   3. `cfg.plugins.xiaozhi`                (legacy / runtime-injected path)
 * Never throws — returns XIAOZHI_COMPACTION_DEFAULTS on any parse/shape error.
 * Used from audio-pipeline (Trigger B) and bridge (Trigger A).
 */
export function readXiaozhiCompactionConfig(cfg: unknown): XiaozhuCompactionConfig {
  try {
    const plugins = (cfg as Record<string, unknown> | undefined)?.plugins as
      | Record<string, unknown>
      | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;
    const xiaozhiEntry = entries?.xiaozhi as Record<string, unknown> | undefined;
    const nestedConfig = xiaozhiEntry?.config as Record<string, unknown> | undefined;
    const candidate =
      nestedConfig ?? xiaozhiEntry ?? (plugins?.xiaozhi as Record<string, unknown> | undefined);
    const parsed = parseXiaozhuConfig(candidate);
    return parsed.compaction;
  } catch {
    return XiaozhuConfigSchema.parse({}).compaction;
  }
}
