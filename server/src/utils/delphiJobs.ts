import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import Config from "../config";
import logger from "./logger";

const DELPHI_JOB_QUEUE_TABLE = "Delphi_JobQueue";
const AUTO_THEME_JOB_PREFIX = "auto-theme-refresh-";
const MAX_SCHEDULE_ATTEMPTS = 4;

type DelphiJobItem = Record<string, any> & {
  job_id: string;
  status: string;
  version?: number;
};

export type AutomaticDelphiAnalysisState = {
  managed: true;
  enabled: boolean;
  jobId: string;
  state:
    | "disabled"
    | "waiting_for_statements"
    | "idle"
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
  changed: boolean;
  unavailableReason?: string;
};

export type ScheduleAutomaticDelphiAnalysisOptions = {
  reason: string;
  statementCount?: number;
  /**
   * True for a data mutation. False for read-repair, which may create or
   * requeue a terminal job but must never postpone or duplicate pending work.
   */
  touchExisting: boolean;
};

function createDynamoDocumentClient(): DynamoDBDocumentClient {
  const config: DynamoDBClientConfig = {
    region: Config.AWS_REGION || "us-east-1",
  };

  if (Config.dynamoDbEndpoint) {
    config.endpoint = Config.dynamoDbEndpoint;
    config.credentials = {
      accessKeyId: "DUMMYIDEXAMPLE",
      secretAccessKey: "DUMMYEXAMPLEKEY",
    };
  } else if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: Config.AWS_ACCESS_KEY_ID,
      secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
    };
  }

  return DynamoDBDocumentClient.from(new DynamoDBClient(config), {
    marshallOptions: {
      convertEmptyValues: true,
      removeUndefinedValues: true,
    },
  });
}

const docClient = createDynamoDocumentClient();

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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function timestamp(value: unknown): number | null {
  const text = optionalString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
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
  item?: DelphiJobItem
): AutomaticDelphiAnalysisState["state"] {
  switch (item?.status) {
    case "PENDING":
      return "scheduled";
    case "PROCESSING":
    case "AWAITING_RECHECK":
      return "processing";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    default:
      return "idle";
  }
}

function toAnalysisState(
  conversationNumericId: number,
  item: DelphiJobItem | undefined,
  options: {
    changed?: boolean;
    statementCount?: number;
    stateOverride?: AutomaticDelphiAnalysisState["state"];
    unavailableReason?: string;
  } = {}
): AutomaticDelphiAnalysisState {
  const policy = automaticDelphiRefreshPolicy();
  return {
    managed: true,
    enabled: policy.enabled,
    jobId: automaticDelphiThemeJobId(conversationNumericId),
    state:
      options.stateOverride ||
      (policy.enabled ? lifecycleState(item) : "disabled"),
    status: optionalString(item?.status),
    statementCount:
      options.statementCount === undefined ? null : options.statementCount,
    minimumStatementCount: policy.minStatements,
    dirtyAt: optionalString(item?.dirty_at),
    dirtySince: optionalString(item?.dirty_since),
    notBefore:
      optionalString(item?.not_before) || optionalString(item?.next_not_before),
    startedAt: optionalString(item?.started_at),
    completedAt: optionalString(item?.completed_at),
    updatedAt: optionalString(item?.updated_at),
    rerunRequested: item?.rerun_requested === true,
    changed: options.changed === true,
    ...(options.unavailableReason
      ? { unavailableReason: options.unavailableReason }
      : {}),
  };
}

function isConditionalConflict(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

function errorName(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    return String((err as { name?: unknown }).name || "unknown");
  }
  return err instanceof Error ? err.message : "unknown";
}

async function loadStatementCountForScheduling(
  conversationNumericId: number,
  minimumStatementCount: number
): Promise<number> {
  if (minimumStatementCount === 0) return 0;
  const { default: pg } = await import("../db/pg-query");
  const rows = (await pg.queryP_readOnly(
    "SELECT COUNT(*)::int AS count FROM (" +
      "SELECT 1 FROM comments WHERE zid = ($1) AND is_meta = false " +
      "LIMIT ($2)" +
      ") AS theme_statement_threshold;",
    [conversationNumericId, minimumStatementCount]
  )) as Array<{ count?: number | string }>;
  return Number(rows?.[0]?.count || 0);
}

async function getAutomaticJob(
  conversationNumericId: number
): Promise<DelphiJobItem | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: DELPHI_JOB_QUEUE_TABLE,
      Key: { job_id: automaticDelphiThemeJobId(conversationNumericId) },
      ConsistentRead: true,
    })
  );
  return result.Item as DelphiJobItem | undefined;
}

function newAutomaticJob(
  conversationNumericId: number,
  now: string,
  notBefore: string,
  reason: string,
  statementCount: number | undefined
): DelphiJobItem {
  const policy = automaticDelphiRefreshPolicy();
  return {
    job_id: automaticDelphiThemeJobId(conversationNumericId),
    status: "PENDING",
    // StatusCreatedIndex is the worker's due queue. Automatic jobs use the
    // eligibility time as its sort key so future work is not read every poll.
    created_at: notBefore,
    updated_at: now,
    version: 1,
    worker_id: "none",
    job_type: "FULL_PIPELINE",
    priority: 40,
    conversation_id: String(conversationNumericId),
    retry_count: 0,
    max_retries: 3,
    timeout_seconds: 14400,
    job_config: JSON.stringify({
      include_moderation: false,
      exclude_comment_selections: true,
      generate_visualizations: false,
    }),
    job_results: JSON.stringify({}),
    logs: JSON.stringify({
      entries: [
        {
          timestamp: now,
          level: "INFO",
          message: `Automatic theme refresh scheduled (${reason})`,
        },
      ],
      log_location: "",
    }),
    created_by: "polis-auto-theme-refresh",
    auto_managed: true,
    refresh_kind: "themes",
    dirty_at: now,
    dirty_since: now,
    not_before: notBefore,
    debounce_ms: policy.debounceMs,
    min_interval_ms: policy.minIntervalMs,
    max_delay_ms: policy.maxDelayMs,
    last_trigger_reason: reason,
    statement_count_at_schedule: statementCount,
  };
}

async function updatePendingJob(
  item: DelphiJobItem,
  now: string,
  notBefore: string,
  reason: string,
  statementCount: number | undefined
): Promise<DelphiJobItem> {
  const policy = automaticDelphiRefreshPolicy();
  const result = await docClient.send(
    new UpdateCommand({
      TableName: DELPHI_JOB_QUEUE_TABLE,
      Key: { job_id: item.job_id },
      UpdateExpression:
        "SET not_before = :notBefore, created_at = :notBefore, dirty_at = :now, updated_at = :now, " +
        "last_trigger_reason = :reason, debounce_ms = :debounceMs, " +
        "min_interval_ms = :minIntervalMs, max_delay_ms = :maxDelayMs, " +
        "statement_count_at_schedule = :statementCount",
      ConditionExpression: "#status = :pending AND #version = :version",
      ExpressionAttributeNames: {
        "#status": "status",
        "#version": "version",
      },
      ExpressionAttributeValues: {
        ":pending": "PENDING",
        ":version": item.version || 1,
        ":notBefore": notBefore,
        ":now": now,
        ":reason": reason,
        ":debounceMs": policy.debounceMs,
        ":minIntervalMs": policy.minIntervalMs,
        ":maxDelayMs": policy.maxDelayMs,
        ":statementCount":
          statementCount ?? Number(item.statement_count_at_schedule || 0),
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return result.Attributes as DelphiJobItem;
}

async function requestFollowUpRun(
  item: DelphiJobItem,
  now: string,
  notBefore: string,
  reason: string,
  statementCount: number | undefined
): Promise<DelphiJobItem> {
  const policy = automaticDelphiRefreshPolicy();
  const result = await docClient.send(
    new UpdateCommand({
      TableName: DELPHI_JOB_QUEUE_TABLE,
      Key: { job_id: item.job_id },
      UpdateExpression:
        "SET rerun_requested = :yes, next_not_before = :notBefore, " +
        "dirty_at = :now, updated_at = :now, last_trigger_reason = :reason, " +
        "dirty_since = if_not_exists(dirty_since, :now), " +
        "min_interval_ms = :minIntervalMs, max_delay_ms = :maxDelayMs, " +
        "statement_count_at_schedule = :statementCount",
      ConditionExpression: "#status = :processing AND #version = :version",
      ExpressionAttributeNames: {
        "#status": "status",
        "#version": "version",
      },
      ExpressionAttributeValues: {
        ":processing": item.status,
        ":version": item.version || 1,
        ":yes": true,
        ":notBefore": notBefore,
        ":now": now,
        ":reason": reason,
        ":minIntervalMs": policy.minIntervalMs,
        ":maxDelayMs": policy.maxDelayMs,
        ":statementCount":
          statementCount ?? Number(item.statement_count_at_schedule || 0),
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return result.Attributes as DelphiJobItem;
}

async function requeueTerminalJob(
  item: DelphiJobItem,
  now: string,
  notBefore: string,
  reason: string,
  statementCount: number | undefined
): Promise<DelphiJobItem> {
  const policy = automaticDelphiRefreshPolicy();
  const currentVersion = item.version || 1;
  const result = await docClient.send(
    new UpdateCommand({
      TableName: DELPHI_JOB_QUEUE_TABLE,
      Key: { job_id: item.job_id },
      UpdateExpression:
        "SET #status = :pending, created_at = :notBefore, updated_at = :now, " +
        "#version = :newVersion, worker_id = :noWorker, retry_count = :zero, " +
        "not_before = :notBefore, dirty_at = :now, rerun_requested = :no, " +
        "dirty_since = :now, " +
        "last_trigger_reason = :reason, debounce_ms = :debounceMs, " +
        "min_interval_ms = :minIntervalMs, max_delay_ms = :maxDelayMs, " +
        "statement_count_at_schedule = :statementCount " +
        "REMOVE started_at, lock_expires_at, next_not_before",
      ConditionExpression: "#status = :currentStatus AND #version = :version",
      ExpressionAttributeNames: {
        "#status": "status",
        "#version": "version",
      },
      ExpressionAttributeValues: {
        ":pending": "PENDING",
        ":currentStatus": item.status,
        ":version": currentVersion,
        ":newVersion": currentVersion + 1,
        ":noWorker": "none",
        ":zero": 0,
        ":notBefore": notBefore,
        ":now": now,
        ":no": false,
        ":reason": reason,
        ":debounceMs": policy.debounceMs,
        ":minIntervalMs": policy.minIntervalMs,
        ":maxDelayMs": policy.maxDelayMs,
        ":statementCount":
          statementCount ?? Number(item.statement_count_at_schedule || 0),
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return result.Attributes as DelphiJobItem;
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
  const statementCount =
    options.statementCount ??
    (await loadStatementCountForScheduling(
      conversationNumericId,
      policy.minStatements
    ));
  if (statementCount < policy.minStatements) {
    return toAnalysisState(conversationNumericId, undefined, {
      statementCount,
      stateOverride: "waiting_for_statements",
    });
  }

  for (let attempt = 0; attempt < MAX_SCHEDULE_ATTEMPTS; attempt += 1) {
    const item = await getAutomaticJob(conversationNumericId);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const notBefore = nextAutomaticDelphiRunAt(
      nowMs,
      item?.completed_at,
      policy.debounceMs,
      policy.minIntervalMs,
      item?.dirty_since || now,
      policy.maxDelayMs
    );

    try {
      if (!item) {
        const created = newAutomaticJob(
          conversationNumericId,
          now,
          notBefore,
          options.reason,
          statementCount
        );
        await docClient.send(
          new PutCommand({
            TableName: DELPHI_JOB_QUEUE_TABLE,
            Item: created,
            ConditionExpression: "attribute_not_exists(job_id)",
          })
        );
        return toAnalysisState(conversationNumericId, created, {
          changed: true,
          statementCount,
        });
      }

      if (item.status === "PENDING") {
        if (!options.touchExisting) {
          return toAnalysisState(conversationNumericId, item, {
            statementCount,
          });
        }
        const updated = await updatePendingJob(
          item,
          now,
          notBefore,
          options.reason,
          statementCount
        );
        return toAnalysisState(conversationNumericId, updated, {
          changed: true,
          statementCount,
        });
      }

      if (item.status === "PROCESSING" || item.status === "AWAITING_RECHECK") {
        if (!options.touchExisting) {
          return toAnalysisState(conversationNumericId, item, {
            statementCount,
          });
        }
        const updated = await requestFollowUpRun(
          item,
          now,
          notBefore,
          options.reason,
          statementCount
        );
        return toAnalysisState(conversationNumericId, updated, {
          changed: true,
          statementCount,
        });
      }

      const updated = await requeueTerminalJob(
        item,
        now,
        notBefore,
        options.reason,
        statementCount
      );
      return toAnalysisState(conversationNumericId, updated, {
        changed: true,
        statementCount,
      });
    } catch (err) {
      if (isConditionalConflict(err)) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("Automatic Delphi job changed too frequently to schedule");
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
  if (statementCount !== undefined && statementCount < policy.minStatements) {
    return toAnalysisState(conversationNumericId, undefined, {
      statementCount,
      stateOverride: "waiting_for_statements",
    });
  }
  try {
    return toAnalysisState(
      conversationNumericId,
      await getAutomaticJob(conversationNumericId),
      { statementCount }
    );
  } catch (err) {
    return toAnalysisState(conversationNumericId, undefined, {
      statementCount,
      stateOverride: "unavailable",
      unavailableReason: errorName(err),
    });
  }
}
