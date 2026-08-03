export type VoteStats = {
  voteCount: number;
  respondedVoteCount: number;
  agreeCount: number;
  disagreeCount: number;
  passCount: number;
  agreement: number;
  disagreement: number;
  pass: number;
  agreementAmongRespondents: number;
  disagreementAmongRespondents: number;
};

export type ExternalGroupVoteStats = VoteStats & {
  participantCount: number;
  participationRate: number;
};

function roundScore(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? roundScore(numerator / denominator) : 0;
}

export function buildVoteStats(
  agreeCount: number,
  disagreeCount: number,
  passCount: number,
  voteCount = agreeCount + disagreeCount + passCount
): VoteStats {
  const respondedVoteCount = agreeCount + disagreeCount;
  return {
    voteCount,
    respondedVoteCount,
    agreeCount,
    disagreeCount,
    passCount,
    agreement: ratio(agreeCount, voteCount),
    disagreement: ratio(disagreeCount, voteCount),
    pass: ratio(passCount, voteCount),
    agreementAmongRespondents: ratio(agreeCount, respondedVoteCount),
    disagreementAmongRespondents: ratio(disagreeCount, respondedVoteCount),
  };
}

export function buildExternalGroupVoteStats(
  stats: VoteStats,
  participantCount: number
): ExternalGroupVoteStats {
  return {
    ...stats,
    participantCount,
    participationRate: ratio(stats.voteCount, participantCount),
  };
}

export function buildCrossGroupAgreementMetrics(
  groupStats: Record<string, ExternalGroupVoteStats>
) {
  const groups = Object.values(groupStats);
  const respondingGroups = groups.filter(
    (stats) => stats.respondedVoteCount > 0
  );
  const completeCoverage =
    groups.length > 0 && respondingGroups.length === groups.length;
  const agreementValues = respondingGroups.map(
    (stats) => stats.agreementAmongRespondents
  );
  const participationValues = groups.map((stats) => stats.participationRate);

  return {
    crossGroupAgreement: completeCoverage
      ? roundScore(Math.min(...agreementValues))
      : null,
    meanGroupAgreement: completeCoverage
      ? roundScore(
          agreementValues.reduce((total, value) => total + value, 0) /
            agreementValues.length
        )
      : null,
    minimumGroupParticipation:
      groups.length > 0 ? roundScore(Math.min(...participationValues)) : null,
    respondingGroupCount: respondingGroups.length,
  };
}
