import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";

import Config from "../config";

const DELPHI_TOPIC_NAMES_TABLE = "Delphi_CommentClustersLLMTopicNames";

export type DelphiTopic = {
  jobId: string;
  topicKey: string;
  layerId: number;
  clusterId: number;
  topicName: string;
  modelName: string | null;
  createdAt: string | null;
};

export type DelphiTopicRun = {
  jobId: string;
  modelNames: string[];
  createdAt: string | null;
  sourceRevision: number | null;
  labelMethod: string | null;
  embeddingModel: string | null;
  storage: "postgres" | "dynamodb";
  topics: DelphiTopic[];
};

export type DelphiTopicRunsResult = {
  available: boolean;
  runs: DelphiTopicRun[];
  unavailableReason?:
    | "table_not_found"
    | "postgres_unavailable"
    | "dynamodb_unavailable";
};

function createDynamoDocumentClient(): DynamoDBDocumentClient {
  const config: DynamoDBClientConfig = {
    region: Config.AWS_REGION || "us-east-1",
    maxAttempts: 2,
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function parseTopicItem(item: Record<string, unknown>): DelphiTopic | null {
  const topicKey = optionalString(item.topic_key);
  if (!topicKey) {
    return null;
  }

  const newKeyParts = topicKey.split("#");
  const legacyKeyMatch = topicKey.match(/^layer(\d+)_(-?\d+)$/);
  const layerId =
    optionalInteger(item.layer_id) ??
    (newKeyParts.length >= 3
      ? optionalInteger(newKeyParts[1])
      : legacyKeyMatch
      ? optionalInteger(legacyKeyMatch[1])
      : null);
  const clusterId =
    optionalInteger(item.cluster_id) ??
    (newKeyParts.length >= 3
      ? optionalInteger(newKeyParts[2])
      : legacyKeyMatch
      ? optionalInteger(legacyKeyMatch[2])
      : null);

  if (layerId === null || layerId < 0 || clusterId === null || clusterId < 0) {
    return null;
  }

  const jobId =
    optionalString(item.job_id) ||
    (newKeyParts.length >= 3 ? newKeyParts[0] : "legacy");

  return {
    jobId,
    topicKey,
    layerId,
    clusterId,
    topicName:
      optionalString(item.topic_name) || `Theme ${layerId}:${clusterId}`,
    modelName: optionalString(item.model_name),
    createdAt: optionalString(item.created_at),
  };
}

function timestampValue(value: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function organizeDelphiTopicRuns(
  items: Array<Record<string, unknown>>
): DelphiTopicRun[] {
  const topicsByRun = new Map<string, DelphiTopic[]>();

  for (const item of items) {
    const topic = parseTopicItem(item);
    if (!topic) {
      continue;
    }
    const topics = topicsByRun.get(topic.jobId) || [];
    topics.push(topic);
    topicsByRun.set(topic.jobId, topics);
  }

  return Array.from(topicsByRun.entries())
    .map(([jobId, topics]) => {
      topics.sort(
        (left, right) =>
          left.layerId - right.layerId ||
          left.clusterId - right.clusterId ||
          left.topicKey.localeCompare(right.topicKey)
      );
      const modelNames = Array.from(
        new Set(
          topics
            .map((topic) => topic.modelName)
            .filter((modelName): modelName is string => !!modelName)
        )
      ).sort();
      const createdAt = topics
        .map((topic) => topic.createdAt)
        .filter((value): value is string => !!value)
        .sort((left, right) => timestampValue(right) - timestampValue(left))[0];

      return {
        jobId,
        modelNames,
        createdAt: createdAt || null,
        sourceRevision: null,
        labelMethod: null,
        embeddingModel: null,
        storage: "dynamodb" as const,
        topics,
      };
    })
    .sort(
      (left, right) =>
        timestampValue(right.createdAt) - timestampValue(left.createdAt) ||
        right.jobId.localeCompare(left.jobId)
    );
}

export async function loadDelphiTopicRuns(
  conversationNumericId: number
): Promise<DelphiTopicRunsResult> {
  try {
    const { default: pg } = await import("../db/pg-query");
    const rows = await pg.queryP_readOnly<{
      run_id: string;
      source_revision: number | string;
      generated_at: string | Date;
      embedding_model: string;
      label_method: string;
      layer_id: number;
      cluster_id: number;
      topic_name: string;
      model_name: string | null;
    }>(
      "SELECT r.run_id, r.source_revision, r.generated_at, " +
        "r.embedding_model, r.label_method, t.layer_id, t.cluster_id, " +
        "t.topic_name, t.model_name " +
        "FROM delphi_theme_runs r " +
        "JOIN delphi_themes t ON t.run_id = r.run_id " +
        "WHERE r.zid = ($1) " +
        "ORDER BY r.generated_at DESC, t.layer_id, t.cluster_id;",
      [conversationNumericId]
    );

    if (rows.length > 0) {
      const runs = new Map<string, DelphiTopicRun>();
      for (const row of rows) {
        const createdAt = new Date(row.generated_at).toISOString();
        let run = runs.get(row.run_id);
        if (!run) {
          run = {
            jobId: row.run_id,
            modelNames: [row.model_name || row.embedding_model],
            createdAt,
            sourceRevision: Number(row.source_revision),
            labelMethod: row.label_method,
            embeddingModel: row.embedding_model,
            storage: "postgres",
            topics: [],
          };
          runs.set(row.run_id, run);
        } else if (row.model_name && !run.modelNames.includes(row.model_name)) {
          run.modelNames.push(row.model_name);
          run.modelNames.sort();
        }
        run.topics.push({
          jobId: row.run_id,
          topicKey: `${row.run_id}#${row.layer_id}#${row.cluster_id}`,
          layerId: Number(row.layer_id),
          clusterId: Number(row.cluster_id),
          topicName: row.topic_name,
          modelName: row.model_name || row.embedding_model,
          createdAt,
        });
      }
      return { available: true, runs: Array.from(runs.values()) };
    }
  } catch (err) {
    if (
      !err ||
      typeof err !== "object" ||
      !("code" in err) ||
      (err as { code?: string }).code !== "42P01"
    ) {
      return {
        available: false,
        runs: [],
        unavailableReason: "postgres_unavailable",
      };
    }
  }

  // Preserve existing Delphi results during rollout and in standard Docker or
  // AWS deployments. PostgreSQL-only platforms disable this explicitly.
  if (!Config.dynamoDbConfigured) {
    return {
      available: true,
      runs: [],
    };
  }

  const docClient = createDynamoDocumentClient();
  const items: Array<Record<string, unknown>> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  try {
    do {
      const params: QueryCommandInput = {
        TableName: DELPHI_TOPIC_NAMES_TABLE,
        KeyConditionExpression: "conversation_id = :conversationId",
        ExpressionAttributeValues: {
          ":conversationId": String(conversationNumericId),
        },
        ExclusiveStartKey: exclusiveStartKey,
      };
      const result = await docClient.send(new QueryCommand(params));
      for (const item of result.Items || []) {
        items.push(item);
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return {
      available: true,
      runs: organizeDelphiTopicRuns(items),
    };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "name" in err &&
      (err as { name?: string }).name === "ResourceNotFoundException"
    ) {
      return {
        available: false,
        runs: [],
        unavailableReason: "table_not_found",
      };
    }
    return {
      available: false,
      runs: [],
      unavailableReason: "dynamodb_unavailable",
    };
  }
}
