/**
 * Deterministic heuristic triage — the no-API-key fallback. Good enough to
 * demo the full pipeline and to keep tests deterministic; swapped for
 * Mistral the moment MISTRAL_API_KEY lands in the environment.
 */
import {
  normalizeSummary,
  type LlmProvider,
  type TriageInput,
  type TriageResult,
  type TriagePriority,
} from "./types.js";

const URGENT_PATTERNS: Array<[RegExp, string]> = [
  [/action required|verify your|confirm your|expires? (today|tomorrow)|last chance to (keep|save)/i, "Act now"],
  [/rsvp|are you (coming|in)|let (me|us) know (if|by)/i, "RSVP"],
  [/invoice (is )?(due|overdue)|payment (is )?(due|failed|overdue)|pay (by|before)/i, "Pay now"],
  [/pick ?up|ready for (pickup|collection)/i, "Pick up"],
  [/deadline|due (today|tomorrow|by)/i, "Meet deadline"],
  [/\?\s*$/m, "Reply"],
];

const IMPORTANT_PATTERNS =
  /will be (delivered|charged)|delivery (window|scheduled)|out for delivery|appointment (confirmed|reminder)|security (alert|notice)|new (sign[- ]?in|login)|subscription renew|price (change|increase)|policy update/i;

const NOISE_PATTERNS =
  /unsubscribe|newsletter|weekly (digest|roundup)|% (off|discount)|sale ends|deal|promo|no.?reply|handed (over )?to (the )?post|receipt/i;

function firstSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^.{10,}?[.!?](\s|$)/);
  return match ? match[0].trim() : cleaned.slice(0, 160);
}

export function createMockProvider(): LlmProvider {
  return {
    name: "mock",

    async triage(input: TriageInput): Promise<TriageResult> {
      const haystack = `${input.subject}\n${input.bodyText}`;

      let priority: TriagePriority = "everything";
      let suggestedAction: string | undefined;

      // User instructions get a tiny nod even in mock mode: "treat X as urgent".
      const instr = input.instructions ?? "";
      const forceUrgent = instr.match(/treat (.+?) as urgent/i)?.[1];
      const forceNoise = instr.match(/treat (.+?) as (unimportant|noise)/i)?.[1];

      if (forceUrgent && haystack.toLowerCase().includes(forceUrgent.toLowerCase())) {
        priority = "urgent";
        suggestedAction = "Review";
      } else if (forceNoise && haystack.toLowerCase().includes(forceNoise.toLowerCase())) {
        priority = "everything";
      } else if (NOISE_PATTERNS.test(haystack)) {
        priority = "everything";
      } else {
        for (const [pattern, action] of URGENT_PATTERNS) {
          if (pattern.test(haystack)) {
            priority = "urgent";
            suggestedAction = action;
            break;
          }
        }
        if (priority !== "urgent" && IMPORTANT_PATTERNS.test(haystack)) {
          priority = "important";
        }
      }

      const gist = firstSentence(input.bodyText) || input.subject || "(no content)";
      const summary = normalizeSummary(
        `${input.fromName || input.fromAddress || "Someone"}: ${gist}`,
        input.subject,
      );

      return {
        summary,
        priority,
        needsAttention: priority === "urgent",
        suggestedAction,
      };
    },
  };
}
