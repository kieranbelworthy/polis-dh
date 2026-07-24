export type OpinionGroupCluster = {
  id: number;
  members: number[];
};

export type ParticipantOpinionGraphPosition = {
  participantId: number;
  x: number;
  y: number;
  groupId: string | null;
};

function toFiniteNumber(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

/**
 * Polis clusters participants in PCA space and persists those participant
 * positions as base-cluster centroids. `pca.comps`, by contrast, contains the
 * PCA coordinates for statements and must not be indexed by participant.
 */
export function buildParticipantOpinionGraphPositions(
  data: Record<string, any> | undefined,
  groups: OpinionGroupCluster[]
): ParticipantOpinionGraphPosition[] {
  const inConversation = data?.["in-conv"];
  const baseClusters = data?.["base-clusters"];
  if (
    !Array.isArray(inConversation) ||
    !baseClusters ||
    !Array.isArray(baseClusters.id) ||
    !Array.isArray(baseClusters.x) ||
    !Array.isArray(baseClusters.y) ||
    !Array.isArray(baseClusters.members)
  ) {
    return [];
  }

  const groupByBaseClusterId = new Map<number, string>();
  for (const group of groups) {
    const groupId = toFiniteNumber(group.id);
    if (groupId === null || !Array.isArray(group.members)) {
      continue;
    }
    for (const rawBaseClusterId of group.members) {
      const baseClusterId = toFiniteNumber(rawBaseClusterId);
      if (baseClusterId !== null) {
        groupByBaseClusterId.set(baseClusterId, String(groupId));
      }
    }
  }

  const positionByParticipantId = new Map<
    number,
    Omit<ParticipantOpinionGraphPosition, "participantId">
  >();
  for (let index = 0; index < baseClusters.id.length; index += 1) {
    const baseClusterId = toFiniteNumber(baseClusters.id[index]);
    const x = toFiniteNumber(baseClusters.x[index]);
    const y = toFiniteNumber(baseClusters.y[index]);
    const members = baseClusters.members[index];
    if (
      baseClusterId === null ||
      x === null ||
      y === null ||
      !Array.isArray(members)
    ) {
      continue;
    }

    const groupId = groupByBaseClusterId.get(baseClusterId) || null;
    for (const rawParticipantId of members) {
      const participantId = toFiniteNumber(rawParticipantId);
      if (
        participantId !== null &&
        !positionByParticipantId.has(participantId)
      ) {
        positionByParticipantId.set(participantId, { x, y, groupId });
      }
    }
  }

  return inConversation.flatMap((rawParticipantId: unknown) => {
    const participantId = toFiniteNumber(rawParticipantId);
    if (participantId === null) {
      return [];
    }
    const position = positionByParticipantId.get(participantId);
    return position ? [{ participantId, ...position }] : [];
  });
}
