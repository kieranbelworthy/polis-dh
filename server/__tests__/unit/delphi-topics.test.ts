import { describe, expect, test } from "@jest/globals";

import { organizeDelphiTopicRuns } from "../../src/utils/delphiTopics";

describe("organizeDelphiTopicRuns", () => {
  test("normalizes, groups, and sorts current and legacy topic records", () => {
    const runs = organizeDelphiTopicRuns([
      {
        conversation_id: "1",
        topic_key: "older-job#1#3",
        topic_name: "Older theme",
        layer_id: "1",
        cluster_id: "3",
        model_name: "older-model",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        conversation_id: "1",
        topic_key: "newer-job#2#1",
        topic_name: "Coarse theme",
        layer_id: 2,
        cluster_id: 1,
        model_name: "new-model",
        created_at: "2026-02-01T00:00:00.000Z",
      },
      {
        conversation_id: "1",
        topic_key: "newer-job#0#2",
        topic_name: "Fine theme",
        model_name: "new-model",
        created_at: "2026-02-01T00:00:00.000Z",
      },
      {
        conversation_id: "1",
        topic_key: "layer0_7",
        topic_name: "Legacy theme",
        created_at: "2025-01-01T00:00:00.000Z",
      },
      {
        conversation_id: "1",
        topic_key: "malformed",
        topic_name: "Ignored",
      },
    ]);

    expect(runs.map((run) => run.jobId)).toEqual([
      "newer-job",
      "older-job",
      "legacy",
    ]);
    expect(runs[0]).toMatchObject({
      jobId: "newer-job",
      modelNames: ["new-model"],
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    expect(
      runs[0].topics.map((topic) => [topic.layerId, topic.clusterId])
    ).toEqual([
      [0, 2],
      [2, 1],
    ]);
    expect(runs[2].topics[0]).toMatchObject({
      jobId: "legacy",
      layerId: 0,
      clusterId: 7,
    });
  });

  test("uses explicit item fields and a stable fallback name", () => {
    const runs = organizeDelphiTopicRuns([
      {
        topic_key: "opaque-key",
        job_id: "explicit-job",
        layer_id: 4,
        cluster_id: 9,
      },
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].topics[0]).toMatchObject({
      jobId: "explicit-job",
      topicName: "Theme 4:9",
      layerId: 4,
      clusterId: 9,
    });
  });
});
