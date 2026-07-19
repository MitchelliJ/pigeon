/**
 * Convert a 24h "HH:MM" string to a friendly 12h label.
 *   "08:00" -> "8:00am"
 *   "13:30" -> "1:30pm"
 *   "00:05" -> "12:05am"
 */
export function formatTime(time: string): string {
  const [hStr, mStr = "00"] = time.split(":");
  const h = Number(hStr);
  if (Number.isNaN(h)) return time;
  const period = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${mStr.padStart(2, "0")}${period}`;
}

/** Format an API timestamp for people, in their configured delivery zone. */
export function formatDateTime(timestamp: string, timezone: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown";

  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }
}
