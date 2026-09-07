import crypto from "node:crypto";
import type { NextFunction, Response } from "express";

import { generateAndRegisterZinvite } from "../auth";
import { ensureParticipantForRequest } from "../auth/ensure-participant";
import Config from "../config";
import pg from "../db/pg-query";
import { sql_conversations } from "../db/sql";
import type { RequestWithP } from "../d";
import {
  addStar,
  buildConversationUrl,
  safeTimestampToMillis,
  updateConversationModifiedTime,
  updateLastInteractionTimeForConversation,
  updateVoteCount,
} from "../server-helpers";
import { DEFAULTS } from "../utils/constants";
import { failJson } from "../utils/fail";
import { isDuplicateKey } from "../utils/common";
import { getClusterAssignments } from "../utils/commentClusters";
import {
  loadDelphiTopicRuns,
  type DelphiTopic,
  type DelphiTopicRun,
} from "../utils/delphiTopics";
import {
  getAutomaticDelphiAnalysisStateBestEffort,
  scheduleAutomaticDelphiAnalysisBestEffort,
  scheduleAutomaticDelphiAnalysisForStatementWrite,
} from "../utils/delphiJobs";
import { buildParticipantOpinionGraphPositions } from "../utils/externalOpinionGraph";
import {
  buildCrossGroupAgreementMetrics,
  buildExternalGroupVoteStats,
  buildVoteStats,
  type ExternalGroupVoteStats,
  type VoteStats,
} from "../utils/externalInsightMetrics";
import { getPca } from "../utils/pca";
import type { PcaCacheItem } from "../utils/pca";
import logger from "../utils/logger";
import { handle_POST_comments } from "./comments";
import { votesPost } from "./votes";

type ExternalRequest = RequestWithP & {
  body: Record<string, any>;
  params?: Record<string, any>;
  query?: Record<string, any>;
  protocol?: string;
};

type ExternalVoteInput = {
  externalParticipantId: string;
  statementId: number;
  vote: number;
  highPriority?: boolean;
  starred?: boolean;
};

type ExternalVoteResult = {
  externalParticipantId: string;
  participantId: number;
  statementId: number;
  vote: number;
  mathRefreshQueued: boolean;
};

type ExternalParticipant = {
  userId: number;
  participantId: number;
  conversationNumericId: number;
};

type ExternalConversation = {
  conversationId: string;
  conversationNumericId: number;
  ownerUserId: number;
  topic: string | null;
};

type ExternalStatementRow = {
  tid: number;
  txt: string;
  created: number | string | null;
  modified: number | string | null;
  active: boolean;
  mod: number;
  pid: number;
  author_external_participant_id?: string | null;
};

type VoteCountRow = {
  tid: number;
  agree_count: number | string;
  disagree_count: number | string;
  pass_count: number | string;
  vote_count: number | string;
};

type ExternalStatementInsight = VoteStats & {
  statementId: number;
  text: string;
  created: number | null;
  modified: number | null;
  active: boolean;
  moderationStatus: number;
  authorExternalParticipantId: string | null;
  consensusScore: number;
  divisivenessScore: number;
  uncertaintyScore: number;
  majority: "agree" | "disagree" | "split" | "pass" | null;
  groupAwareConsensus: number | null;
  crossGroupAgreement: number | null;
  meanGroupAgreement: number | null;
  minimumRespondingGroupAgreement: number | null;
  meanRespondingGroupAgreement: number | null;
  minimumGroupParticipation: number | null;
  groupCount: number;
  respondingGroupCount: number;
  respondingGroupCoverage: number;
  commentExtremity: number | null;
  groupStats: Record<string, ExternalGroupVoteStats>;
};

type ExternalThemeStatement = ReturnType<typeof compactThemeStatement>;

type ThemeStatementAssignment = {
  statement: ExternalStatementInsight;
  confidence: number | null;
  distanceToCentroid: number | null;
};

class ExternalApiError extends Error {
  statusCode: number;
  publicError: string;

  constructor(statusCode: number, publicError: string) {
    super(publicError);
    this.statusCode = statusCode;
    this.publicError = publicError;
  }
}

class CapturingResponse {
  statusCode = 200;
  body: any;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: any) {
    this.body = body;
    return this;
  }

  send(body: any) {
    this.body = body;
    return this;
  }
}

const EXTERNAL_MATH_REFRESH_DEBOUNCE_MS = 30_000;

function getExternalApiKey(): string | null {
  return Config.externalApiKey || null;
}

function getExternalApiOwnerUserId(): number | null {
  const ownerUserId = Config.externalApiOwnerUserId;
  if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) {
    return null;
  }
  return ownerUserId;
}

function extractBearerToken(req: ExternalRequest): string | null {
  const rawHeader = req.headers?.authorization;
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const match = typeof header === "string" && header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualHash = crypto.createHash("sha256").update(actual).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

export function externalServiceAuth(
  req: ExternalRequest,
  res: Response,
  next: NextFunction
) {
  const apiKey = getExternalApiKey();
  const ownerUserId = getExternalApiOwnerUserId();
  const token = extractBearerToken(req);

  if (
    !apiKey ||
    !ownerUserId ||
    !token ||
    !timingSafeStringEqual(token, apiKey)
  ) {
    return failJson(res, 401, "polis_err_external_api_auth");
  }

  req.p = req.p || {};
  // Existing Pol.is internals call this userId field "uid".
  req.p.uid = ownerUserId;
  req.p.external_api_owner_user_id = ownerUserId;
  return next();
}

function readObject(value: any, name: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalApiError(400, `polis_err_param_invalid_${name}`);
  }
  return value;
}

function readRequiredString(
  source: Record<string, any>,
  name: string,
  maxLength: number,
  aliases: string[] = []
): string {
  const value = readAliasedValue(source, name, aliases);
  if (typeof value !== "string") {
    throw new ExternalApiError(400, `polis_err_param_missing_${name}`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new ExternalApiError(400, `polis_err_param_invalid_${name}`);
  }
  return trimmed;
}

function readOptionalString(
  source: Record<string, any>,
  name: string,
  maxLength: number,
  aliases: string[] = []
): string | undefined {
  const value = readAliasedValue(source, name, aliases);
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ExternalApiError(400, `polis_err_param_invalid_${name}`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new ExternalApiError(400, `polis_err_param_invalid_${name}`);
  }
  return trimmed;
}

function readOptionalBool(
  source: Record<string, any>,
  name: string,
  defaultValue: boolean,
  aliases: string[] = []
): boolean {
  const value = readAliasedValue(source, name, aliases);
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 0 || value === "0" || value === "false") {
    return false;
  }
  if (value === 1 || value === "1" || value === "true") {
    return true;
  }
  throw new ExternalApiError(400, `polis_err_param_invalid_${name}`);
}

function readOptionalBoolValue(
  source: Record<string, any>,
  name: string,
  aliases: string[] = []
): boolean | undefined {
  const value = readAliasedValue(source, name, aliases);
  if (value === undefined || value === null) {
    return undefined;
  }
  return readOptionalBool({ [name]: value }, name, false);
}

function readRequiredIntInRange(
  source: Record<string, any>,
  name: string,
  min: number,
  max: number,
  aliases: string[] = []
): number {
  const value = readAliasedValue(source, name, aliases);
  const parsed =
    typeof value === "number" && Number.isInteger(value)
      ? value
      : typeof value === "string" && value.trim()
      ? Number.parseInt(value, 10)
      : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ExternalApiError(400, `polis_err_param_invalid_${name}`);
  }
  return parsed;
}

function readOptionalIntInRange(
  source: Record<string, any>,
  name: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const value = readAliasedValue(source, name, []);
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return readRequiredIntInRange(source, name, min, max);
}

function readOptionalEnum<T extends string>(
  source: Record<string, any>,
  name: string,
  allowedValues: readonly T[],
  defaultValue: T
): T {
  const value = readAliasedValue(source, name, []);
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value !== "string" || !allowedValues.includes(value as T)) {
    throw new ExternalApiError(400, `polis_err_param_invalid_${name}`);
  }
  return value as T;
}

function readAliasedValue(
  source: Record<string, any>,
  preferredName: string,
  aliases: string[]
): any {
  for (const name of [preferredName, ...aliases]) {
    if (source[name] !== undefined && source[name] !== null) {
      return source[name];
    }
  }
  return undefined;
}

function getPathConversationId(req: ExternalRequest): string {
  return readRequiredString(req.params || {}, "conversationId", 300, [
    "conversation_id",
  ]);
}

function getPathStatementId(req: ExternalRequest): number {
  return readRequiredIntInRange(
    req.params || {},
    "statementId",
    0,
    2147483647,
    ["tid"]
  );
}

function sendExternalError(
  res: Response,
  err: any,
  fallbackError: string
): void {
  if (err instanceof ExternalApiError) {
    failJson(res, err.statusCode, err.publicError, err);
    return;
  }
  failJson(res, 500, fallbackError, err);
}

function mapParticipantError(err: any): ExternalApiError {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "polis_err_xid_required") {
    return new ExternalApiError(
      403,
      "polis_err_external_participant_id_required"
    );
  }
  if (message === "polis_err_xid_not_allowed") {
    return new ExternalApiError(
      403,
      "polis_err_external_participant_id_not_allowed"
    );
  }
  if (message === "polis_err_treevite_auth_required") {
    return new ExternalApiError(401, "polis_err_treevite_auth_required");
  }
  if (message.includes("polis_err_fetching_zid_for_conversation_id")) {
    return new ExternalApiError(404, "polis_err_unknown_conversation");
  }
  if (message.includes("polis_err")) {
    return new ExternalApiError(500, message);
  }
  return new ExternalApiError(500, "polis_err_external_participant");
}

function mapVoteError(err: any): ExternalApiError {
  if (err instanceof ExternalApiError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message === "polis_err_unknown_conversation") {
    return new ExternalApiError(404, "polis_err_unknown_conversation");
  }
  if (message === "polis_err_conversation_is_closed") {
    return new ExternalApiError(403, "polis_err_conversation_is_closed");
  }
  if (message === "polis_err_vote_duplicate") {
    return new ExternalApiError(406, "polis_err_vote_duplicate");
  }
  if (message.includes("polis_err")) {
    return new ExternalApiError(500, message);
  }
  return new ExternalApiError(500, "polis_err_external_vote");
}

async function resolveExternalParticipant(
  req: ExternalRequest,
  conversationId: string,
  externalParticipantId: string,
  cache?: Map<string, Promise<ExternalParticipant>>
): Promise<ExternalParticipant> {
  const cacheKey = `${conversationId}:${externalParticipantId}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    // Translate the readable external API names to the existing Pol.is
    // participant/XID internals used by ensureParticipantForRequest.
    const participantReq = {
      ...req,
      p: {
        conversation_id: conversationId,
        xid: externalParticipantId,
      },
      body: {
        ...(req.body || {}),
        conversation_id: conversationId,
        xid: externalParticipantId,
      },
      headers: req.headers || {},
      method: req.method || "POST",
    } as RequestWithP;

    try {
      const result = await ensureParticipantForRequest(participantReq, {
        createIfMissing: true,
        issueJWT: false,
      });

      if (
        result.uid === undefined ||
        result.pid === undefined ||
        participantReq.p.zid === undefined
      ) {
        throw new ExternalApiError(500, "polis_err_external_participant");
      }

      return {
        userId: result.uid,
        participantId: result.pid,
        conversationNumericId: participantReq.p.zid,
      };
    } catch (err) {
      if (err instanceof ExternalApiError) {
        throw err;
      }
      throw mapParticipantError(err);
    }
  })();

  cache?.set(cacheKey, promise);
  return promise;
}

async function registerExternalConversationId(
  conversationNumericId: number,
  conversationId?: string
): Promise<string> {
  if (!conversationId) {
    return generateAndRegisterZinvite(conversationNumericId, false);
  }

  await pg.queryP(
    "INSERT INTO zinvites (zid, zinvite, created, uuid) VALUES ($1, $2, default, gen_random_uuid());",
    [conversationNumericId, conversationId]
  );
  return conversationId;
}

async function resolveOwnedExternalConversation(
  req: ExternalRequest,
  conversationId: string,
  usePrimary = false
): Promise<ExternalConversation> {
  const ownerUserId = req.p.external_api_owner_user_id || req.p.uid;
  if (!ownerUserId) {
    throw new ExternalApiError(401, "polis_err_external_api_auth");
  }

  const query = usePrimary ? pg.queryP : pg.queryP_readOnly;
  const rows = (await query(
    "SELECT z.zid, z.zinvite, c.owner, c.topic " +
      "FROM zinvites z INNER JOIN conversations c ON c.zid = z.zid " +
      "WHERE z.zinvite = ($1) LIMIT 1;",
    [conversationId]
  )) as Array<{
    zid: number;
    zinvite: string;
    owner: number;
    topic: string | null;
  }>;

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ExternalApiError(404, "polis_err_unknown_conversation");
  }

  const row = rows[0];
  if (Number(row.owner) !== Number(ownerUserId)) {
    throw new ExternalApiError(404, "polis_err_unknown_conversation");
  }

  return {
    conversationId: row.zinvite,
    conversationNumericId: Number(row.zid),
    ownerUserId: Number(row.owner),
    topic: row.topic,
  };
}

async function queueExternalMathRefresh(
  conversationNumericId: number,
  mathUpdateType = "update",
  debounceMs = EXTERNAL_MATH_REFRESH_DEBOUNCE_MS
): Promise<boolean> {
  const rows = (await pg.queryP(
    "INSERT INTO worker_tasks (task_type, task_data, task_bucket, math_env) " +
      "SELECT 'update_math'::varchar, $1::jsonb, $2::bigint, $3::varchar " +
      "WHERE NOT EXISTS ( " +
      "SELECT 1 FROM worker_tasks " +
      "WHERE task_type = 'update_math' " +
      "AND task_bucket = $2::bigint " +
      "AND math_env = $3::varchar " +
      "AND created > (now_as_millis() - $4::bigint) " +
      ") " +
      "ON CONFLICT (math_env, task_type, task_bucket) " +
      "WHERE finished_time IS NULL AND task_type = 'update_math' " +
      "DO UPDATE SET created = now_as_millis(), task_data = EXCLUDED.task_data, attempts = 0 " +
      "WHERE worker_tasks.created <= (now_as_millis() - $4::bigint) " +
      "RETURNING created;",
    [
      JSON.stringify({
        zid: conversationNumericId,
        math_update_type: mathUpdateType,
      }),
      conversationNumericId,
      Config.mathEnv,
      debounceMs,
    ]
  )) as Array<{ created: number }>;

  return Array.isArray(rows) && rows.length > 0;
}

async function queueExternalMathRefreshBestEffort(
  conversationNumericId: number,
  mathUpdateType = "update"
): Promise<boolean> {
  try {
    return await queueExternalMathRefresh(
      conversationNumericId,
      mathUpdateType
    );
  } catch (err) {
    logger.error("polis_err_external_math_refresh_enqueue", {
      conversationNumericId,
      mathUpdateType,
      err,
    });
    return false;
  }
}

function toNumber(value: any, defaultValue = 0): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function toNullableNumber(value: any): number | null {
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableTimestamp(value: any): number | null {
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundScore(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? roundScore(numerator / denominator) : 0;
}

function zeroVoteStats(): VoteStats {
  return buildVoteStats(0, 0, 0, 0);
}

function majorityFromVoteStats(
  stats: VoteStats
): "agree" | "disagree" | "split" | "pass" | null {
  const nonPassCount = stats.agreeCount + stats.disagreeCount;
  if (nonPassCount === 0) {
    return stats.passCount > 0 ? "pass" : null;
  }
  if (stats.agreeCount === stats.disagreeCount) {
    return "split";
  }
  return stats.agreeCount > stats.disagreeCount ? "agree" : "disagree";
}

function getPcaData(pca?: PcaCacheItem): Record<string, any> | undefined {
  return pca && pca.asPOJO ? pca.asPOJO : undefined;
}

function getPcaGroupClusters(data?: Record<string, any>) {
  const rawGroups = data?.["group-clusters"];
  const groups = Array.isArray(rawGroups)
    ? rawGroups
    : rawGroups && typeof rawGroups === "object"
    ? Object.entries(rawGroups).map(([id, group]: [string, any]) => ({
        id: group?.id ?? Number(id),
        center: group?.center,
        members: group?.members,
      }))
    : [];

  return groups
    .map((group: any) => ({
      id: toNumber(group?.id, Number.NaN),
      center: Array.isArray(group?.center)
        ? group.center.map((value: any) => toNumber(value))
        : [],
      members: Array.isArray(group?.members)
        ? group.members.map((value: any) => toNumber(value, Number.NaN))
        : [],
    }))
    .filter((group) => Number.isFinite(group.id));
}

function getPcaMathMeta(pca?: PcaCacheItem) {
  const data = getPcaData(pca);
  const mathTick = toNumber(data?.math_tick, 0);
  const groups = getPcaGroupClusters(data);
  return {
    mathReady: mathTick > 0,
    mathTick,
    groupCount: groups.length,
    hasGroups: groups.length > 0,
  };
}

async function buildExternalOpinionGraph(
  conversation: ExternalConversation,
  pca?: PcaCacheItem
) {
  const data = getPcaData(pca);
  const positions = buildParticipantOpinionGraphPositions(
    data,
    getPcaGroupClusters(data)
  );
  const externalIds = await loadParticipantExternalIdMap(conversation);
  const points = positions.map(({ participantId, ...position }) => ({
    externalParticipantId: externalIds.get(participantId) || null,
    ...position,
  }));
  return { dimensions: ["x", "y"], coordinateSystem: "polis-pca", points };
}

function buildNumberByTidMap(
  tids?: unknown[],
  values?: unknown[]
): Map<number, number> {
  const map = new Map<number, number>();
  if (!Array.isArray(tids) || !Array.isArray(values)) {
    return map;
  }

  values.forEach((value, index) => {
    const tid = toNumber(tids[index], Number.NaN);
    const numericValue = toNumber(value, Number.NaN);
    if (Number.isFinite(tid) && Number.isFinite(numericValue)) {
      map.set(tid, numericValue);
    }
  });
  return map;
}

function getPcaGroupVoteStatsByStatement(
  data?: Record<string, any>
): Map<number, Record<string, VoteStats>> {
  const statsByStatement = new Map<number, Record<string, VoteStats>>();
  const groups = getPcaGroupClusters(data);
  const groupVotes = data?.["group-votes"] || {};

  for (const group of groups) {
    const groupId = String(group.id);
    const votesForGroup = groupVotes[groupId]?.votes || {};

    for (const [statementId, votes] of Object.entries(votesForGroup)) {
      const tid = Number.parseInt(statementId, 10);
      if (!Number.isInteger(tid)) {
        continue;
      }

      const agreeCount = toNumber((votes as any)?.A);
      const disagreeCount = toNumber((votes as any)?.D);
      const voteCount = toNumber((votes as any)?.S);
      const passCount = Math.max(0, voteCount - agreeCount - disagreeCount);

      const existing = statsByStatement.get(tid) || {};
      existing[groupId] = buildVoteStats(
        agreeCount,
        disagreeCount,
        passCount,
        voteCount
      );
      statsByStatement.set(tid, existing);
    }
  }

  return statsByStatement;
}

async function loadExternalStatementRows(
  conversation: ExternalConversation
): Promise<ExternalStatementRow[]> {
  const rows = (await pg.queryP_readOnly(
    "SELECT DISTINCT ON (c.tid) " +
      "c.tid, c.txt, c.created, c.modified, c.active, c.mod, c.pid, " +
      "x.xid AS author_external_participant_id " +
      "FROM comments c " +
      "LEFT JOIN xids x ON x.uid = c.uid AND x.owner = ($2) " +
      "AND (x.zid = c.zid OR x.zid IS NULL) " +
      "WHERE c.zid = ($1) AND c.is_meta = false " +
      "ORDER BY c.tid, CASE WHEN x.zid = c.zid THEN 0 ELSE 1 END, x.created DESC;",
    [conversation.conversationNumericId, conversation.ownerUserId]
  )) as ExternalStatementRow[];

  return Array.isArray(rows) ? rows : [];
}

async function loadExternalVoteCounts(
  conversationNumericId: number
): Promise<Map<number, VoteStats>> {
  const rows = (await pg.queryP_readOnly(
    "SELECT tid, " +
      "SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END)::int AS agree_count, " +
      "SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END)::int AS disagree_count, " +
      "SUM(CASE WHEN vote = 0 THEN 1 ELSE 0 END)::int AS pass_count, " +
      "COUNT(*)::int AS vote_count " +
      "FROM votes_latest_unique WHERE zid = ($1) GROUP BY tid;",
    [conversationNumericId]
  )) as VoteCountRow[];

  const counts = new Map<number, VoteStats>();
  for (const row of rows || []) {
    counts.set(
      Number(row.tid),
      buildVoteStats(
        toNumber(row.agree_count),
        toNumber(row.disagree_count),
        toNumber(row.pass_count),
        toNumber(row.vote_count)
      )
    );
  }
  return counts;
}

async function buildExternalStatementInsights(
  conversation: ExternalConversation,
  pca?: PcaCacheItem
): Promise<ExternalStatementInsight[]> {
  const [statementRows, voteCounts] = await Promise.all([
    loadExternalStatementRows(conversation),
    loadExternalVoteCounts(conversation.conversationNumericId),
  ]);
  const pcaData = getPcaData(pca);
  const groups = getPcaGroupClusters(pcaData);
  const groupIds = groups.map((group) => String(group.id));
  const groupParticipantCounts = new Map(
    groups.map((group) => [
      String(group.id),
      getGroupParticipantIds(pcaData, group.members).length,
    ])
  );
  const groupStatsByStatement = getPcaGroupVoteStatsByStatement(pcaData);
  const commentExtremityByTid = buildNumberByTidMap(
    pcaData?.tids,
    pcaData?.pca?.["comment-extremity"]
  );
  const groupAwareConsensus = pcaData?.["group-aware-consensus"] || {};

  return statementRows.map((row) => {
    const statementId = Number(row.tid);
    const stats = voteCounts.get(statementId) || zeroVoteStats();
    const nonPassCount = stats.agreeCount + stats.disagreeCount;
    const groupStats: Record<string, ExternalGroupVoteStats> = {};
    const pcaGroupStats = groupStatsByStatement.get(statementId) || {};

    for (const groupId of groupIds) {
      groupStats[groupId] = buildExternalGroupVoteStats(
        pcaGroupStats[groupId] || zeroVoteStats(),
        groupParticipantCounts.get(groupId) || 0
      );
    }

    const crossGroupMetrics = buildCrossGroupAgreementMetrics(groupStats);

    return {
      statementId,
      text: row.txt,
      created: toNullableTimestamp(row.created),
      modified: toNullableTimestamp(row.modified),
      active: !!row.active,
      moderationStatus: toNumber(row.mod),
      authorExternalParticipantId: row.author_external_participant_id || null,
      ...stats,
      consensusScore: stats.voteCount
        ? ratio(
            Math.max(stats.agreeCount, stats.disagreeCount),
            stats.voteCount
          )
        : 0,
      divisivenessScore: nonPassCount
        ? ratio(Math.min(stats.agreeCount, stats.disagreeCount), nonPassCount)
        : 0,
      uncertaintyScore: stats.pass,
      majority: majorityFromVoteStats(stats),
      groupAwareConsensus: toNullableNumber(
        groupAwareConsensus[String(statementId)]
      ),
      ...crossGroupMetrics,
      commentExtremity:
        commentExtremityByTid.get(statementId) === undefined
          ? null
          : roundScore(commentExtremityByTid.get(statementId) as number),
      groupStats,
    };
  });
}

function getDelphiRunLayerIds(run: DelphiTopicRun): number[] {
  return Array.from(new Set(run.topics.map((topic) => topic.layerId))).sort(
    (left, right) => left - right
  );
}

function themeLayerGranularity(
  layerId: number,
  availableLayerIds: number[]
): "fine" | "intermediate" | "coarse" | "only" {
  if (availableLayerIds.length <= 1) {
    return "only";
  }
  if (layerId === availableLayerIds[0]) {
    return "fine";
  }
  if (layerId === availableLayerIds[availableLayerIds.length - 1]) {
    return "coarse";
  }
  return "intermediate";
}

function readThemeLayerSelection(
  query: Record<string, any>,
  availableLayerIds: number[]
): { requested: string; layerIds: number[] } {
  const raw = readAliasedValue(query, "layer", ["layerId", "layer_id"]);
  const requested =
    raw === undefined || raw === null || raw === ""
      ? "coarse"
      : typeof raw === "string"
      ? raw.trim().toLowerCase()
      : typeof raw === "number" && Number.isInteger(raw)
      ? String(raw)
      : "";

  if (!requested) {
    throw new ExternalApiError(400, "polis_err_param_invalid_layer");
  }
  if (availableLayerIds.length === 0) {
    if (
      requested !== "all" &&
      requested !== "fine" &&
      requested !== "coarse" &&
      !/^\d+$/.test(requested)
    ) {
      throw new ExternalApiError(400, "polis_err_param_invalid_layer");
    }
    return { requested, layerIds: [] };
  }
  if (requested === "all") {
    return { requested, layerIds: availableLayerIds };
  }
  if (requested === "fine") {
    return { requested, layerIds: [availableLayerIds[0]] };
  }
  if (requested === "coarse") {
    return {
      requested,
      layerIds: [availableLayerIds[availableLayerIds.length - 1]],
    };
  }
  if (!/^\d+$/.test(requested)) {
    throw new ExternalApiError(400, "polis_err_param_invalid_layer");
  }
  const layerId = Number.parseInt(requested, 10);
  if (!availableLayerIds.includes(layerId)) {
    throw new ExternalApiError(400, "polis_err_param_invalid_layer");
  }
  return { requested, layerIds: [layerId] };
}

function readLayerMetric(value: unknown, layerId: number): number | null {
  if (typeof value === "number" || typeof value === "string") {
    return toNullableNumber(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const metrics = value as Record<string, unknown>;
  return toNullableNumber(
    metrics[`layer${layerId}`] ?? metrics[String(layerId)]
  );
}

function getThemeStatementAssignments(
  topic: DelphiTopic,
  clusterAssignments: Map<number, any>,
  statementsById: Map<number, ExternalStatementInsight>,
  includeInactive: boolean
): ThemeStatementAssignment[] {
  const assignments: ThemeStatementAssignment[] = [];
  const clusterField = `layer${topic.layerId}_cluster_id`;

  for (const [statementId, rawAssignment] of clusterAssignments.entries()) {
    const assignment = rawAssignment as Record<string, unknown>;
    if (toNumber(assignment[clusterField], Number.NaN) !== topic.clusterId) {
      continue;
    }
    const statement = statementsById.get(statementId);
    if (
      !statement ||
      statement.moderationStatus === -1 ||
      (!includeInactive && !statement.active)
    ) {
      continue;
    }
    assignments.push({
      statement,
      confidence: readLayerMetric(assignment.cluster_confidence, topic.layerId),
      distanceToCentroid: readLayerMetric(
        assignment.distance_to_centroid,
        topic.layerId
      ),
    });
  }

  return assignments.sort(
    (left, right) => left.statement.statementId - right.statement.statementId
  );
}

function aggregateThemeVoteStats(
  assignments: ThemeStatementAssignment[],
  groupId?: string
): VoteStats {
  let agreeCount = 0;
  let disagreeCount = 0;
  let passCount = 0;
  let voteCount = 0;

  for (const { statement } of assignments) {
    const stats = groupId ? statement.groupStats[groupId] : statement;
    if (!stats) {
      continue;
    }
    agreeCount += stats.agreeCount;
    disagreeCount += stats.disagreeCount;
    passCount += stats.passCount;
    voteCount += stats.voteCount;
  }

  return buildVoteStats(agreeCount, disagreeCount, passCount, voteCount);
}

function weightedThemeMean(
  assignments: ThemeStatementAssignment[],
  value: (statement: ExternalStatementInsight) => number | null
): number | null {
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const { statement } of assignments) {
    const metric = value(statement);
    if (
      metric === null ||
      !Number.isFinite(metric) ||
      statement.voteCount <= 0
    ) {
      continue;
    }
    weightedTotal += metric * statement.voteCount;
    totalWeight += statement.voteCount;
  }

  return totalWeight > 0 ? roundScore(weightedTotal / totalWeight) : null;
}

function meanAssignmentMetric(
  assignments: ThemeStatementAssignment[],
  value: (assignment: ThemeStatementAssignment) => number | null
): number | null {
  const values = assignments
    .map(value)
    .filter((metric): metric is number => metric !== null);
  return values.length > 0
    ? roundScore(
        values.reduce((total, metric) => total + metric, 0) / values.length
      )
    : null;
}

function compactThemeStatement(assignment: ThemeStatementAssignment) {
  const { statement, confidence, distanceToCentroid } = assignment;
  return {
    statementId: statement.statementId,
    text: statement.text,
    voteCount: statement.voteCount,
    agreeCount: statement.agreeCount,
    disagreeCount: statement.disagreeCount,
    passCount: statement.passCount,
    agreement: statement.agreement,
    disagreement: statement.disagreement,
    pass: statement.pass,
    active: statement.active,
    moderationStatus: statement.moderationStatus,
    majority: statement.majority,
    consensusScore: statement.consensusScore,
    divisivenessScore: statement.divisivenessScore,
    groupAwareConsensus: statement.groupAwareConsensus,
    confidence,
    distanceToCentroid,
  };
}

function detailedThemeStatement(
  assignment: ThemeStatementAssignment,
  includeGroupStats: boolean
) {
  const { groupStats, ...statement } = assignment.statement;
  return {
    ...statement,
    ...(includeGroupStats ? { groupStats } : {}),
    confidence: assignment.confidence,
    distanceToCentroid: assignment.distanceToCentroid,
  };
}

function takeThemeStatements(
  assignments: ThemeStatementAssignment[],
  limit: number,
  compare: (
    left: ThemeStatementAssignment,
    right: ThemeStatementAssignment
  ) => number
): ExternalThemeStatement[] {
  return [...assignments]
    .sort(
      (left, right) =>
        compare(left, right) ||
        left.statement.statementId - right.statement.statementId
    )
    .slice(0, limit)
    .map(compactThemeStatement);
}

function representativeThemeStatements(
  assignments: ThemeStatementAssignment[],
  limit: number
): ExternalThemeStatement[] {
  return takeThemeStatements(assignments, limit, (left, right) => {
    const leftConfidence = left.confidence ?? Number.NEGATIVE_INFINITY;
    const rightConfidence = right.confidence ?? Number.NEGATIVE_INFINITY;
    if (leftConfidence !== rightConfidence) {
      return rightConfidence - leftConfidence;
    }
    const leftDistance = left.distanceToCentroid ?? Number.POSITIVE_INFINITY;
    const rightDistance = right.distanceToCentroid ?? Number.POSITIVE_INFINITY;
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    return right.statement.voteCount - left.statement.voteCount;
  });
}

type ThemeRespondentCounts = {
  byTheme: Map<string, number>;
  byThemeAndGroup: Map<string, Map<string, number>>;
};

async function loadThemeRespondentCounts(
  conversationNumericId: number,
  assignmentsByTheme: Map<string, ThemeStatementAssignment[]>,
  groupMemberSets: Map<string, Set<number>>
): Promise<ThemeRespondentCounts> {
  const themeIds: string[] = [];
  const statementIds: number[] = [];

  for (const [themeId, assignments] of assignmentsByTheme.entries()) {
    for (const { statement } of assignments) {
      themeIds.push(themeId);
      statementIds.push(statement.statementId);
    }
  }
  const counts: ThemeRespondentCounts = {
    byTheme: new Map<string, number>(),
    byThemeAndGroup: new Map<string, Map<string, number>>(),
  };
  if (statementIds.length === 0) {
    return counts;
  }

  const groupIds: string[] = [];
  const groupParticipantIds: number[] = [];
  for (const [groupId, memberIds] of groupMemberSets.entries()) {
    for (const participantId of memberIds) {
      groupIds.push(groupId);
      groupParticipantIds.push(participantId);
    }
  }

  const themeCountQuery = pg.queryP_readOnly<{
    theme_id: string;
    respondent_count: number;
  }>(
    "WITH selected_theme_statements(theme_id, tid) AS (" +
      "SELECT * FROM UNNEST($2::text[], $3::int[])" +
      ") SELECT selected.theme_id, COUNT(DISTINCT votes.pid)::int AS respondent_count " +
      "FROM selected_theme_statements selected " +
      "INNER JOIN votes_latest_unique votes ON votes.tid = selected.tid " +
      "WHERE votes.zid = ($1) GROUP BY selected.theme_id;",
    [conversationNumericId, themeIds, statementIds]
  );
  const groupCountQuery =
    groupParticipantIds.length > 0
      ? pg.queryP_readOnly<{
          theme_id: string;
          group_id: string;
          respondent_count: number;
        }>(
          "WITH selected_theme_statements(theme_id, tid) AS (" +
            "SELECT * FROM UNNEST($2::text[], $3::int[])" +
            "), selected_group_members(group_id, pid) AS (" +
            "SELECT * FROM UNNEST($4::text[], $5::int[])" +
            ") SELECT selected.theme_id, members.group_id, " +
            "COUNT(DISTINCT votes.pid)::int AS respondent_count " +
            "FROM selected_theme_statements selected " +
            "INNER JOIN votes_latest_unique votes ON votes.tid = selected.tid " +
            "INNER JOIN selected_group_members members ON members.pid = votes.pid " +
            "WHERE votes.zid = ($1) GROUP BY selected.theme_id, members.group_id;",
          [
            conversationNumericId,
            themeIds,
            statementIds,
            groupIds,
            groupParticipantIds,
          ]
        )
      : Promise.resolve([]);
  const [themeRows, groupRows] = await Promise.all([
    themeCountQuery,
    groupCountQuery,
  ]);

  for (const row of themeRows || []) {
    counts.byTheme.set(row.theme_id, toNumber(row.respondent_count));
  }
  for (const row of groupRows || []) {
    const groupCounts =
      counts.byThemeAndGroup.get(row.theme_id) || new Map<string, number>();
    groupCounts.set(String(row.group_id), toNumber(row.respondent_count));
    counts.byThemeAndGroup.set(row.theme_id, groupCounts);
  }
  return counts;
}

function participantCoverage(count: number, participantCount: number): number {
  return ratio(count, participantCount);
}

function themeResponseSummary(
  stats: VoteStats,
  respondentCount: number,
  audienceParticipantCount: number
) {
  return {
    ...stats,
    respondentCount,
    respondentCoverage: participantCoverage(
      respondentCount,
      audienceParticipantCount
    ),
    averageStatementsVotedPerRespondent:
      respondentCount > 0 ? ratio(stats.voteCount, respondentCount) : 0,
  };
}

function getPcaGroupMemberSets(
  data: Record<string, any> | undefined
): Map<string, Set<number>> {
  const membersByGroup = new Map<string, Set<number>>();
  for (const group of getPcaGroupClusters(data)) {
    membersByGroup.set(
      String(group.id),
      new Set(getGroupParticipantIds(data, group.members))
    );
  }
  return membersByGroup;
}

function buildExternalThemeInsight(
  topic: DelphiTopic,
  assignments: ThemeStatementAssignment[],
  respondentCount: number,
  groupRespondentCounts: Map<string, number>,
  audienceParticipantCount: number,
  groupMemberSets: Map<string, Set<number>>,
  options: {
    includeGroupStats: boolean;
    includeStatements: boolean;
    highlightLimit: number;
    granularity: "fine" | "intermediate" | "coarse" | "only";
  }
) {
  const response = themeResponseSummary(
    aggregateThemeVoteStats(assignments),
    respondentCount,
    audienceParticipantCount
  );
  const groupStats: Record<
    string,
    ReturnType<typeof themeResponseSummary>
  > = {};

  if (options.includeGroupStats) {
    for (const [groupId, memberIds] of groupMemberSets.entries()) {
      groupStats[groupId] = themeResponseSummary(
        aggregateThemeVoteStats(assignments, groupId),
        groupRespondentCounts.get(groupId) || 0,
        memberIds.size
      );
    }
  }

  const respondedAssignments = assignments.filter(
    ({ statement }) => statement.voteCount > 0
  );
  const topAgreeStatements = takeThemeStatements(
    respondedAssignments,
    options.highlightLimit,
    (left, right) =>
      right.statement.agreement - left.statement.agreement ||
      right.statement.voteCount - left.statement.voteCount
  );
  const topDisagreeStatements = takeThemeStatements(
    respondedAssignments,
    options.highlightLimit,
    (left, right) =>
      right.statement.disagreement - left.statement.disagreement ||
      right.statement.voteCount - left.statement.voteCount
  );
  const mostDivisiveStatements = takeThemeStatements(
    respondedAssignments,
    options.highlightLimit,
    (left, right) =>
      right.statement.divisivenessScore - left.statement.divisivenessScore ||
      right.statement.voteCount - left.statement.voteCount
  );

  return {
    themeId: topic.topicKey,
    name: topic.topicName,
    jobId: topic.jobId,
    layerId: topic.layerId,
    clusterId: topic.clusterId,
    granularity: options.granularity,
    modelName: topic.modelName,
    generatedAt: topic.createdAt,
    statementCount: assignments.length,
    respondedStatementCount: respondedAssignments.length,
    statementIds: assignments.map(({ statement }) => statement.statementId),
    response,
    metrics: {
      meanStatementConsensus: weightedThemeMean(
        assignments,
        (statement) => statement.consensusScore
      ),
      meanStatementDivisiveness: weightedThemeMean(
        assignments,
        (statement) => statement.divisivenessScore
      ),
      meanStatementUncertainty: weightedThemeMean(
        assignments,
        (statement) => statement.uncertaintyScore
      ),
      meanGroupAwareConsensus: weightedThemeMean(
        assignments,
        (statement) => statement.groupAwareConsensus
      ),
      meanAssignmentConfidence: meanAssignmentMetric(
        assignments,
        (assignment) => assignment.confidence
      ),
      meanDistanceToCentroid: meanAssignmentMetric(
        assignments,
        (assignment) => assignment.distanceToCentroid
      ),
    },
    ...(options.includeGroupStats ? { groupStats } : {}),
    representativeStatements: representativeThemeStatements(
      assignments,
      options.highlightLimit
    ),
    highlights: {
      topAgreeStatements,
      topDisagreeStatements,
      mostDivisiveStatements,
    },
    ...(options.includeStatements
      ? {
          statements: assignments.map((assignment) =>
            detailedThemeStatement(assignment, options.includeGroupStats)
          ),
        }
      : {}),
  };
}

function sortAndLimitStatements(
  statements: ExternalStatementInsight[],
  options: {
    sort: string;
    limit: number;
    minVotes: number;
    minRespondedVotes?: number;
    majority?: "agree" | "disagree" | "split" | "pass";
    active?: boolean;
  }
): ExternalStatementInsight[] {
  const filtered = statements.filter(
    (statement) =>
      statement.voteCount >= options.minVotes &&
      statement.respondedVoteCount >= (options.minRespondedVotes || 0) &&
      (options.majority === undefined ||
        statement.majority === options.majority) &&
      (options.active === undefined || statement.active === options.active)
  );
  const descending = (
    left: ExternalStatementInsight,
    right: ExternalStatementInsight,
    score: (statement: ExternalStatementInsight) => number | null
  ) =>
    (score(right) || 0) - (score(left) || 0) ||
    left.statementId - right.statementId;

  if (options.sort === "votes") {
    filtered.sort(
      (left, right) =>
        right.voteCount - left.voteCount || left.statementId - right.statementId
    );
  } else if (options.sort === "consensus") {
    filtered.sort((left, right) =>
      descending(left, right, (statement) => statement.consensusScore)
    );
  } else if (options.sort === "crossGroupAgreement") {
    filtered.sort((left, right) => {
      const crossGroupDifference =
        (right.crossGroupAgreement ?? -1) - (left.crossGroupAgreement ?? -1);
      const meanGroupDifference =
        (right.meanGroupAgreement ?? -1) - (left.meanGroupAgreement ?? -1);
      return (
        crossGroupDifference ||
        meanGroupDifference ||
        right.respondedVoteCount - left.respondedVoteCount ||
        left.statementId - right.statementId
      );
    });
  } else if (options.sort === "availableAgreement") {
    filtered.sort((left, right) => {
      return (
        right.respondingGroupCoverage - left.respondingGroupCoverage ||
        (right.minimumRespondingGroupAgreement ?? -1) -
          (left.minimumRespondingGroupAgreement ?? -1) ||
        right.agreementAmongRespondents - left.agreementAmongRespondents ||
        right.respondedVoteCount - left.respondedVoteCount ||
        left.statementId - right.statementId
      );
    });
  } else if (options.sort === "agreementAmongRespondents") {
    filtered.sort(
      (left, right) =>
        right.agreementAmongRespondents - left.agreementAmongRespondents ||
        right.respondedVoteCount - left.respondedVoteCount ||
        left.statementId - right.statementId
    );
  } else if (options.sort === "divisive") {
    filtered.sort((left, right) =>
      descending(left, right, (statement) => statement.divisivenessScore)
    );
  } else if (options.sort === "uncertainty") {
    filtered.sort((left, right) =>
      descending(left, right, (statement) => statement.uncertaintyScore)
    );
  } else if (options.sort === "extremity") {
    filtered.sort((left, right) =>
      descending(left, right, (statement) => statement.commentExtremity)
    );
  } else {
    filtered.sort((left, right) => left.statementId - right.statementId);
  }

  return filtered.slice(0, options.limit);
}

async function loadExternalInsightStatus(
  conversation: ExternalConversation,
  pca?: PcaCacheItem
) {
  type StatusRow = {
    participant_count?: number | string;
    statement_count?: number | string;
    vote_count?: number | string;
    upvote_count?: number | string;
    last_vote_timestamp?: number | string | null;
    last_statement_timestamp?: number | string | null;
  };
  const rows = (await pg.queryP_readOnly(
    "SELECT " +
      "(SELECT COUNT(*)::int FROM participants WHERE zid = ($1)) AS participant_count, " +
      "(SELECT COUNT(*)::int FROM comments WHERE zid = ($1) AND is_meta = false) AS statement_count, " +
      "(SELECT COUNT(*)::int FROM votes_latest_unique WHERE zid = ($1)) AS vote_count, " +
      "(SELECT COUNT(*)::int FROM upvotes WHERE zid = ($1)) AS upvote_count, " +
      "(SELECT MAX(modified) FROM votes_latest_unique WHERE zid = ($1)) AS last_vote_timestamp, " +
      "(SELECT MAX(created) FROM comments WHERE zid = ($1) AND is_meta = false) AS last_statement_timestamp;",
    [conversation.conversationNumericId]
  )) as StatusRow[];
  const row: StatusRow = rows?.[0] || {};
  const mathMeta = getPcaMathMeta(pca);

  return {
    conversationId: conversation.conversationId,
    topic: conversation.topic,
    participantCount: toNumber(row.participant_count),
    statementCount: toNumber(row.statement_count),
    voteCount: toNumber(row.vote_count),
    upvoteCount: toNumber(row.upvote_count),
    lastVoteTimestamp: toNullableTimestamp(row.last_vote_timestamp),
    lastStatementTimestamp: toNullableTimestamp(row.last_statement_timestamp),
    ...mathMeta,
  };
}

async function loadParticipantExternalIdMap(
  conversation: ExternalConversation
): Promise<Map<number, string>> {
  const rows = (await pg.queryP_readOnly(
    "SELECT DISTINCT ON (p.pid) p.pid, x.xid " +
      "FROM participants p " +
      "LEFT JOIN xids x ON x.uid = p.uid AND x.owner = ($2) " +
      "AND (x.zid = p.zid OR x.zid IS NULL) " +
      "WHERE p.zid = ($1) " +
      "ORDER BY p.pid, CASE WHEN x.zid = p.zid THEN 0 ELSE 1 END, x.created DESC;",
    [conversation.conversationNumericId, conversation.ownerUserId]
  )) as Array<{ pid: number; xid: string | null }>;

  const map = new Map<number, string>();
  for (const row of rows || []) {
    if (row.xid) {
      map.set(Number(row.pid), row.xid);
    }
  }
  return map;
}

async function findExternalParticipantId(
  conversation: ExternalConversation,
  externalParticipantId: string
): Promise<number | null> {
  const rows = (await pg.queryP_readOnly(
    "SELECT p.pid FROM xids x " +
      "INNER JOIN participants p ON p.uid = x.uid AND p.zid = ($1) " +
      "WHERE x.owner = ($2) AND x.xid = ($3) " +
      "AND (x.zid = ($1) OR x.zid IS NULL) " +
      "ORDER BY CASE WHEN x.zid = ($1) THEN 0 ELSE 1 END, x.created DESC " +
      "LIMIT 1;",
    [
      conversation.conversationNumericId,
      conversation.ownerUserId,
      externalParticipantId,
    ]
  )) as Array<{ pid: number }>;

  return Array.isArray(rows) && rows.length > 0 ? Number(rows[0].pid) : null;
}

export function buildExternalGroupMembershipAssignment(
  pca: PcaCacheItem | undefined,
  participantId: number | null
) {
  const mathMeta = getPcaMathMeta(pca);
  if (!mathMeta.mathReady) {
    return { status: "unavailable" as const };
  }
  if (participantId === null || !Number.isFinite(participantId)) {
    return { status: "participant_not_found" as const };
  }

  for (const [groupId, participantIds] of getPcaGroupMemberSets(
    getPcaData(pca)
  ).entries()) {
    if (participantIds.has(participantId)) {
      return { status: "assigned" as const, groupId };
    }
  }

  return { status: "unassigned" as const };
}

function getPcaItemTid(item: any): number | null {
  if (Number.isInteger(item)) {
    return item;
  }
  if (item && typeof item === "object") {
    for (const key of ["tid", "statementId", "comment_id", "id"]) {
      const tid = toNumber(item[key], Number.NaN);
      if (Number.isInteger(tid)) {
        return tid;
      }
    }
  }
  return null;
}

function getPcaItemScore(item: any): number | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  for (const key of ["score", "repness", "repful_for", "repful-for"]) {
    const score = toNullableNumber(item[key]);
    if (score !== null) {
      return roundScore(score);
    }
  }
  return null;
}

function compactStatement(
  statement: ExternalStatementInsight,
  score?: number | null
) {
  return {
    statementId: statement.statementId,
    text: statement.text,
    voteCount: statement.voteCount,
    agreeCount: statement.agreeCount,
    disagreeCount: statement.disagreeCount,
    passCount: statement.passCount,
    ...(score === undefined ? {} : { score }),
  };
}

function buildRepresentativeStatements(
  data: Record<string, any> | undefined,
  groupId: string,
  statementsById: Map<number, ExternalStatementInsight>
) {
  const rawItems = data?.repness?.[groupId] || [];
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const seen = new Set<number>();
  const statements = [];
  for (const item of rawItems) {
    const statementId = getPcaItemTid(item);
    if (statementId === null || seen.has(statementId)) {
      continue;
    }
    const statement = statementsById.get(statementId);
    if (!statement) {
      continue;
    }
    seen.add(statementId);
    statements.push(compactStatement(statement, getPcaItemScore(item)));
    if (statements.length >= 5) {
      break;
    }
  }
  return statements;
}

function buildTopGroupStatements(
  statements: ExternalStatementInsight[],
  groupId: string,
  direction: "agree" | "disagree"
) {
  return statements
    .filter((statement) => (statement.groupStats[groupId]?.voteCount || 0) > 0)
    .sort((left, right) => {
      const leftStats = left.groupStats[groupId];
      const rightStats = right.groupStats[groupId];
      const leftScore =
        direction === "agree" ? leftStats.agreement : leftStats.disagreement;
      const rightScore =
        direction === "agree" ? rightStats.agreement : rightStats.disagreement;
      return (
        rightScore - leftScore ||
        rightStats.voteCount - leftStats.voteCount ||
        left.statementId - right.statementId
      );
    })
    .slice(0, 5)
    .map((statement) =>
      compactStatement(
        statement,
        direction === "agree"
          ? statement.groupStats[groupId].agreement
          : statement.groupStats[groupId].disagreement
      )
    );
}

function getGroupParticipantIds(
  data: Record<string, any> | undefined,
  baseClusterIds: number[]
): number[] {
  const baseClusters = data?.["base-clusters"];
  if (!baseClusters || !Array.isArray(baseClusters.id)) {
    return [];
  }

  const baseIndexById = new Map<number, number>();
  baseClusters.id.forEach((id: any, index: number) => {
    const numericId = toNumber(id, Number.NaN);
    if (Number.isFinite(numericId)) {
      baseIndexById.set(numericId, index);
    }
  });

  const participantIds = new Set<number>();
  for (const baseClusterId of baseClusterIds) {
    const index = baseIndexById.get(baseClusterId);
    const members =
      index === undefined || !Array.isArray(baseClusters.members?.[index])
        ? []
        : baseClusters.members[index];
    for (const pid of members) {
      const numericPid = toNumber(pid, Number.NaN);
      if (Number.isFinite(numericPid)) {
        participantIds.add(numericPid);
      }
    }
  }

  return Array.from(participantIds).sort((left, right) => left - right);
}

async function buildExternalGroupInsights(
  conversation: ExternalConversation,
  pca: PcaCacheItem | undefined,
  statements: ExternalStatementInsight[],
  includeParticipants: boolean
) {
  const data = getPcaData(pca);
  const groups = getPcaGroupClusters(data);
  const statementsById = new Map(
    statements.map((statement) => [statement.statementId, statement])
  );
  const participantExternalIds = includeParticipants
    ? await loadParticipantExternalIdMap(conversation)
    : new Map<number, string>();

  return groups.map((group) => {
    const participantIds = getGroupParticipantIds(data, group.members);
    const externalParticipantIds = includeParticipants
      ? participantIds
          .map((pid) => participantExternalIds.get(pid))
          .filter((xid): xid is string => !!xid)
          .sort()
      : undefined;

    return {
      groupId: String(group.id),
      center: group.center,
      participantCount: participantIds.length,
      ...(includeParticipants
        ? {
            externalParticipantIds,
            unmappedParticipantCount:
              participantIds.length - (externalParticipantIds || []).length,
          }
        : {}),
      representativeStatements: buildRepresentativeStatements(
        data,
        String(group.id),
        statementsById
      ),
      topAgreeStatements: buildTopGroupStatements(
        statements,
        String(group.id),
        "agree"
      ),
      topDisagreeStatements: buildTopGroupStatements(
        statements,
        String(group.id),
        "disagree"
      ),
    };
  });
}

export async function handle_GET_external_insights_status(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const conversation = await resolveOwnedExternalConversation(
      req,
      conversationId
    );
    const pca = await getPca(conversation.conversationNumericId);
    const status = await loadExternalInsightStatus(conversation, pca);

    res.status(200).json(status);
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_insights_status");
  }
}

export async function handle_GET_external_insights_statements(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const conversation = await resolveOwnedExternalConversation(
      req,
      conversationId
    );
    const query = req.query || {};
    const sort = readOptionalEnum(
      query,
      "sort",
      [
        "tid",
        "votes",
        "consensus",
        "crossGroupAgreement",
        "availableAgreement",
        "agreementAmongRespondents",
        "divisive",
        "divisiveness",
        "uncertainty",
        "extremity",
      ] as const,
      "tid"
    );
    const pca = await getPca(conversation.conversationNumericId);
    const statements = await buildExternalStatementInsights(conversation, pca);
    const majorityValue = readAliasedValue(query, "majority", []);
    const majority =
      majorityValue === undefined ||
      majorityValue === null ||
      majorityValue === ""
        ? undefined
        : readOptionalEnum(
            query,
            "majority",
            ["agree", "disagree", "split", "pass"] as const,
            "agree"
          );
    const limitedStatements = sortAndLimitStatements(statements, {
      sort: sort === "divisiveness" ? "divisive" : sort,
      limit: readOptionalIntInRange(query, "limit", 100, 1, 500),
      minVotes: readOptionalIntInRange(query, "minVotes", 0, 0, 1000000),
      minRespondedVotes: readOptionalIntInRange(
        query,
        "minRespondedVotes",
        0,
        0,
        1000000
      ),
      majority,
      active: readOptionalBoolValue(query, "active"),
    });

    res.status(200).json({
      conversationId: conversation.conversationId,
      ...getPcaMathMeta(pca),
      statements: limitedStatements,
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_insights_statements");
  }
}

export async function handle_GET_external_insights_groups(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const conversation = await resolveOwnedExternalConversation(
      req,
      conversationId
    );
    const query = req.query || {};
    const includeParticipants = readOptionalBool(
      query,
      "includeParticipants",
      true,
      ["include_participants"]
    );
    const pca = await getPca(conversation.conversationNumericId);
    const statements = await buildExternalStatementInsights(conversation, pca);
    const groups = await buildExternalGroupInsights(
      conversation,
      pca,
      statements,
      includeParticipants
    );

    res.status(200).json({
      conversationId: conversation.conversationId,
      ...getPcaMathMeta(pca),
      groups,
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_insights_groups");
  }
}

export async function handle_POST_external_insights_group_membership(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const body = readObject(req.body || {}, "body");
    const externalParticipantId = readRequiredString(
      body,
      "externalParticipantId",
      999,
      ["xid"]
    );
    const conversation = await resolveOwnedExternalConversation(
      req,
      conversationId
    );
    const [pca, participantId] = await Promise.all([
      getPca(conversation.conversationNumericId),
      findExternalParticipantId(conversation, externalParticipantId),
    ]);
    const { mathReady, mathTick } = getPcaMathMeta(pca);

    res.status(200).json({
      conversationId: conversation.conversationId,
      mathReady,
      mathTick,
      assignment: buildExternalGroupMembershipAssignment(pca, participantId),
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_insights_group_membership");
  }
}

export async function handle_GET_external_insights_graph(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const conversation = await resolveOwnedExternalConversation(
      req,
      conversationId
    );
    const pca = await getPca(conversation.conversationNumericId);
    const graph = await buildExternalOpinionGraph(conversation, pca);
    res.status(200).json({
      conversationId: conversation.conversationId,
      ...getPcaMathMeta(pca),
      ...graph,
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_insights_graph");
  }
}

export async function handle_GET_external_insights_themes(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const conversation = await resolveOwnedExternalConversation(
      req,
      conversationId
    );
    const query = req.query || {};
    const includeGroupStats = readOptionalBool(
      query,
      "includeGroupStats",
      true,
      ["include_group_stats"]
    );
    const includeStatements = readOptionalBool(
      query,
      "includeStatements",
      false,
      ["include_statements"]
    );
    const includeInactive = readOptionalBool(query, "includeInactive", false, [
      "include_inactive",
    ]);
    const highlightLimit = readOptionalIntInRange(
      query,
      "highlightLimit",
      5,
      1,
      20
    );

    const [pca, topicRunsResult] = await Promise.all([
      getPca(conversation.conversationNumericId),
      loadDelphiTopicRuns(conversation.conversationNumericId),
    ]);
    const selectedRun = topicRunsResult.runs[0] || null;
    const [clusterAssignments, status, statements] = await Promise.all([
      getClusterAssignments(
        conversation.conversationNumericId,
        false,
        selectedRun?.storage === "dynamodb" && Config.dynamoDbConfigured,
        selectedRun?.storage === "postgres",
        selectedRun?.storage === "postgres" ? selectedRun.jobId : undefined
      ),
      loadExternalInsightStatus(conversation, pca),
      buildExternalStatementInsights(conversation, pca),
    ]);
    const existingAnalysisLifecycle =
      await getAutomaticDelphiAnalysisStateBestEffort(
        conversation.conversationNumericId,
        status.statementCount
      );
    const availableLayerIds = selectedRun
      ? getDelphiRunLayerIds(selectedRun)
      : [];
    const layerSelection = readThemeLayerSelection(query, availableLayerIds);
    const selectedTopics = selectedRun
      ? selectedRun.topics.filter((topic) =>
          layerSelection.layerIds.includes(topic.layerId)
        )
      : [];
    const statementsById = new Map(
      statements.map((statement) => [statement.statementId, statement])
    );
    const assignmentsByTheme = new Map<string, ThemeStatementAssignment[]>();

    for (const topic of selectedTopics) {
      const assignments = getThemeStatementAssignments(
        topic,
        clusterAssignments,
        statementsById,
        includeInactive
      );
      assignmentsByTheme.set(topic.topicKey, assignments);
    }

    const assignedStatementIds = new Set<number>();
    for (const assignments of assignmentsByTheme.values()) {
      for (const { statement } of assignments) {
        assignedStatementIds.add(statement.statementId);
      }
    }
    const eligibleStatementCount = statements.filter(
      (statement) =>
        statement.moderationStatus !== -1 &&
        (includeInactive || statement.active)
    ).length;

    const pcaData = getPcaData(pca);
    const groupMemberSets = includeGroupStats
      ? getPcaGroupMemberSets(pcaData)
      : new Map<string, Set<number>>();
    const respondentCounts = await loadThemeRespondentCounts(
      conversation.conversationNumericId,
      assignmentsByTheme,
      groupMemberSets
    );
    const themes = selectedTopics
      .map((topic) =>
        buildExternalThemeInsight(
          topic,
          assignmentsByTheme.get(topic.topicKey) || [],
          respondentCounts.byTheme.get(topic.topicKey) || 0,
          respondentCounts.byThemeAndGroup.get(topic.topicKey) ||
            new Map<string, number>(),
          status.participantCount,
          groupMemberSets,
          {
            includeGroupStats,
            includeStatements,
            highlightLimit,
            granularity: themeLayerGranularity(
              topic.layerId,
              availableLayerIds
            ),
          }
        )
      )
      .sort(
        (left, right) =>
          right.layerId - left.layerId ||
          right.response.voteCount - left.response.voteCount ||
          left.name.localeCompare(right.name)
      );
    const analysisGeneratedAt = selectedRun?.createdAt
      ? Date.parse(selectedRun.createdAt)
      : Number.NaN;
    const revisionStale =
      selectedRun?.sourceRevision !== null &&
      selectedRun?.sourceRevision !== undefined &&
      existingAnalysisLifecycle.sourceRevision > selectedRun.sourceRevision;
    const themeAnalysisStale = selectedRun
      ? revisionStale
        ? true
        : Number.isFinite(analysisGeneratedAt) &&
          status.lastStatementTimestamp !== null
        ? analysisGeneratedAt < status.lastStatementTimestamp
        : false
      : null;
    const shouldRepairThemeAnalysis =
      topicRunsResult.available &&
      (!selectedRun || !selectedRun.createdAt || themeAnalysisStale === true);
    const analysisLifecycle = shouldRepairThemeAnalysis
      ? await scheduleAutomaticDelphiAnalysisBestEffort(
          conversation.conversationNumericId,
          {
            reason: selectedRun
              ? selectedRun.createdAt
                ? "stale_theme_analysis_read_repair"
                : "unknown_freshness_theme_analysis_read_repair"
              : "missing_theme_analysis_read_repair",
            statementCount: status.statementCount,
            touchExisting: false,
          }
        )
      : existingAnalysisLifecycle;
    const warnings: string[] = [];

    if (!topicRunsResult.available) {
      warnings.push("delphi_topic_store_unavailable");
    } else if (!selectedRun) {
      warnings.push("theme_analysis_not_run");
    } else if (clusterAssignments.size === 0) {
      warnings.push("theme_assignments_unavailable");
    } else if (!themes.some((theme) => theme.statementCount > 0)) {
      warnings.push("selected_themes_have_no_statement_assignments");
    }
    if (themeAnalysisStale) {
      warnings.push("theme_analysis_stale");
    }
    if (
      ["scheduling", "scheduled", "processing"].includes(
        analysisLifecycle.state
      )
    ) {
      warnings.push("theme_analysis_updating");
    } else if (analysisLifecycle.state === "waiting_for_statements") {
      warnings.push("theme_analysis_waiting_for_statements");
    } else if (analysisLifecycle.state === "unavailable") {
      warnings.push("theme_refresh_unavailable");
    } else if (analysisLifecycle.state === "disabled") {
      warnings.push("theme_refresh_disabled");
    }
    if (!status.mathReady) {
      warnings.push("math_not_ready");
    }

    res.status(200).json({
      ...status,
      themeAnalysisReady: !!selectedRun,
      themeAnalysisStale,
      themeStatsReady: themes.some((theme) => theme.statementCount > 0),
      analysisLifecycle,
      readiness: {
        themes: !!selectedRun,
        assignments:
          clusterAssignments.size > 0 &&
          themes.some((theme) => theme.statementCount > 0),
        math: status.mathReady,
      },
      analysis: selectedRun
        ? {
            jobId: selectedRun.jobId,
            generatedAt: selectedRun.createdAt,
            modelNames: selectedRun.modelNames,
            labelMethod: selectedRun.labelMethod,
            embeddingModel: selectedRun.embeddingModel,
            sourceRevision: selectedRun.sourceRevision,
            isLatest: true,
            isStale: themeAnalysisStale,
          }
        : null,
      availableRuns: topicRunsResult.runs.map((run, index) => ({
        jobId: run.jobId,
        generatedAt: run.createdAt,
        modelNames: run.modelNames,
        labelMethod: run.labelMethod,
        embeddingModel: run.embeddingModel,
        sourceRevision: run.sourceRevision,
        themeCount: run.topics.length,
        layerIds: getDelphiRunLayerIds(run),
        isLatest: index === 0,
      })),
      availableLayers: availableLayerIds.map((layerId) => ({
        layerId,
        granularity: themeLayerGranularity(layerId, availableLayerIds),
        themeCount:
          selectedRun?.topics.filter((topic) => topic.layerId === layerId)
            .length || 0,
        selected: layerSelection.layerIds.includes(layerId),
      })),
      filters: {
        layer: layerSelection.requested,
        selectedLayerIds: layerSelection.layerIds,
        includeGroupStats,
        includeStatements,
        includeInactive,
        highlightLimit,
      },
      coverage: {
        eligibleStatementCount,
        assignedStatementCount: assignedStatementIds.size,
        unassignedStatementCount: Math.max(
          0,
          eligibleStatementCount - assignedStatementIds.size
        ),
        assignmentCoverage: ratio(
          assignedStatementIds.size,
          eligibleStatementCount
        ),
      },
      responseSemantics:
        "Vote aggregates describe responses to statements assigned to a theme; they do not measure support for the theme label itself.",
      warnings,
      themes,
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_insights_themes");
  }
}

export async function handle_GET_external_insights_overview(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const conversation = await resolveOwnedExternalConversation(
      req,
      conversationId
    );
    const pca = await getPca(conversation.conversationNumericId);
    const [status, statements] = await Promise.all([
      loadExternalInsightStatus(conversation, pca),
      buildExternalStatementInsights(conversation, pca),
    ]);
    const groups = await buildExternalGroupInsights(
      conversation,
      pca,
      statements,
      false
    );

    res.status(200).json({
      ...status,
      highlightedStatements: {
        consensus: sortAndLimitStatements(statements, {
          sort: "consensus",
          limit: 5,
          minVotes: 0,
        }).map((statement) =>
          compactStatement(statement, statement.consensusScore)
        ),
        divisive: sortAndLimitStatements(statements, {
          sort: "divisive",
          limit: 5,
          minVotes: 0,
        }).map((statement) =>
          compactStatement(statement, statement.divisivenessScore)
        ),
        uncertain: sortAndLimitStatements(statements, {
          sort: "uncertainty",
          limit: 5,
          minVotes: 0,
        }).map((statement) =>
          compactStatement(statement, statement.uncertaintyScore)
        ),
      },
      groups,
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_insights_overview");
  }
}

export async function handle_POST_external_insights_refresh(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const conversation = await resolveOwnedExternalConversation(
      req,
      conversationId
    );
    const body = readObject(req.body || {}, "body");
    const mathUpdateType =
      readOptionalString(body, "mathUpdateType", 100, ["math_update_type"]) ||
      "update";

    const queued = await queueExternalMathRefresh(
      conversation.conversationNumericId,
      mathUpdateType,
      0
    );

    res.status(200).json({
      conversationId: conversation.conversationId,
      status: queued ? "queued" : "already_queued",
      mathUpdateType,
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_insights_refresh");
  }
}

export async function handle_POST_external_conversations(
  req: ExternalRequest,
  res: Response
) {
  try {
    const ownerUserId = req.p.external_api_owner_user_id || req.p.uid;
    if (!ownerUserId) {
      throw new ExternalApiError(401, "polis_err_external_api_auth");
    }

    const body = readObject(req.body || {}, "body");
    const topic = readRequiredString(body, "topic", 1000);
    const description = readRequiredString(body, "description", 50000);
    const conversationId = readOptionalString(body, "conversationId", 300, [
      "conversation_id",
    ]);

    if (conversationId && conversationId.length < 6) {
      throw new ExternalApiError(
        400,
        "polis_err_param_invalid_conversation_id"
      );
    }

    if (conversationId) {
      const existing = await pg.queryP_readOnly(
        "SELECT 1 FROM zinvites WHERE zinvite = ($1) LIMIT 1;",
        [conversationId]
      );
      if (Array.isArray(existing) && existing.length > 0) {
        throw new ExternalApiError(
          400,
          "polis_err_conversation_id_already_in_use"
        );
      }
    }

    const q = sql_conversations
      .insert({
        owner: ownerUserId,
        org_id: ownerUserId,
        topic,
        description,
        is_active: readOptionalBool(body, "isActive", true, ["is_active"]),
        is_data_open: readOptionalBool(body, "isDataOpen", false, [
          "is_data_open",
        ]),
        is_draft: readOptionalBool(body, "isDraft", false, ["is_draft"]),
        is_public: true,
        is_anon: false,
        profanity_filter: readOptionalBool(body, "profanityFilter", true, [
          "profanity_filter",
        ]),
        spam_filter: readOptionalBool(body, "spamFilter", true, [
          "spam_filter",
        ]),
        strict_moderation: readOptionalBool(body, "strictModeration", false, [
          "strict_moderation",
        ]),
        context: null,
        owner_sees_participation_stats: false,
        auth_needed_to_vote: DEFAULTS.auth_needed_to_vote,
        auth_needed_to_write: DEFAULTS.auth_needed_to_write,
        auth_opt_allow_3rdparty: DEFAULTS.auth_opt_allow_3rdparty,
        use_xid_whitelist: readOptionalBool(
          body,
          "useExternalParticipantIdAllowlist",
          false,
          ["useXidWhitelist", "use_xid_whitelist"]
        ),
        xid_required: readOptionalBool(
          body,
          "externalParticipantIdRequired",
          false,
          ["xidRequired", "xid_required"]
        ),
      })
      .returning("*")
      .toString();

    const rows = (await pg.queryP(q, [])) as Array<{ zid: number }>;
    const conversationNumericId = rows?.[0]?.zid;
    if (!conversationNumericId) {
      throw new ExternalApiError(500, "polis_err_add_conversation");
    }

    const publicConversationId = await registerExternalConversationId(
      conversationNumericId,
      conversationId
    );
    res.status(200).json({
      conversationId: publicConversationId,
      url: buildConversationUrl(req, publicConversationId),
    });
  } catch (err: any) {
    if (isDuplicateKey(err)) {
      sendExternalError(
        res,
        new ExternalApiError(400, "polis_err_conversation_id_already_in_use"),
        "polis_err_add_conversation"
      );
      return;
    }
    sendExternalError(res, err, "polis_err_add_conversation");
  }
}

export async function handle_POST_external_comments(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const body = readObject(req.body || {}, "body");
    const externalParticipantId = readRequiredString(
      body,
      "externalParticipantId",
      999,
      ["xid"]
    );
    const text = readRequiredString(body, "text", 997, ["txt"]);
    const vote =
      body.vote === undefined
        ? undefined
        : readRequiredIntInRange(body, "vote", -1, 1);

    const participant = await resolveExternalParticipant(
      req,
      conversationId,
      externalParticipantId
    );
    const capture = new CapturingResponse();
    const originalP = req.p;

    try {
      // handle_POST_comments expects the existing internal field names:
      // zid = conversationNumericId, uid = userId, pid = participantId,
      // xid = externalParticipantId, txt = text.
      req.p = {
        conversation_id: conversationId,
        xid: externalParticipantId,
        zid: participant.conversationNumericId,
        uid: participant.userId,
        pid: participant.participantId,
        txt: text,
        vote,
      };
      await handle_POST_comments(req, capture as any);
    } finally {
      req.p = originalP;
    }

    if (capture.statusCode >= 400) {
      res.status(capture.statusCode).json(capture.body);
      return;
    }

    const participantId = capture.body?.currentPid || participant.participantId;
    const mathRefreshQueued = await queueExternalMathRefreshBestEffort(
      participant.conversationNumericId,
      "external_comment"
    );
    const themeRefresh = await scheduleAutomaticDelphiAnalysisForStatementWrite(
      participant.conversationNumericId,
      {
        reason: "external_comment",
        touchExisting: true,
      }
    );

    res.status(200).json({
      conversationId,
      externalParticipantId,
      participantId,
      statementId: capture.body?.tid,
      mathRefreshQueued,
      themeRefresh,
      themeRefreshQueued: ["scheduling", "scheduled", "processing"].includes(
        themeRefresh.state
      ),
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_comment");
  }
}

export async function handle_PUT_external_comments(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const statementId = getPathStatementId(req);
    const body = readObject(req.body || {}, "body");
    const text = readRequiredString(body, "text", 997, ["txt"]);
    const conversation = await resolveOwnedExternalConversation(
      req,
      conversationId,
      true
    );

    const client = await pg.connect();
    let updatedComment: { txt: string; modified: number | string } | undefined;
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;

      const updated = await client.query<{
        txt: string;
        modified: number | string;
      }>(
        "UPDATE comments SET txt = $3, modified = now_as_millis() " +
          "WHERE zid = $1 AND tid = $2 RETURNING txt, modified;",
        [conversation.conversationNumericId, statementId, text]
      );

      if (updated.rows.length === 0) {
        throw new ExternalApiError(404, "polis_err_external_comment_not_found");
      }

      // Existing translations describe the previous text and must not survive
      // an edit.
      await client.query(
        "DELETE FROM comment_translations WHERE zid = $1 AND tid = $2;",
        [conversation.conversationNumericId, statementId]
      );

      updatedComment = updated.rows[0];
      await client.query("COMMIT");
      transactionOpen = false;
    } catch (err) {
      if (transactionOpen) {
        await client.query("ROLLBACK");
      }
      throw err;
    } finally {
      client.release();
    }

    await updateConversationModifiedTime(conversation.conversationNumericId);
    const mathRefreshQueued = await queueExternalMathRefreshBestEffort(
      conversation.conversationNumericId,
      "external_comment_edit"
    );
    const themeRefresh = await scheduleAutomaticDelphiAnalysisForStatementWrite(
      conversation.conversationNumericId,
      {
        reason: "external_comment_edit",
        touchExisting: true,
      }
    );

    res.status(200).json({
      conversationId,
      statementId,
      text: updatedComment?.txt || text,
      modified: toNullableTimestamp(updatedComment?.modified),
      mathRefreshQueued,
      themeRefresh,
      themeRefreshQueued: ["scheduling", "scheduled", "processing"].includes(
        themeRefresh.state
      ),
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      sendExternalError(
        res,
        new ExternalApiError(409, "polis_err_external_comment_duplicate"),
        "polis_err_external_comment_edit"
      );
      return;
    }
    sendExternalError(res, err, "polis_err_external_comment_edit");
  }
}

export async function handle_DELETE_external_comments(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const statementId = getPathStatementId(req);
    const conversation = await resolveOwnedExternalConversation(
      req,
      conversationId,
      true
    );

    const client = await pg.connect();
    let deletedVoteCount = 0;
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;

      const comment = await client.query(
        "SELECT 1 FROM comments WHERE zid = $1 AND tid = $2 FOR UPDATE;",
        [conversation.conversationNumericId, statementId]
      );
      if (comment.rows.length === 0) {
        throw new ExternalApiError(404, "polis_err_external_comment_not_found");
      }

      const affectedParticipants = await client.query<{ pid: number }>(
        "SELECT DISTINCT pid FROM votes WHERE zid = $1 AND tid = $2;",
        [conversation.conversationNumericId, statementId]
      );
      const affectedParticipantIds = affectedParticipants.rows.map((row) =>
        Number(row.pid)
      );

      await client.query(
        "DELETE FROM votes_latest_unique WHERE zid = $1 AND tid = $2;",
        [conversation.conversationNumericId, statementId]
      );
      const deletedVotes = await client.query(
        "DELETE FROM votes WHERE zid = $1 AND tid = $2 RETURNING pid;",
        [conversation.conversationNumericId, statementId]
      );
      deletedVoteCount = deletedVotes.rows.length;

      for (const table of [
        "comment_translations",
        "crowd_mod",
        "stars",
        "trashes",
        "report_comment_selections",
      ]) {
        await client.query(
          `DELETE FROM ${table} WHERE zid = $1 AND tid = $2;`,
          [conversation.conversationNumericId, statementId]
        );
      }

      await client.query("DELETE FROM comments WHERE zid = $1 AND tid = $2;", [
        conversation.conversationNumericId,
        statementId,
      ]);

      if (affectedParticipantIds.length > 0) {
        await client.query(
          "UPDATE participants AS participant SET vote_count = (" +
            "SELECT COUNT(*) FROM votes " +
            "WHERE votes.zid = participant.zid AND votes.pid = participant.pid" +
            ") WHERE participant.zid = $1 " +
            "AND participant.pid = ANY($2::int[]);",
          [conversation.conversationNumericId, affectedParticipantIds]
        );
      }

      await client.query("COMMIT");
      transactionOpen = false;
    } catch (err) {
      if (transactionOpen) {
        await client.query("ROLLBACK");
      }
      throw err;
    } finally {
      client.release();
    }

    await updateConversationModifiedTime(conversation.conversationNumericId);
    const mathRefreshQueued = await queueExternalMathRefreshBestEffort(
      conversation.conversationNumericId,
      "external_comment_delete"
    );
    const themeRefresh = await scheduleAutomaticDelphiAnalysisForStatementWrite(
      conversation.conversationNumericId,
      {
        reason: "external_comment_delete",
        touchExisting: true,
      }
    );

    res.status(200).json({
      conversationId,
      statementId,
      deleted: true,
      deletedVoteCount,
      mathRefreshQueued,
      themeRefresh,
      themeRefreshQueued: ["scheduling", "scheduled", "processing"].includes(
        themeRefresh.state
      ),
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_comment_delete");
  }
}

function parseExternalVoteInput(raw: any): ExternalVoteInput {
  const body = readObject(raw, "vote");
  return {
    externalParticipantId: readRequiredString(
      body,
      "externalParticipantId",
      999,
      ["xid"]
    ),
    statementId: readRequiredIntInRange(body, "statementId", 0, 2147483647, [
      "tid",
    ]),
    vote: readRequiredIntInRange(body, "vote", -1, 1),
    highPriority: readOptionalBoolValue(body, "highPriority", [
      "high_priority",
    ]),
    starred: readOptionalBoolValue(body, "starred"),
  };
}

async function recordExternalVote(
  req: ExternalRequest,
  conversationId: string,
  input: ExternalVoteInput,
  participantCache?: Map<string, Promise<ExternalParticipant>>
): Promise<ExternalVoteResult> {
  try {
    const participant = await resolveExternalParticipant(
      req,
      conversationId,
      input.externalParticipantId,
      participantCache
    );
    const voteResult = await votesPost(
      participant.userId,
      participant.participantId,
      participant.conversationNumericId,
      input.statementId,
      input.vote,
      0,
      input.highPriority || false
    );
    const createdTimeMillis = safeTimestampToMillis(voteResult.vote.created);

    if (input.starred !== undefined) {
      await addStar(
        participant.conversationNumericId,
        input.statementId,
        participant.participantId,
        input.starred ? 1 : 0,
        createdTimeMillis
      );
    }

    setTimeout(() => {
      updateConversationModifiedTime(
        participant.conversationNumericId,
        createdTimeMillis
      );
      updateLastInteractionTimeForConversation(
        participant.conversationNumericId,
        participant.userId
      );
      updateVoteCount(
        participant.conversationNumericId,
        participant.participantId
      );
    }, 100);

    const mathRefreshQueued = await queueExternalMathRefreshBestEffort(
      participant.conversationNumericId,
      "external_vote"
    );

    return {
      externalParticipantId: input.externalParticipantId,
      participantId: participant.participantId,
      statementId: input.statementId,
      vote: input.vote,
      mathRefreshQueued,
    };
  } catch (err) {
    throw mapVoteError(err);
  }
}

export async function handle_POST_external_votes(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const input = parseExternalVoteInput(req.body || {});
    const result = await recordExternalVote(req, conversationId, input);

    res.status(200).json({
      conversationId,
      ...result,
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_vote");
  }
}

export async function handle_POST_external_votes_batch(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const body = readObject(req.body || {}, "body");
    const votes = body.votes;

    if (!Array.isArray(votes) || votes.length === 0) {
      throw new ExternalApiError(400, "polis_err_param_invalid_votes");
    }
    if (votes.length > 500) {
      throw new ExternalApiError(
        400,
        "polis_err_external_votes_batch_too_large"
      );
    }

    const participantCache = new Map<string, Promise<ExternalParticipant>>();
    const results = [];
    let mathRefreshQueued = false;

    for (const rawVote of votes) {
      const externalParticipantId =
        rawVote && typeof rawVote === "object"
          ? String(rawVote.externalParticipantId || rawVote.xid || "")
          : "";
      const statementId =
        rawVote && typeof rawVote === "object"
          ? Number(rawVote.statementId ?? rawVote.tid)
          : undefined;

      try {
        const input = parseExternalVoteInput(rawVote);
        const result = await recordExternalVote(
          req,
          conversationId,
          input,
          participantCache
        );
        mathRefreshQueued = mathRefreshQueued || result.mathRefreshQueued;
        results.push({
          status: "success",
          externalParticipantId: result.externalParticipantId,
          statementId: result.statementId,
          participantId: result.participantId,
        });
      } catch (err: any) {
        const mapped =
          err instanceof ExternalApiError
            ? err
            : new ExternalApiError(500, String(err));
        results.push({
          status: "error",
          externalParticipantId,
          statementId,
          error: mapped.publicError,
        });
      }
    }

    res.status(200).json({
      conversationId,
      mathRefreshQueued,
      results,
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_votes_batch");
  }
}

export async function handle_POST_external_upvotes(
  req: ExternalRequest,
  res: Response
) {
  try {
    const conversationId = getPathConversationId(req);
    const body = readObject(req.body || {}, "body");
    const externalParticipantId = readRequiredString(
      body,
      "externalParticipantId",
      999,
      ["xid"]
    );
    const participant = await resolveExternalParticipant(
      req,
      conversationId,
      externalParticipantId
    );

    let duplicate = false;
    const existing = await pg.queryP(
      "SELECT 1 FROM upvotes WHERE uid = ($1) AND zid = ($2) LIMIT 1;",
      [participant.userId, participant.conversationNumericId]
    );

    if (Array.isArray(existing) && existing.length > 0) {
      duplicate = true;
    } else {
      try {
        await pg.queryP("INSERT INTO upvotes (uid, zid) VALUES ($1, $2);", [
          participant.userId,
          participant.conversationNumericId,
        ]);
      } catch (err: any) {
        if (isDuplicateKey(err)) {
          duplicate = true;
        } else {
          throw err;
        }
      }
    }

    await pg.queryP(
      "UPDATE conversations SET upvotes = (SELECT count(*) FROM upvotes WHERE zid = ($1)) WHERE zid = ($1);",
      [participant.conversationNumericId]
    );

    res.status(200).json({
      conversationId,
      externalParticipantId,
      upvoted: true,
      ...(duplicate ? { duplicate: true } : {}),
    });
  } catch (err) {
    sendExternalError(res, err, "polis_err_external_upvote");
  }
}
