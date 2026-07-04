import { describe, expect, it } from "vitest";
import { isDigestDue, userClock } from "../src/time.js";

// 2026-07-02 was a Thursday. 10:00 UTC = 12:00 in Amsterdam (CEST, +2).
const now = new Date("2026-07-02T10:00:00Z");

describe("userClock", () => {
  it("renders the user's local time and day", () => {
    const clock = userClock("Europe/Amsterdam", now);
    expect(clock.hhmm).toBe("12:00");
    expect(clock.weekday).toBe("Thu");
    expect(clock.dateKey).toBe("2026-07-02");
  });

  it("degrades to UTC on unknown zones", () => {
    const clock = userClock("Neverland/Nowhere", now);
    expect(clock.hhmm).toBe("10:00");
  });
});

describe("isDigestDue", () => {
  const base = {
    digestTime: "08:00",
    digestDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    timezone: "Europe/Amsterdam",
    lastDigestAt: null as Date | null,
  };

  it("due when past the time and none sent today", () => {
    expect(isDigestDue(base, now)).toBe(true);
  });

  it("not due before the configured time", () => {
    expect(isDigestDue({ ...base, digestTime: "18:00" }, now)).toBe(false);
  });

  it("not due on an excluded weekday", () => {
    expect(isDigestDue({ ...base, digestDays: ["Mon"] }, now)).toBe(false);
  });

  it("not due when today's digest already went out", () => {
    const lastDigestAt = new Date("2026-07-02T06:30:00Z"); // 08:30 Amsterdam
    expect(isDigestDue({ ...base, lastDigestAt }, now)).toBe(false);
  });

  it("due again the next day", () => {
    const lastDigestAt = new Date("2026-07-01T06:30:00Z");
    expect(isDigestDue({ ...base, lastDigestAt }, now)).toBe(true);
  });

  it("catches up when the tick fires late", () => {
    // 23:50 local, digest was for 08:00, still today, none sent → due.
    const late = new Date("2026-07-02T21:50:00Z");
    expect(isDigestDue(base, late)).toBe(true);
  });
});
