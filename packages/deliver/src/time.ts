/** Timezone-aware "is the digest due" logic, IANA zones via Intl. */

export interface UserClock {
  /** "HH:MM" in the user's zone. */
  hhmm: string;
  /** "Mon".."Sun" in the user's zone. */
  weekday: string;
  /** "YYYY-MM-DD" in the user's zone — digest idempotency anchor. */
  dateKey: string;
}

export function userClock(timezone: string, now: Date = new Date()): UserClock {
  let zone = timezone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    zone = "UTC"; // unknown zone in DB — degrade gracefully
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // en-GB 24h clock can render midnight as "24:00"; normalize.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    hhmm: `${hour}:${get("minute")}`,
    weekday: get("weekday"),
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

export interface DigestSchedule {
  digestTime: string; // "HH:MM"
  digestDays: string[]; // ["Mon", ...]
  timezone: string;
  lastDigestAt: Date | null;
}

/**
 * Due when: today is a digest day, the clock has passed digest_time, and no
 * digest went out today (all in the user's zone). "Passed" not "equals", so
 * missed ticks catch up instead of skipping a day.
 */
export function isDigestDue(schedule: DigestSchedule, now: Date = new Date()): boolean {
  const clock = userClock(schedule.timezone, now);
  if (!schedule.digestDays.includes(clock.weekday)) return false;
  if (clock.hhmm < schedule.digestTime) return false;
  if (schedule.lastDigestAt) {
    const lastKey = userClock(schedule.timezone, schedule.lastDigestAt).dateKey;
    if (lastKey >= clock.dateKey) return false;
  }
  return true;
}
