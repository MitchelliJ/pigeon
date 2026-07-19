const FALLBACK_TIMEZONES = [
  "Europe/Amsterdam",
  "Europe/Brussels",
  "Europe/London",
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Browser-supported IANA zones plus stable fallbacks and the persisted value. */
export function timezoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const supported = intl.supportedValuesOf?.("timeZone") ?? [];
  return [...new Set([...supported, ...FALLBACK_TIMEZONES, current])].sort(
    (a, b) => a.localeCompare(b),
  );
}
