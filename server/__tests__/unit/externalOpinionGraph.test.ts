import {
  buildParticipantOpinionGraphPositions,
  type OpinionGroupCluster,
} from "../../src/utils/externalOpinionGraph";

describe("buildParticipantOpinionGraphPositions", () => {
  const groups: OpinionGroupCluster[] = [
    { id: 0, members: [10] },
    { id: 1, members: [11, 12] },
  ];

  test("maps participants to their base-cluster coordinates and opinion group", () => {
    const data = {
      "in-conv": [101, 102, 103, 104],
      "base-clusters": {
        id: [10, 11, 12],
        x: [-0.75, 0.25, 0.8],
        y: [0.4, -0.2, 0.6],
        members: [[101, 102], [103], [104]],
      },
      pca: {
        // These are statement coordinates. Deliberate collisions here must
        // have no effect on participant positions.
        comps: [
          [0, 0.25, 0.25, 0],
          [0, -0.2, -0.2, 0],
        ],
      },
    };

    expect(buildParticipantOpinionGraphPositions(data, groups)).toEqual([
      { participantId: 101, x: -0.75, y: 0.4, groupId: "0" },
      { participantId: 102, x: -0.75, y: 0.4, groupId: "0" },
      { participantId: 103, x: 0.25, y: -0.2, groupId: "1" },
      { participantId: 104, x: 0.8, y: 0.6, groupId: "1" },
    ]);
  });

  test("preserves in-conversation order and omits malformed or unclustered participants", () => {
    const data = {
      "in-conv": [3, 2, 1, 999],
      "base-clusters": {
        id: [10, 11, 12],
        x: [-1, "bad", 1],
        y: [0, 0.5, 0.75],
        members: [[1], [2], [3]],
      },
    };

    expect(buildParticipantOpinionGraphPositions(data, groups)).toEqual([
      { participantId: 3, x: 1, y: 0.75, groupId: "1" },
      { participantId: 1, x: -1, y: 0, groupId: "0" },
    ]);
  });

  test("returns an empty list for incomplete base-cluster data", () => {
    expect(
      buildParticipantOpinionGraphPositions(
        {
          "in-conv": [1],
          "base-clusters": { id: [10], members: [[1]] },
        },
        groups
      )
    ).toEqual([]);
  });
});
