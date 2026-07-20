import { describe, expect, it } from "vitest";

import {
  FAST_POLL_CAP_MS,
  FAST_POLL_MS,
  NORMAL_POLL_MS,
  emptyStateForPhase,
  filterbarMetaText,
  nextNonReadySinceMs,
  phaseMetaText,
  pollDelayMs,
} from "./onboarding-ui";

describe("onboarding UI helpers", () => {
  it("returns phase meta text for onboarding phases", () => {
    expect(phaseMetaText("importing")).toBe("Importing your email…");
    expect(phaseMetaText("summarizing")).toBe("Summarizing your email…");
    expect(phaseMetaText("error")).toBe("Couldn't sync your mailbox");
    expect(phaseMetaText("ready")).toBeNull();
  });

  it("returns filter-bar meta text for onboarding phases before count copy", () => {
    expect(filterbarMetaText("importing", 1)).toBe("Importing your email…");
    expect(filterbarMetaText("summarizing", 0)).toBe("Summarizing your email…");
    expect(filterbarMetaText("error", 0)).toBe("Couldn't sync your mailbox");
    expect(filterbarMetaText("ready", 1)).toBe("1 messages");
    expect(filterbarMetaText("ready", 0)).toBe("0 messages");
  });

  it("returns empty states only while onboarding phases have no visible rows", () => {
    expect(emptyStateForPhase("importing", 0)).toEqual({
      title: "Importing your email…",
      body: "We're fetching the last 7 days of email from your mailbox. This usually takes a minute or two.",
      showSpinner: true,
    });
    expect(emptyStateForPhase("summarizing", 0)).toEqual({
      title: "Summarizing your email…",
      body: "Pigeon is reading your email and writing one-sentence summaries. They'll appear here as they're ready.",
      showSpinner: true,
    });
    expect(emptyStateForPhase("error", 0)?.title).toBe(
      "We couldn't reach your mailbox",
    );
    expect(emptyStateForPhase("error", 0)?.body).toContain(
      "remove this mailbox and connect it again",
    );
    expect(emptyStateForPhase("error", 0)?.body).toContain(
      "retries automatically",
    );
    expect(emptyStateForPhase("error", 0)?.showSpinner).toBe(false);
    expect(emptyStateForPhase("ready", 0)).toBeNull();
    expect(emptyStateForPhase("importing", 1)).toBeNull();
  });

  it("uses fast polling only before the fast-poll cap for active onboarding", () => {
    expect(pollDelayMs("importing", 1_000, 1_000 + FAST_POLL_CAP_MS - 1)).toBe(
      FAST_POLL_MS,
    );
    expect(pollDelayMs("error", 1_000, 1_000 + FAST_POLL_CAP_MS)).toBe(
      NORMAL_POLL_MS,
    );
    expect(pollDelayMs("ready", 1_000, 1_001)).toBe(NORMAL_POLL_MS);
  });

  it("starts a new non-ready fast-poll window after ready", () => {
    expect(nextNonReadySinceMs(null, "importing", 42_000)).toBe(42_000);
  });
});
