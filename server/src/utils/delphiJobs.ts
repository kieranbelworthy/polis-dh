import Config from "../config";
import logger from "./logger";

const AUTO_THEME_JOB_PREFIX = "auto-theme-refresh-";

type DelphiThemeJobRow = {
  zid: number;
  source_revision: number | string;
  completed_revision: number | string;
  processing_revision: number | string | null;
  status: "pending" | "processing" | "completed" | "failed";
  dirty_at: string | Date | null;
  dirty_since: string | Date | null;
  not_before: string | Date | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  updated_at: string | Date | null;
  last_error: string | null;
};

export type AutomaticDelphiAnalysisState = {
  managed: true;
  enabled: boolean;
  jobId: string;
  state:
    | "disabled"
    | "waiting_for_statements"
    | "idle"
    | "scheduling"
    | "scheduled"
    | "processing"
    | "completed"
    | "failed"
    | "unavailable";
  status: string | null;
  statementCount: number | null;
  minimumStatementCount: number;
  dirtyAt: string | null;
  dirtySince: string | null;
  notBefore: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  rerunRequested: boolean;
  sourceRevision: number;
  completedRevision: number;
  changed: boolean;
  unavailableReason?: string;
};

export type ScheduleAutomaticDelphiAnalysisOptions = {
  reason: string;
  statementCount?: number;
  /**
   * Mutations are normally recorded by the PostgreSQL comments trigger. This
   * option may update scheduling metadata, but deliberately never increments
   * the source revision itself.
   */
  touchExisting: boolean;
};

function configuredNonNegativeInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function automaticDelphiRefreshPolicy() {
  return {
    enabled: Config.delphiAutoRefreshEnabled,
    debounceMs: configuredNonNegativeInteger(
      Config.delphiAutoRefreshDebounceMs,
      5 * 60 * 1000
    ),
    minIntervalMs: configuredNonNegativeInteger(
      Config.delphiAutoRefreshMinIntervalMs,
      30 * 60 * 1000
    ),
    maxDelayMs: configuredNonNegativeInteger(
      Config.delphiAutoRefreshMaxDelayMs,
      60 * 60 * 1000
    ),
    minStatements: configuredNonNegativeInteger(
      Config.delphiAutoRefreshMinStatements,
      5
    ),
  };
}

export function automaticDelphiThemeJobId(
  conversationNumericId: number
): string {
  return `${AUTO_THEME_JOB_PREFIX}${conversationNumericId}`;
}

function timestamp(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value: unknown): string | null {
  const parsed = timestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export function nextAutomaticDelphiRunAt(
  nowMs: number,
  completedAt: unknown,
  debounceMs: number,
  minIntervalMs: number,
  dirtySince?: unknown,
  maxDelayMs = Number.POSITIVE_INFINITY
): string {
  const afterQuietPeriod = nowMs + debounceMs;
  const dirtySinceMs = timestamp(dirtySince);
  const afterMaximumDelay =
    dirtySinceMs === null
      ? Number.POSITIVE_INFINITY
      : dirtySinceMs + maxDelayMs;
  const afterActivityWindow = Math.min(afterQuietPeriod, afterMaximumDelay);
  const completedAtMs = timestamp(completedAt);
  const afterMinimumInterval =
    completedAtMs === null ? 0 : completedAtMs + minIntervalMs;
  return new Date(
    Math.max(afterActivityWindow, afterMinimumInterval)
  ).toISOString();
}

function lifecycleState(
  item?: DelphiThemeJobRow
): AutomaticDelphiAnalysisState["state"] {
  switch (item?.status) {
    case "pending":
      return "scheduled";
    case "processing":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown");
}

function toAnalysisState(
  conversationNumericId: number,
  item: DelphiThemeJobRow | undefined,
  options: {
    changed?: boolean;
    statementCount?: number;
    stateOverride?: AutomaticDelphiAnalysisState["state"];
    unavailableReason?: string;
  } = {}
): AutomaticDelphiAnalysisState {
  const policy = automaticDelphiRefreshPolicy();
  const sourceRevision = integer(item?.source_revision);
  const completedRevision = integer(item?.completed_revision);
  return {
    managed: true,
    enabled: policy.enabled,
    jobId: automaticDelphiThemeJobId(conversationNumericId),
    state:
      options.stateOverride ||
      (policy.enabled ? lifecycleState(item) : "disabled"),
    status: item?.status || null,
    statementCount:
      options.statementCount === undefined ? null : options.statementCount,
    minimumStatementCount: policy.minStatements,
    dirtyAt: isoTimestamp(item?.dirty_at),
    dirtySince: isoTimestamp(item?.dirty_since),
    notBefore: isoTimestamp(item?.not_before),
    startedAt: isoTimestamp(item?.started_at),
    completedAt: isoTimestamp(item?.completed_at),
    updatedAt: isoTimestamp(item?.updated_at),
    rerunRequested:
      item?.status === "processing" &&
      sourceRevision > integer(item.processing_revision),
    sourceRevision,
    completedRevision,
    changed: options.changed === true,
    ...(options.unavailableReason
      ? { unavailableReason: options.unavailableReason }
      : {}),
  };
}

async function loadStatementCount(
  conversationNumericId: number
): Promise<number> {
  const { default: pg } = await import("../db/pg-query");
  const rows = await pg.queryP<{ count: number | string }>(
    "SELECT COUNT(*)::int AS count FROM comments " +
      "WHERE zid = ($1) AND is_meta = false AND COALESCE(mod, 0) > -1;",
    [conversationNumericId]
  );
  return integer(rows[0]?.count);
}

async function getAutomaticJob(
  conversationNumericId: number
): Promise<DelphiThemeJobRow | undefined> {
  const { default: pg } = await import("../db/pg-query");
  const rows = await pg.queryP<DelphiThemeJobRow>(
    "SELECT * FROM delphi_theme_jobs WHERE zid = ($1);",
    [conversationNumericId]
  );
  return rows[0];
}

export async function scheduleAutomaticDelphiAnalysis(
  conversationNumericId: number,
  options: ScheduleAutomaticDelphiAnalysisOptions
): Promise<AutomaticDelphiAnalysisState> {
  const policy = automaticDelphiRefreshPolicy();
  if (!policy.enabled) {
    return toAnalysisState(conversationNumericId, undefined, {
      statementCount: options.statementCount,
      stateOverride: "disabled",
    });
  }

  const statementCount = await loadStatementCount(conversationNumericId);
  if (statementCount < policy.minStatements) {
    return toAnalysisState(conversationNumericId, undefined, {
      statementCount,
      stateOverride: "waiting_for_statements",
    });
  }

  const existing = await getAutomaticJob(conversationNumericId);
  if (!existing) {
    const { default: pg } = await import("../db/pg-query");
    const notBefore = nextAutomaticDelphiRunAt(
      Date.now(),
      null,
      policy.debounceMs,
      policy.minIntervalMs,
      new Date().toISOString(),
      policy.maxDelayMs
    );
    const rows = await pg.queryP<DelphiThemeJobRow>(
      "INSERT INTO delphi_theme_jobs " +
        "(zid, source_revision, completed_revision, status, dirty_at, dirty_since, not_before, last_trigger_reason) " +
        "VALUES (($1), ($4), 0, 'pending', NOW(), NOW(), ($2), ($3)) " +
        "ON CONFLICT (zid) DO NOTHING RETURNING *;",
      [
        conversationNumericId,
        notBefore,
        options.reason,
        Math.max(1, statementCount),
      ]
    );
    const item = rows[0] || (await getAutomaticJob(conversationNumericId));
    return toAnalysisState(conversationNumericId, item, {
      changed: !!rows[0],
      statementCount,
    });
  }

  // The database trigger already marked actual comment writes dirty. A read
  // repair or route-level notification must not fabricate a new revision.
  const needsWork =
    integer(existing.source_revision) > integer(existing.completed_revision);
  if (!needsWork || !options.touchExisting) {
    return toAnalysisState(conversationNumericId, existing, { statementCount });
  }

  const notBefore = nextAutomaticDelphiRunAt(
    Date.now(),
    existing.completed_at,
    policy.debounceMs,
    policy.minIntervalMs,
    existing.dirty_since,
    policy.maxDelayMs
  );
  const { default: pg } = await import("../db/pg-query");
  const rows = await pg.queryP<DelphiThemeJobRow>(
    "UPDATE delphi_theme_jobs SET " +
      "status = CASE WHEN status = 'processing' THEN status ELSE 'pending' END, " +
      "not_before = ($2), updated_at = NOW(), last_trigger_reason = ($3) " +
      "WHERE zid = ($1) RETURNING *;",
    [conversationNumericId, notBefore, options.reason]
  );
  return toAnalysisState(conversationNumericId, rows[0] || existing, {
    changed: !!rows[0],
    statementCount,
  });
}

export async function scheduleAutomaticDelphiAnalysisBestEffort(
  conversationNumericId: number,
  options: ScheduleAutomaticDelphiAnalysisOptions
): Promise<AutomaticDelphiAnalysisState> {
  try {
    return await scheduleAutomaticDelphiAnalysis(
      conversationNumericId,
      options
    );
  } catch (err) {
    const reason = errorName(err);
    logger.warn("Automatic Delphi theme refresh could not be scheduled", {
      conversationNumericId,
      reason,
    });
    return toAnalysisState(conversationNumericId, undefined, {
      statementCount: options.statementCount,
      stateOverride: "unavailable",
      unavailableReason: reason,
    });
  }
}

export async function scheduleAutomaticDelphiAnalysisForStatementWrite(
  conversationNumericId: number,
  options: ScheduleAutomaticDelphiAnalysisOptions
): Promise<AutomaticDelphiAnalysisState> {
  return scheduleAutomaticDelphiAnalysisBestEffort(
    conversationNumericId,
    options
  );
}

export async function getAutomaticDelphiAnalysisStateBestEffort(
  conversationNumericId: number,
  statementCount?: number
): Promise<AutomaticDelphiAnalysisState> {
  const policy = automaticDelphiRefreshPolicy();
  if (!policy.enabled) {
    return toAnalysisState(conversationNumericId, undefined, {
      statementCount,
      stateOverride: "disabled",
    });
  }
  try {
    const resolvedStatementCount = await loadStatementCount(
      conversationNumericId
    );
    const item = await getAutomaticJob(conversationNumericId);
    if (resolvedStatementCount < policy.minStatements) {
      return toAnalysisState(conversationNumericId, item, {
        statementCount: resolvedStatementCount,
        stateOverride: "waiting_for_statements",
      });
    }
    return toAnalysisState(conversationNumericId, item, {
      statementCount: resolvedStatementCount,
    });
  } catch (err) {
    return toAnalysisState(conversationNumericId, undefined, {
      statementCount,
      stateOverride: "unavailable",
      unavailableReason: errorName(err),
    });
  }
}
