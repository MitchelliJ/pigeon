/*
 * Mock LLM classifier.
 *
 * Used in development / test when no real LLM (Mistral) API key is configured.
 * Instead of calling out to a model, it applies a deterministic, case-insensitive
 * keyword heuristic over the email's subject + body to pick a triage category,
 * and derives a short summary from the subject and sender. This keeps the dev
 * and test paths fast, offline, and repeatable. The real provider (a later task)
 * reads `./prompt.md`; this mock never does.
 *
 * Note on the type-only cycle: this file imports only *types* from `./index`,
 * and `./index` imports the `mockLlmClassifier` *value* from here. Types are
 * erased at runtime, so there is no runtime circular dependency.
 */

import type {
  ClassificationResult,
  ClassifyInput,
  ClassifyResult,
  LlmClassifier,
} from "./index";

/** Keywords that, when present, mark an email as `important`. */
const IMPORTANT_KEYWORDS = ["invoice", "payment", "deliver"];

/** Keywords that, when present, mark an email as `requires_action`. */
const ACTION_KEYWORDS = ["action", "rsvp", "confirm", "reply", "sign"];

/** Pick a triage category from the combined subject + body text. */
function classifyText(text: string): ClassificationResult["category"] {
  const haystack = text.toLowerCase();
  if (IMPORTANT_KEYWORDS.some((word) => haystack.includes(word))) {
    return "important";
  }
  if (ACTION_KEYWORDS.some((word) => haystack.includes(word))) {
    return "requires_action";
  }
  return "noise";
}

/** Build a short, non-empty, third-person summary from the input. */
function summarize(input: ClassifyInput): string {
  const subject = input.subject.trim() || "an email";
  const shortSubject =
    subject.length > 80 ? `${subject.slice(0, 77)}...` : subject;
  return `${input.fromName} sent "${shortSubject}".`;
}

/**
 * Singleton LlmClassifier for dev/test. Identity is stable (`name === "mock"`)
 * so callers can assert selection. `classify` never throws; it always resolves
 * `{ ok: true, result }`.
 */
export const mockLlmClassifier: LlmClassifier = {
  name: "mock",

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const category = classifyText(`${input.subject} ${input.body}`);
    return {
      ok: true,
      result: {
        summary: summarize(input),
        category,
      },
    };
  },
};
