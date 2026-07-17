import { describe, expect, test } from "@jest/globals";

import {
  automaticDelphiThemeJobId,
  nextAutomaticDelphiRunAt,
} from "../../src/utils/delphiJobs";

describe("automatic Delphi job scheduling", () => {
  test("uses one stable job ID per conversation", () => {
    expect(automaticDelphiThemeJobId(42)).toBe("auto-theme-refresh-42");
  });

  test("waits for the debounce window on a first run", () => {
    expect(nextAutomaticDelphiRunAt(1_000, null, 5_000, 30_000)).toBe(
      "1970-01-01T00:00:06.000Z"
    );
  });

  test("honors the minimum interval after a completed run", () => {
    expect(
      nextAutomaticDelphiRunAt(
        10_000,
        "1970-01-01T00:00:08.000Z",
        5_000,
        30_000
      )
    ).toBe("1970-01-01T00:00:38.000Z");
  });

  test("caps debounce postponement during continuous traffic", () => {
    expect(
      nextAutomaticDelphiRunAt(
        50_000,
        null,
        20_000,
        0,
        "1970-01-01T00:00:10.000Z",
        50_000
      )
    ).toBe("1970-01-01T00:01:00.000Z");
  });
});
