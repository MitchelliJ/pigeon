/*
 * Unit tests for the mock LLM classifier.
 *
 * Mock identifier convention (must match the implementation in ../mock):
 *   - The mock classifier is exported as a singleton `mockLlmClassifier`.
 *   - `mockLlmClassifier.name === "mock"` is the stable identifier.
 *   - `classify(input)` never throws; it always resolves
 *     `{ ok: true, result }` where `result.category` is one of
 *     "requires_action" | "important" | "noise", chosen by a deterministic
 *     keyword heuristic over the subject + body.
 */

import { describe, it, expect } from "vitest";
import { mockLlmClassifier } from "../mock";
import type { ClassifyInput } from "../index";

const baseInput: Omit<ClassifyInput, "subject" | "body"> = {
  fromName: "Sender",
  fromAddress: "sender@example.com",
};

describe("mock llm classifier", () => {
  it("exposes the stable mock identifier", () => {
    expect(mockLlmClassifier.name).toBe("mock");
  });

  it("classifies invoice/payment mail as important", async () => {
    const outcome = await mockLlmClassifier.classify({
      ...baseInput,
      subject: "Invoice #4821 due",
      body: "Please find your invoice attached, payment due in 14 days.",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok outcome");
    expect(outcome.result.category).toBe("important");
    expect(outcome.result.summary.length).toBeGreaterThan(0);
  });

  it("classifies confirmation/RSVP requests as requires_action", async () => {
    const outcome = await mockLlmClassifier.classify({
      ...baseInput,
      subject: "Please confirm your RSVP",
      body: "Can you reply to confirm you're attending?",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok outcome");
    expect(outcome.result.category).toBe("requires_action");
    expect(outcome.result.summary.length).toBeGreaterThan(0);
  });

  it("classifies newsletter-style mail as noise", async () => {
    const outcome = await mockLlmClassifier.classify({
      ...baseInput,
      subject: "This week's top stories",
      body: "Here's your weekly digest of articles you might enjoy.",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok outcome");
    expect(outcome.result.category).toBe("noise");
    expect(outcome.result.summary.length).toBeGreaterThan(0);
  });
});
