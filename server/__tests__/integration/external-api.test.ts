import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "supertest";

import { newAgent } from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";

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

    await pool.query(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../postgres/migrations/000020_create_delphi_theme_analysis.sql"
        ),
        "utf8"
      )
    );
    agent = await newAgent();
  });

  afterAll(async () => {
    for (const zid of delphiConversationIds) {
      await pool.query("DELETE FROM delphi_theme_runs WHERE zid = $1", [zid]);
      await pool.query("DELETE FROM delphi_theme_jobs WHERE zid = $1", [zid]);
    }
  });

  function externalPost(path: string) {
    return agent.post(path).set("Authorization", `Bearer ${EXTERNAL_API_KEY}`);
  }

  function externalGet(path: string) {
    return agent.get(path).set("Authorization", `Bearer ${EXTERNAL_API_KEY}`);
  }

  function externalPut(path: string) {
    return agent.put(path).set("Authorization", `Bearer ${EXTERNAL_API_KEY}`);
  }

  function externalDelete(path: string) {
    return agent
      .delete(path)
      .set("Authorization", `Bearer ${EXTERNAL_API_KEY}`);
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

  async function createDelphiTopicCluster(
    zid: number,
    topicKey: string,
    tids: number[],
    layerId = 0,
    clusterId = 1
  ): Promise<void> {
    const [jobId] = topicKey.split("#");
    const job = await pool.query(
      "SELECT source_revision FROM delphi_theme_jobs WHERE zid = $1",
      [zid]
    );
    const sourceRevision = Number(job.rows[0]?.source_revision || 1);
    await pool.query(
      "INSERT INTO delphi_theme_runs " +
        "(run_id, zid, source_revision, embedding_model, label_method) " +
        "VALUES ($1, $2, $3, 'test-embedding-model', 'tfidf-keywords-v1')",
      [jobId, zid, sourceRevision]
    );
    await pool.query(
      "INSERT INTO delphi_themes " +
        "(run_id, layer_id, cluster_id, topic_name, model_name) " +
        "VALUES ($1, $2, $3, $4, 'test-model')",
      [jobId, layerId, clusterId, `Test Topic ${topicKey}`]
    );
    for (const tid of tids) {
      await pool.query(
        "INSERT INTO delphi_theme_assignments " +
          "(run_id, tid, layer_id, cluster_id, confidence, distance_to_centroid) " +
          "VALUES ($1, $2, $3, $4, 0.9, 0.5)",
        [jobId, tid, layerId, clusterId]
      );
    }
    await pool.query(
      "UPDATE delphi_theme_jobs SET completed_revision = source_revision, " +
        "status = 'completed', completed_at = NOW() WHERE zid = $1",
      [zid]
    );
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

  test("edits comments without removing their votes", async () => {
    const conversationId = await createExternalConversation();
    const comment = await createExternalComment(
      conversationId,
      `edit-author-${Date.now()}`,
      `Original external comment ${Date.now()}`
    );
    const voterExternalParticipantId = `edit-voter-${Date.now()}`;
    const vote = await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes`
    ).send({
      externalParticipantId: voterExternalParticipantId,
      statementId: comment.statementId,
      vote: -1,
    });
    expect(vote.status).toBe(200);

    const editedText = `Edited external comment ${Date.now()}`;
    const response = await externalPut(
      `/api/v3/external/conversations/${conversationId}/comments/${comment.statementId}`
    ).send({ text: editedText });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId,
      statementId: comment.statementId,
      text: editedText,
    });
    expect(typeof response.body.mathRefreshQueued).toBe("boolean");

    const conversationNumericId = await getConversationNumericId(
      conversationId
    );
    const storedComment = await pool.query(
      "SELECT txt FROM comments WHERE zid = $1 AND tid = $2;",
      [conversationNumericId, comment.statementId]
    );
    expect(storedComment.rows).toHaveLength(1);
    expect(storedComment.rows[0].txt).toBe(editedText);

    const storedVotes = await pool.query(
      "SELECT vote FROM votes WHERE zid = $1 AND tid = $2;",
      [conversationNumericId, comment.statementId]
    );
    expect(storedVotes.rows).toHaveLength(1);
    expect(Number(storedVotes.rows[0].vote)).toBe(-1);
  });

  test("deletes comments and all of their votes", async () => {
    const conversationId = await createExternalConversation();
    const comment = await createExternalComment(
      conversationId,
      `delete-author-${Date.now()}`
    );

    for (let index = 0; index < 2; index += 1) {
      const vote = await externalPost(
        `/api/v3/external/conversations/${conversationId}/votes`
      ).send({
        externalParticipantId: `delete-voter-${index}-${Date.now()}`,
        statementId: comment.statementId,
        vote: index === 0 ? -1 : 1,
      });
      expect(vote.status).toBe(200);
    }

    const response = await externalDelete(
      `/api/v3/external/conversations/${conversationId}/comments/${comment.statementId}`
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId,
      statementId: comment.statementId,
      deleted: true,
      deletedVoteCount: 2,
    });
    expect(typeof response.body.mathRefreshQueued).toBe("boolean");

    const conversationNumericId = await getConversationNumericId(
      conversationId
    );
    for (const table of ["comments", "votes", "votes_latest_unique"]) {
      const storedRows = await pool.query(
        `SELECT 1 FROM ${table} WHERE zid = $1 AND tid = $2;`,
        [conversationNumericId, comment.statementId]
      );
      expect(storedRows.rows).toHaveLength(0);
    }
  });

  test("returns not found when editing or deleting an unknown comment", async () => {
    const conversationId = await createExternalConversation();
    const path = `/api/v3/external/conversations/${conversationId}/comments/2147483647`;

    const edit = await externalPut(path).send({ text: "Missing comment" });
    expect(edit.status).toBe(404);
    expect(edit.body.error).toBe("polis_err_external_comment_not_found");

    const deletion = await externalDelete(path);
    expect(deletion.status).toBe(404);
    expect(deletion.body.error).toBe("polis_err_external_comment_not_found");
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
    const scheduled = await pool.query(
      "SELECT * FROM delphi_theme_jobs WHERE zid = $1",
      [zid]
    );
    expect(scheduled.rows[0]).toMatchObject({
      zid,
      status: "pending",
    });
    expect(new Date(scheduled.rows[0].not_before).getTime()).toBeGreaterThan(
      Date.now()
    );
    expect(Number(scheduled.rows[0].source_revision)).toBe(5);
    expect(Number(scheduled.rows[0].completed_revision)).toBe(0);

    await pool.query(
      "UPDATE delphi_theme_jobs SET status = 'processing', " +
        "processing_revision = source_revision, started_at = NOW(), " +
        "lease_owner = 'test-worker', lease_expires_at = NOW() + INTERVAL '10 minutes' " +
        "WHERE zid = $1",
      [zid]
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

    const processing = await pool.query(
      "SELECT * FROM delphi_theme_jobs WHERE zid = $1",
      [zid]
    );
    expect(processing.rows[0].status).toBe("processing");
    expect(Number(processing.rows[0].source_revision)).toBe(6);
    expect(Number(processing.rows[0].processing_revision)).toBe(5);

    const voteResponse = await externalPost(
      `/api/v3/external/conversations/${conversationId}/votes`
    ).send({
      externalParticipantId: `auto-theme-voter-${Date.now()}`,
      statementId: comments[0].statementId,
      vote: -1,
    });
    expect(voteResponse.status).toBe(200);
    const afterVote = await pool.query(
      "SELECT source_revision FROM delphi_theme_jobs WHERE zid = $1",
      [zid]
    );
    expect(Number(afterVote.rows[0].source_revision)).toBe(6);
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

  test("looks up only the requested participant's current group membership", async () => {
    const conversationId = await createExternalConversation();
    const assigned = await createExternalComment(
      conversationId,
      `membership-assigned-${Date.now()}`
    );
    const unassigned = await createExternalComment(
      conversationId,
      `membership-unassigned-${Date.now()}`
    );
    const zid = await getConversationNumericId(conversationId);

    await pool.query(
      "INSERT INTO math_main " +
        "(zid, math_env, data, last_vote_timestamp, caching_tick, math_tick) " +
        "VALUES ($1, $2, $3::jsonb, 0, 0, 17);",
      [
        zid,
        process.env.MATH_ENV || "prod",
        JSON.stringify({
          math_tick: 17,
          "group-clusters": [{ id: 4, center: [0, 0], members: [0] }],
          "base-clusters": {
            id: [0],
            x: [0],
            y: [0],
            count: [1],
            members: [[assigned.participantId]],
          },
        }),
      ]
    );

    const assignedResponse = await externalPost(
      `/api/v3/external/conversations/${conversationId}/insights/group-membership`
    ).send({ externalParticipantId: assigned.externalParticipantId });

    expect(assignedResponse.status).toBe(200);
    expect(assignedResponse.body).toMatchObject({
      conversationId,
      mathReady: true,
      mathTick: 17,
      assignment: { status: "assigned", groupId: "4" },
    });
    expect(JSON.stringify(assignedResponse.body)).not.toContain(
      assigned.externalParticipantId
    );
    expect(assignedResponse.body.points).toBeUndefined();

    const unassignedResponse = await externalPost(
      `/api/v3/external/conversations/${conversationId}/insights/group-membership`
    ).send({ externalParticipantId: unassigned.externalParticipantId });
    expect(unassignedResponse.body.assignment).toEqual({
      status: "unassigned",
    });

    const missingResponse = await externalPost(
      `/api/v3/external/conversations/${conversationId}/insights/group-membership`
    ).send({ externalParticipantId: `missing-${Date.now()}` });
    expect(missingResponse.body.assignment).toEqual({
      status: "participant_not_found",
    });
  });

  test("validates membership lookup and reports unavailable before math", async () => {
    const conversationId = await createExternalConversation();
    const participant = await createExternalComment(
      conversationId,
      `membership-not-ready-${Date.now()}`
    );

    const missing = await externalPost(
      `/api/v3/external/conversations/${conversationId}/insights/group-membership`
    ).send({});
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({
      error: "polis_err_param_missing_externalParticipantId",
    });

    const unavailable = await externalPost(
      `/api/v3/external/conversations/${conversationId}/insights/group-membership`
    ).send({ externalParticipantId: participant.externalParticipantId });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.assignment).toEqual({ status: "unavailable" });

    const unauthorized = await agent
      .post(
        `/api/v3/external/conversations/${conversationId}/insights/group-membership`
      )
      .send({ externalParticipantId: participant.externalParticipantId });
    expect(unauthorized.status).toBe(401);
  });

  test("returns an empty graph shape before math has run", async () => {
    const conversationId = await createExternalConversation();
    const response = await externalGet(
      `/api/v3/external/conversations/${conversationId}/insights/graph`
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId,
      mathReady: false,
      dimensions: ["x", "y"],
      coordinateSystem: "polis-pca",
      points: [],
    });
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
