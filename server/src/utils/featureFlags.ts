const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Portable feature default used for services that predate their enable flag.
 * Missing, blank, and unrecognized values preserve existing behavior; only an
 * explicit false value disables the service.
 */
export function enabledUnlessExplicitlyDisabled(
  value: string | null | undefined
): boolean {
  return !DISABLED_VALUES.has(
    String(value || "")
      .trim()
      .toLowerCase()
  );
}
