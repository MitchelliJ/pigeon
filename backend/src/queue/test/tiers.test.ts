/*
 * Unit tests for the tier -> sync-interval placeholder lookup (Job Queue,
 * Workers & Scheduler PRD §3.2 FR-10). Plain function, no DB needed.
 *
 * RED note: at authoring time `backend/src/queue/tiers.ts` does not exist —
 * this file is expected to fail at import/module-resolution time until the
 * module is implemented.
 */
import { describe, it, expect } from "vitest";
import { intervalForTier } from "../tiers";

describe("intervalForTier", () => {
  it("returns 30 minutes for the free tier", () => {
    expect(intervalForTier("free")).toBe(30);
  });

  it("returns the default 5-minute interval for any tier not in the map", () => {
    expect(intervalForTier("pro")).toBe(5);
    expect(intervalForTier("team")).toBe(5);
    expect(intervalForTier("something-unexpected")).toBe(5);
  });
});
