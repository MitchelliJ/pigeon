/*
 * LLM classification module — provider selection.
 *
 * A thin seam for turning one incoming email into a short summary plus a triage
 * category (`requires_action` | `important` | `noise`, per the spec's triage
 * model). A classifier is backed by either the real Mistral provider (when an
 * API key is set) or the in-process mock singleton (dev/test). Like the mail
 * seam, classification failures surface as `{ ok: false, reason }` rather than
 * throwing, so the processing pipeline stays resilient. See PRD §6.
 *
 * This module defines the shared contract (types), the `createLlmClassifier`
 * selector that chooses a provider from config, and re-exports the mock.
 */

import { createMistralClassifier } from "./mistral";
import { mockLlmClassifier } from "./mock";

/** One incoming email to classify, plus an optional user override. */
export interface ClassifyInput {
  fromName: string;
  fromAddress: string;
  subject: string;
  body: string;
  classificationInstructions?: string;
}

/** The summary + triage category produced for one email. */
export interface ClassificationResult {
  summary: string;
  category: "requires_action" | "important" | "noise";
}

/** Result of a classification attempt: success or a surfaced, non-thrown failure. */
export type ClassifyResult =
  { ok: true; result: ClassificationResult } | { ok: false; reason: string };

/** A pluggable LLM classifier. `name` is its stable identifier. */
export interface LlmClassifier {
  name: string;
  classify(input: ClassifyInput): Promise<ClassifyResult>;
}

/**
 * The slice of `Config` the LLM module reads. The real `Config` (which has more
 * fields) is structurally assignable to this, so the LLM module stays decoupled
 * from the full config shape (mirrors `MailSenderConfig`).
 */
export interface LlmClassifierConfig {
  NODE_ENV: "development" | "test" | "production";
  MISTRAL_API_KEY?: string;
  MISTRAL_MODEL: string;
}

/**
 * Choose an LlmClassifier from config.
 *
 * Selection rule (mirrors `createMailSender` exactly):
 *   - In production, the Mistral provider is required (MISTRAL_API_KEY is
 *     guaranteed by config validation; we still guard defensively).
 *   - If an API key is set regardless of env, use Mistral (lets dev hit the
 *     live model when experimenting).
 *   - Otherwise fall back to the in-process mock singleton.
 */
export function createLlmClassifier(
  config: LlmClassifierConfig,
): LlmClassifier {
  if (config.NODE_ENV === "production") {
    if (!config.MISTRAL_API_KEY) {
      throw new Error(
        "createLlmClassifier: MISTRAL_API_KEY is required in production",
      );
    }
    return createMistralClassifier(config);
  }
  if (config.MISTRAL_API_KEY) {
    return createMistralClassifier(config);
  }
  return mockLlmClassifier;
}

/** Re-export so callers (and tests) can reach the mock singleton via the
 *  module root, mirroring the mail sibling's convention. */
export { mockLlmClassifier };
