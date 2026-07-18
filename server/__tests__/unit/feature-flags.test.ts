import { enabledUnlessExplicitlyDisabled } from "../../src/utils/featureFlags";

describe("portable enabled-by-default feature flags", () => {
  test.each([undefined, null, "", "true", "1", "yes", "on", "typo"])(
    "preserves existing behavior for %p",
    (value) => {
      expect(enabledUnlessExplicitlyDisabled(value)).toBe(true);
    }
  );

  test.each(["false", "0", "no", "off", " FALSE "])(
    "honors explicit disable value %p",
    (value) => {
      expect(enabledUnlessExplicitlyDisabled(value)).toBe(false);
    }
  );
});
