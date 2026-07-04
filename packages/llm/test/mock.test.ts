import { describe, expect, it } from "vitest";
import { createMockProvider } from "../src/mock.js";

const provider = createMockProvider();

describe("mock triage provider", () => {
  it("flags payment demands as urgent with an action", async () => {
    const result = await provider.triage({
      fromName: "Cloud Hosting",
      fromAddress: "billing@host.example",
      subject: "Action required: payment method expires tomorrow",
      bodyText: "Your card expires tomorrow and your renewal of €24 is due.",
    });
    expect(result.priority).toBe("urgent");
    expect(result.needsAttention).toBe(true);
    expect(result.suggestedAction).toBeTruthy();
    expect(result.summary.length).toBeGreaterThan(10);
  });

  it("classifies delivery notices as important, not urgent", async () => {
    const result = await provider.triage({
      fromName: "Parcel Co",
      fromAddress: "no-reply@parcel.example",
      subject: "Your package",
      bodyText: "Your package will be delivered on Thursday between 9:00 and 12:00.",
    });
    expect(result.priority).toBe("important");
    expect(result.needsAttention).toBe(false);
  });

  it("classifies newsletters as everything", async () => {
    const result = await provider.triage({
      fromName: "Weekly Digest",
      fromAddress: "newsletter@news.example",
      subject: "10 things happening this week",
      bodyText: "Here is your weekly roundup. Unsubscribe anytime.",
    });
    expect(result.priority).toBe("everything");
    expect(result.needsAttention).toBe(false);
  });

  it("honors user instructions overriding defaults", async () => {
    const result = await provider.triage({
      fromName: "School",
      fromAddress: "info@school.example",
      subject: "Parent evening schedule",
      bodyText: "The schedule for parent evening is attached.",
      instructions: "treat parent evening as urgent",
    });
    expect(result.priority).toBe("urgent");
  });

  it("is deterministic", async () => {
    const input = {
      fromName: "X",
      fromAddress: "x@x.x",
      subject: "Invoice due",
      bodyText: "Please pay by Friday.",
    };
    expect(await provider.triage(input)).toEqual(await provider.triage(input));
  });
});
