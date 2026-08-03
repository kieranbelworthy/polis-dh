import {
  buildCrossGroupAgreementMetrics,
  buildVoteStats,
} from "../../src/utils/externalInsightMetrics";

function groupStats(
  agreeCount: number,
  disagreeCount: number,
  passCount: number,
  participantCount: number
) {
  const stats = buildVoteStats(agreeCount, disagreeCount, passCount);
  return {
    ...stats,
    participantCount,
    participationRate:
      participantCount > 0 ? stats.voteCount / participantCount : 0,
  };
}

describe("external statement agreement metrics", () => {
  test("separates agreement among respondents from passes", () => {
    expect(buildVoteStats(6, 2, 2)).toEqual({
      voteCount: 10,
      respondedVoteCount: 8,
      agreeCount: 6,
      disagreeCount: 2,
      passCount: 2,
      agreement: 0.6,
      disagreement: 0.2,
      pass: 0.2,
      agreementAmongRespondents: 0.75,
      disagreementAmongRespondents: 0.25,
    });
  });

  test("uses the least-agreeing opinion group as cross-group agreement", () => {
    expect(
      buildCrossGroupAgreementMetrics({
        "0": groupStats(8, 2, 0, 20),
        "1": groupStats(6, 2, 2, 20),
      })
    ).toEqual({
      crossGroupAgreement: 0.75,
      meanGroupAgreement: 0.775,
      minimumGroupParticipation: 0.5,
      respondingGroupCount: 2,
    });
  });

  test("does not claim cross-group agreement when any group has no response", () => {
    expect(
      buildCrossGroupAgreementMetrics({
        "0": groupStats(8, 2, 0, 20),
        "1": groupStats(0, 0, 0, 20),
      })
    ).toEqual({
      crossGroupAgreement: null,
      meanGroupAgreement: null,
      minimumGroupParticipation: 0,
      respondingGroupCount: 1,
    });
  });
});
