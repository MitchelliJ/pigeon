import { describe, expect, it } from "vitest";
import { renderDeliveryMessage } from "../renderer";

describe("channel message renderer", () => {
  it("renders the centralized Discord connection test copy", () => {
    const rendered = renderDeliveryMessage({ type: "test" });

    expect(JSON.stringify(rendered)).toContain(
      "Pigeon test message — Discord delivery is connected.",
    );
  });

  it("renders immediate messages with an action heading and only category plus summary", () => {
    const rendered = renderDeliveryMessage({
      type: "immediate",
      category: "requires_action",
      summary: "Approve the updated supplier contract.",
    });

    const output = JSON.stringify(rendered);

    expect(output).toContain("Requires action");
    expect(output).toContain("Approve the updated supplier contract.");
    expect(output).not.toMatch(/\b(subject|sender|mailbox|body)\b/i);
  });

  it("renders the daily digest heading", () => {
    const rendered = renderDeliveryMessage({
      type: "digest",
      items: [
        {
          category: "important",
          summary: "Budget note is ready for review.",
        },
      ],
    });

    expect(JSON.stringify(rendered)).toContain("Pigeon daily digest");
  });

  it("renders empty digest copy", () => {
    const rendered = renderDeliveryMessage({ type: "empty_digest" });

    expect(JSON.stringify(rendered)).toContain(
      "No new emails since your last digest.",
    );
  });

  it("renders quiet-mode reassurance copy", () => {
    expect(renderDeliveryMessage({ type: "heartbeat" })).toEqual({
      text: "Pigeon is still here — all is well.",
    });
  });

  it("renders digest overflow notice", () => {
    const rendered = renderDeliveryMessage({
      type: "digest",
      items: [],
      omittedCount: 3,
    });

    expect(JSON.stringify(rendered)).toContain(
      "+3 more email(s) are available in Pigeon.",
    );
  });

  it("renders stable category labels", () => {
    const rendered = renderDeliveryMessage({
      type: "digest",
      items: [
        { category: "requires_action", summary: "Reply to Sam." },
        { category: "important", summary: "Read the launch note." },
        { category: "noise", summary: "Skim the newsletter later." },
      ],
    });

    expect(JSON.stringify(rendered)).toMatch(
      /Requires action[\s\S]*Important[\s\S]*Noise/,
    );
  });
});
