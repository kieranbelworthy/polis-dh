import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Agent } from "supertest";

import { newAgent } from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import {
  cleanupDelphiJobs,
  cleanupDelphiTopicData,
  createDelphiTopicCluster,
  docClient,
  ensureJobQueueTableExists,
} from "../setup/dynamodb-test-helpers";

const EXTERNAL_API_KEY = "test-external-api-key";

describe("External Management API", () => {
  let agent: Agent;
  let ownerUserId: number;
  const delphiConversationIds: number[] = [];

  beforeAll(async () => {
    process.env.EXTERNAL_API_KEY = EXTERNAL_API_KEY;

    const owner = await pool.query(
      "INSERT INTO users (hname) VALUES ($1) RETURNING uid;",
      ["External Owner"]
    );
    ownerUserId = Number(owner.rows[0].uid);
    process.env.EXTERNAL_API_OWNER_USER_ID = String(ownerUserId);

    await ensureJobQueueTableExists();
    agent = await newAgent();
  });

  afterAll(async () => {
    for (const zid of delphiConversationIds) {
      await cleanupDelphiTopicData(zid);
      await cleanupDelphiJobs(String(zid));
    }
  });

  function externalPost(path: string) {
    return agent.post(path).set("Authorization", `Bearer ${EXTERNAL_API_KEY}`);
  }

  function externalGet(path: string) {
    return agent.get(path).set("Authorization", `Bearer ${EXTERNAL_API_KEY}`);
  }

  async function createExternalConversation(options: Record<string, any> = {}) {
    const response = await externalPost("/api/v3/external/conversations").send({
      topic: `External API conversation ${Date.now()}`,
      description: "Created by external API integration tests",
      isActive: true,
      isDraft: false,
      strictModeration: false,
      profanityFilter: false,
      spamFilter: false,
      ...options,
    });

    expect(response.status).toBe(200);
    expect(response.body.conversationId).toBeTruthy();
    expect(response.body.url).toContain(response.body.conversationId);

    return response.body.conversationId as string;
  }

  async function createExternalComment(
    conversationId: string,
    externalParticipantId: string,
    txt = `External comment ${Date.now()}`,
    vote?: number
  ) {
    const payload: Record<string, any> = {
      externalParticipantId,
      text: txt,
    };
    if (vote !== undefined) {
      payload.vote = vote;
    }

    const response = await externalPost(
      `/api/v3/external/conversations/${conversationId}/comments`
    ).send(payload);

    expect(response.status).toBe(200);
    expect(response.body.conversationId).toBe(conversationId);
    expect(response.body.externalParticipantId).toBe(externalParticipantId);
    expect(response.body.participantId).toBeGreaterThanOrEqual(0);
    expect(response.body.statementId).toBeGreaterThan(0);

    return response.body as {
      conversationId: string;
      externalParticipantId: string;
      participantId: number;
      statementId: number;
      mathRefreshQueued: boolean;
      themeRefreshQueued: boolean;
      themeRefresh: {
        jobId: string;
        state: string;
        notBefore: string | null;
        rerunRequested: boolean;
      };
    };
  }

  async function getConversationNumericId(
    conversationId: string
  ): Promise<number> {
    const result = await pool.query(
      "SELECT zid FROM zinvites WHERE zinvite = $1;",
      [conversationId]
    );
    expect(result.rows.length).toBe(1);
    return Number(result.rows[0].zid);
  }

  async function getMathRefreshTaskCount(
    conversationNumericId: number
  ): Promise<number> {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM worker_tasks WHERE task_type = 'update_math' AND task_bucket = $1;",
      [conversationNumericId]
    );
    return Number(result.rows[0].count);
  }

  test("rejects missing and invalid API keys", async () => {
    const missing = await agent.post("/api/v3/external/conversations").send({
      topic: "Missing auth",
      description: "Missing auth",
    });

    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe("polis_err_external_api_auth");

    const invalid = await agent
      .post("/api/v3/external/conversations")
      .set("Authorization", "Bearer wrong-key")
      .send({
        topic: "Invalid auth",
        description: "Invalid auth",
      });

    expect(invalid.status).toBe(401);
    expect(invalid.body.error).toBe("polis_err_external_api_auth");
  });

  test("creates conversations owned by EXTERNAL_API_OWNER_USER_ID", async () => {
    const conversationId = await createExternalConversation();
    const conversationNumericId = await getConversationNumericId(
      conversationId
    );
    const conversation = await pool.query(
      "SELECT owner FROM conversations WHERE zid = $1;",
      [conversationNumericId]
    );

    expect(Number(conversation.rows[0].owner)).toBe(ownerUserId);
  });

  test("creates external participant ID-backed comments", async () => {
    const conversationId = await createExternalConversation();
    const comment = await createExternalComment(
      conversationId,
      `comment-external-participant-${Date.now()}`
    );
    const conversationNumericId = await getConversationNumericId(
      conversationId
    );

    const participant = await pool.query(
      "SELECT uid FROM participants WHERE zid = $1 AND pid = $2;",
      [conversationNumericId, comment.participantId]
    );
    expect(participant.rows.length).toBe(1);

    const externalParticipant = await pool.query(
      "SELECT uid FROM xids WHERE owner = $1 AND xid = $2;",
      [ownerUserId, comment.externalParticipantId]
    );
    expect(externalParticipant.rows.length).toBe(1);
    expect(Number(externalParticipant.rows[0].uid)).toBe(
      Number(participant.rows[0].uid)
    );
    expect(comment).toMatchObject({ mathRefreshQueued: true });
    expect(await getMathRefreshTaskCount(conversationNumericId)).toBe(1);
  });

  test("self-manages debounced theme refreshes and coalesces mid-run changes", async () => {
    const conversationId = await createExternalConversation();
    const comments = [];
    for (let index = 0; index < 5; index += 1) {
      comments.push(
        await createExternalComment(
          conversationId,
          `auto-theme-author-${index}-${Date.now()}`,
          `Automatic theme statement ${index} ${Date.now()}`
        )
      );
    }

    expect(comments[0].themeRefresh.state).toBe("waiting_for_statements");
    expect(comments[3].themeRefresh.state).toBe("waiting_for_statements");
    expect(comments[4].themeRefresh).toMatchObject({
      state: "scheduled",
      rerunRequested: false,
    });
    expect(comments[4].themeRefreshQueued).toBe(true);

    const zid = await getConversationNumericId(conversationId);
    delphiConversationIds.push(zid);
    const jobId = `auto-theme-refresh-${zid}`;
    const scheduled = await docClient.send(
      new GetCommand({
        TableName: "Delphi_JobQueue",
        Key: { job_id: jobId },
        ConsistentRead: true,
      })
    );
    expect(scheduled.Item).toMatchObject({
      job_id: jobId,
      status: "PENDING",
      conversation_id: String(zid),
      auto_managed: true,
      refresh_kind: "themes",
    });
    expect(new Date(scheduled.Item?.not_before).getTime()).toBeGreaterThan(
      Date.now()
    );
    expect(JSON.parse(scheduled.Item?.job_config)).toMatchObject({
      generate_visualizations: false,
    });

    await docClient.send(
      new UpdateCommand({
        TableName: "Delphi_JobQueue",
        Key: { job_id: jobId },
        UpdateExpression:
          "SET #status = :processing, #version = #version + :one, started_at = :now REMOVE not_before, dirty_since",
        ExpressionAttributeNames: {
          "#status": "status",
          "#version": "version",
        },
        ExpressionAttributeValues: {
          ":processing": "PROCESSING",
          ":one": 1,
          ":now": new Date().toISOString(),
        },
      })
    );

    const duringRun = await createExternalComment(
      conversationId,
      `auto-theme-mid-run-${Date.now()}`,
      `Statement arriving during analysis ${Date.now()}`
    );
    expect(duringRun.themeRefresh).toMatchObject({
      state: "processing",
      rerunRequested: true,
    });

    const processing = await docClient.send(
      new GetCommand({
        TableName: "Delphi_JobQueue",
        Key: { job_id: jobId },
        ConsistentRead: true,
      })
    );
    expect(processing.Item).toMatchObject({
      status: "PROCESSING",
      rerun_requested: true,
    });
    expect(
      new Date(processing.Item?.next_not_before).getTime()
    ).toBeGreaterThan(Date.now());
  });

  test("records and changes latest votes by external participant ID", async () => {
    const conversationId = await createExternalConversation();
    const comment = await createExternalComment(
      conversationId,
      `statement-author-${Date.now()}`
    );
    const voterExternalParticipantId = `voter-${Date.now()}`;

    const firstVote = await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes`
    ).send({
      externalParticipantId: voterExternalParticipantId,
      statementId: comment.statementId,
      vote: -1,
    });

    expect(firstVote.status).toBe(200);
    expect(firstVote.body.vote).toBe(-1);
    expect(firstVote.body.participantId).toBeGreaterThanOrEqual(0);
    expect(typeof firstVote.body.mathRefreshQueued).toBe("boolean");

    const changedVote = await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes`
    ).send({
      externalParticipantId: voterExternalParticipantId,
      statementId: comment.statementId,
      vote: 1,
    });

    expect(changedVote.status).toBe(200);
    expect(changedVote.body.vote).toBe(1);
    expect(changedVote.body.participantId).toBe(firstVote.body.participantId);

    const conversationNumericId = await getConversationNumericId(
      conversationId
    );
    const latest = await pool.query(
      "SELECT vote FROM votes_latest_unique WHERE zid = $1 AND pid = $2 AND tid = $3;",
      [conversationNumericId, firstVote.body.participantId, comment.statementId]
    );

    expect(latest.rows.length).toBe(1);
    expect(Number(latest.rows[0].vote)).toBe(1);
  });

  test("returns mixed success and error results for vote batches", async () => {
    const conversationId = await createExternalConversation();
    const comment = await createExternalComment(
      conversationId,
      `batch-statement-author-${Date.now()}`
    );

    const response = await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes/batch`
    ).send({
      votes: [
        {
          externalParticipantId: `batch-voter-${Date.now()}`,
          statementId: comment.statementId,
          vote: -1,
        },
        {
          externalParticipantId: `batch-invalid-${Date.now()}`,
          statementId: comment.statementId,
          vote: 2,
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(2);
    expect(response.body.results[0].status).toBe("success");
    expect(response.body.results[0].participantId).toBeGreaterThanOrEqual(0);
    expect(response.body.results[1].status).toBe("error");
    expect(response.body.results[1].error).toBe("polis_err_param_invalid_vote");
  });

  test("returns external insight status and statement vote summaries", async () => {
    const conversationId = await createExternalConversation();
    const comment = await createExternalComment(
      conversationId,
      `insight-author-${Date.now()}`,
      `Insight statement ${Date.now()}`
    );

    await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes`
    ).send({
      externalParticipantId: `insight-agree-voter-${Date.now()}`,
      statementId: comment.statementId,
      vote: -1,
    });
    await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes`
    ).send({
      externalParticipantId: `insight-disagree-voter-${Date.now()}`,
      statementId: comment.statementId,
      vote: 1,
    });

    const status = await externalGet(
      `/api/v3/external/conversations/${conversationId}/insights/status`
    );

    expect(status.status).toBe(200);
    expect(status.body.conversationId).toBe(conversationId);
    expect(status.body.statementCount).toBe(1);
    expect(status.body.voteCount).toBe(2);
    expect(status.body.participantCount).toBeGreaterThanOrEqual(3);
    expect(status.body.mathReady).toBe(false);

    const statements = await externalGet(
      `/api/v3/external/conversations/${conversationId}/insights/statements?sort=votes`
    );

    expect(statements.status).toBe(200);
    expect(statements.body.conversationId).toBe(conversationId);
    expect(statements.body.statements).toHaveLength(1);
    expect(statements.body.statements[0]).toMatchObject({
      statementId: comment.statementId,
      authorExternalParticipantId: comment.externalParticipantId,
      voteCount: 2,
      agreeCount: 1,
      disagreeCount: 1,
      passCount: 0,
      divisivenessScore: 0.5,
      majority: "split",
    });
  });

  test("returns group insight shape before math has run", async () => {
    const conversationId = await createExternalConversation();
    await createExternalComment(
      conversationId,
      `group-author-${Date.now()}`,
      `Group insight statement ${Date.now()}`
    );

    const response = await externalGet(
      `/api/v3/external/conversations/${conversationId}/insights/groups?includeParticipants=false`
    );

    expect(response.status).toBe(200);
    expect(response.body.conversationId).toBe(conversationId);
    expect(response.body.mathReady).toBe(false);
    expect(response.body.groups).toEqual([]);
  });

  test("returns a dashboard-ready empty theme response before Delphi has run", async () => {
    const conversationId = await createExternalConversation();

    const response = await externalGet(
      `/api/v3/external/conversations/${conversationId}/insights/themes`
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId,
      themeAnalysisReady: false,
      themeAnalysisStale: null,
      themeStatsReady: false,
      analysisLifecycle: {
        state: "waiting_for_statements",
        minimumStatementCount: 5,
      },
      readiness: {
        themes: false,
        assignments: false,
        math: false,
      },
      analysis: null,
      availableRuns: [],
      availableLayers: [],
      themes: [],
    });
    expect(
      response.body.warnings.some((warning: string) =>
        ["theme_analysis_not_run", "delphi_topic_store_unavailable"].includes(
          warning
        )
      )
    ).toBe(true);
  });

  test("returns themes with response, reach, metrics, and supporting statements", async () => {
    const conversationId = await createExternalConversation();
    const firstComment = await createExternalComment(
      conversationId,
      `theme-author-a-${Date.now()}`,
      "Night buses should run every thirty minutes."
    );
    const secondComment = await createExternalComment(
      conversationId,
      `theme-author-b-${Date.now()}`,
      "Bus reliability should be published each month."
    );
    const agreeVoter = `theme-agree-voter-${Date.now()}`;
    const mixedVoter = `theme-mixed-voter-${Date.now()}`;

    await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes`
    ).send({
      externalParticipantId: agreeVoter,
      statementId: firstComment.statementId,
      vote: -1,
    });
    await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes`
    ).send({
      externalParticipantId: agreeVoter,
      statementId: secondComment.statementId,
      vote: -1,
    });
    await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes`
    ).send({
      externalParticipantId: mixedVoter,
      statementId: firstComment.statementId,
      vote: 1,
    });
    await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes`
    ).send({
      externalParticipantId: mixedVoter,
      statementId: secondComment.statementId,
      vote: 0,
    });

    const zid = await getConversationNumericId(conversationId);
    delphiConversationIds.push(zid);
    const jobId = `external-theme-job-${Date.now()}`;
    const topicKey = `${jobId}#0#1`;
    await createDelphiTopicCluster(
      zid,
      topicKey,
      [firstComment.statementId, secondComment.statementId],
      0,
      1
    );

    const response = await externalGet(
      `/api/v3/external/conversations/${conversationId}/insights/themes` +
        "?includeStatements=true&includeGroupStats=false"
    );

    expect(response.status).toBe(200);
    expect(response.body.themeAnalysisReady).toBe(true);
    expect(response.body.themeAnalysisStale).toBe(false);
    expect(response.body.themeStatsReady).toBe(true);
    expect(response.body.analysis).toMatchObject({
      jobId,
      modelNames: ["test-model"],
      isLatest: true,
    });
    expect(response.body.availableLayers).toEqual([
      {
        layerId: 0,
        granularity: "only",
        themeCount: 1,
        selected: true,
      },
    ]);
    expect(response.body.coverage).toEqual({
      eligibleStatementCount: 2,
      assignedStatementCount: 2,
      unassignedStatementCount: 0,
      assignmentCoverage: 1,
    });
    expect(response.body.themes).toHaveLength(1);

    const theme = response.body.themes[0];
    expect(theme).toMatchObject({
      themeId: topicKey,
      name: `Test Topic ${topicKey}`,
      layerId: 0,
      clusterId: 1,
      granularity: "only",
      statementCount: 2,
      respondedStatementCount: 2,
      statementIds: [firstComment.statementId, secondComment.statementId],
      response: {
        voteCount: 4,
        agreeCount: 2,
        disagreeCount: 1,
        passCount: 1,
        agreement: 0.5,
        disagreement: 0.25,
        pass: 0.25,
        respondentCount: 2,
        respondentCoverage: 0.5,
        averageStatementsVotedPerRespondent: 2,
      },
      metrics: {
        meanStatementConsensus: 0.5,
        meanStatementDivisiveness: 0.25,
        meanStatementUncertainty: 0.25,
        meanGroupAwareConsensus: null,
        meanAssignmentConfidence: 0.9,
        meanDistanceToCentroid: 0.5,
      },
    });
    expect(theme).not.toHaveProperty("groupStats");
    expect(theme.representativeStatements).toHaveLength(2);
    expect(theme.representativeStatements[0]).toMatchObject({
      confidence: 0.9,
      distanceToCentroid: 0.5,
    });
    expect(theme.highlights.topAgreeStatements).toHaveLength(2);
    expect(theme.highlights.topDisagreeStatements).toHaveLength(2);
    expect(theme.highlights.mostDivisiveStatements).toHaveLength(2);
    expect(theme.statements).toHaveLength(2);
    expect(theme.statements[0]).not.toHaveProperty("groupStats");
  });

  test("validates theme layer selection", async () => {
    const conversationId = await createExternalConversation();
    const response = await externalGet(
      `/api/v3/external/conversations/${conversationId}/insights/themes?layer=sideways`
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("polis_err_param_invalid_layer");
  });

  test("queues a math refresh task for external insights", async () => {
    const conversationId = await createExternalConversation();
    const conversationNumericId = await getConversationNumericId(
      conversationId
    );

    const response = await externalPost(
      `/api/v3/external/conversations/${conversationId}/insights/refresh`
    ).send({ mathUpdateType: "update" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      conversationId,
      status: "queued",
      mathUpdateType: "update",
    });

    const tasks = await pool.query(
      "SELECT task_type, task_data, task_bucket FROM worker_tasks WHERE task_type = 'update_math' AND task_bucket = $1 ORDER BY created DESC LIMIT 1;",
      [conversationNumericId]
    );

    expect(tasks.rows.length).toBe(1);
    expect(tasks.rows[0].task_data).toMatchObject({
      zid: conversationNumericId,
      math_update_type: "update",
    });
  });

  test("upvotes are idempotency-safe for repeated external participant IDs", async () => {
    const conversationId = await createExternalConversation();
    const externalParticipantId = `upvote-external-participant-${Date.now()}`;

    const first = await externalPost(
      `/api/v3/external/conversations/${conversationId}/upvotes`
    ).send({ externalParticipantId });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      conversationId,
      externalParticipantId,
      upvoted: true,
    });

    const second = await externalPost(
      `/api/v3/external/conversations/${conversationId}/upvotes`
    ).send({ externalParticipantId });

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      conversationId,
      externalParticipantId,
      upvoted: true,
      duplicate: true,
    });
  });

  test("respects external participant ID-required and allowlist settings", async () => {
    const conversationId = await createExternalConversation({
      useExternalParticipantIdAllowlist: true,
      externalParticipantIdRequired: true,
    });

    const missingExternalParticipantId = await externalPost(
      `/api/v3/external/conversations/${conversationId}/comments`
    ).send({ text: "Missing externalParticipantId should be rejected" });

    expect(missingExternalParticipantId.status).toBe(400);
    expect(missingExternalParticipantId.body.error).toBe(
      "polis_err_param_missing_externalParticipantId"
    );

    const blocked = await externalPost(
      `/api/v3/external/conversations/${conversationId}/comments`
    ).send({
      externalParticipantId: `blocked-external-participant-${Date.now()}`,
      text: "Blocked external participant ID should be rejected",
    });

    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe(
      "polis_err_external_participant_id_not_allowed"
    );

    const conversationNumericId = await getConversationNumericId(
      conversationId
    );
    const allowedExternalParticipantId = `allowed-external-participant-${Date.now()}`;
    await pool.query(
      "INSERT INTO xid_whitelist (owner, xid, zid) VALUES ($1, $2, $3) ON CONFLICT (owner, xid) DO UPDATE SET zid = EXCLUDED.zid;",
      [ownerUserId, allowedExternalParticipantId, conversationNumericId]
    );

    const allowed = await externalPost(
      `/api/v3/external/conversations/${conversationId}/comments`
    ).send({
      externalParticipantId: allowedExternalParticipantId,
      text: "Allowed external participant ID should create a comment",
    });

    expect(allowed.status).toBe(200);
    expect(allowed.body.externalParticipantId).toBe(
      allowedExternalParticipantId
    );
    expect(allowed.body.statementId).toBeGreaterThan(0);
  });
});
