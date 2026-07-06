/*
 * Mistral LLM classifier provider.
 *
 * Talks to the Mistral chat-completions HTTP API directly via `global.fetch`
 * (the endpoint contract is stable, so we avoid adding the `@mistralai/mistralai`
 * SDK dependency). The system prompt is loaded from `./prompt.md` at call time
 * and its `{{CLASSIFICATION_INSTRUCTIONS}}` placeholder is filled with the
 * user's optional override. Classification failures — a non-2xx response, a
 * rejecting fetch, or model content that is not valid JSON — are surfaced as
 * `{ ok: false, reason }` and NEVER thrown into the caller, per PRD §6, so the
 * processing pipeline stays resilient (mirrors `mail/resend.ts`'s discipline).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ClassificationResult,
  ClassifyInput,
  ClassifyResult,
  LlmClassifier,
} from "./index";

const MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/chat/completions";

/** The `{{...}}` marker in `prompt.md` we swap for the user's override. */
const INSTRUCTIONS_PLACEHOLDER = "{{CLASSIFICATION_INSTRUCTIONS}}";

/** Absolute path to the system-prompt template that lives beside this module. */
const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "prompt.md");

/**
 * The slice of `Config` the Mistral provider reads. The real `Config` (which
 * has more fields) is structurally assignable to this, so the classifier stays
 * decoupled from the full config shape (mirrors `MailSenderConfig`).
 */
export interface MistralClassifierConfig {
  MISTRAL_API_KEY?: string;
  MISTRAL_MODEL: string;
}

/**
 * Fill the system prompt with the user's classification instructions. When no
 * override is provided the placeholder line is blanked so no stray marker text
 * leaks into the model prompt.
 */
function buildSystemPrompt(instructions: string | undefined): string {
  const template = readFileSync(PROMPT_PATH, "utf8");
  return template.replace(INSTRUCTIONS_PLACEHOLDER, instructions ?? "");
}

/** Render the incoming email as the user-turn content for the model. */
function buildUserContent(input: ClassifyInput): string {
  return [
    `From name: ${input.fromName}`,
    `From address: ${input.fromAddress}`,
    `Subject: ${input.subject}`,
    "",
    input.body,
  ].join("\n");
}

/**
 * Build a Mistral-backed LlmClassifier. `MISTRAL_API_KEY` and `MISTRAL_MODEL`
 * are captured from the config at creation time, so a single classifier is
 * self-contained.
 */
export function createMistralClassifier(
  config: MistralClassifierConfig,
): LlmClassifier {
  const apiKey = config.MISTRAL_API_KEY;
  const model = config.MISTRAL_MODEL;

  return {
    name: "mistral",

    async classify(input: ClassifyInput): Promise<ClassifyResult> {
      // Defensive: config validation guarantees a key in production, but a
      // misconfigured test or manual call should not throw into the caller.
      if (!apiKey) {
        return {
          ok: false,
          reason: "Mistral classifier missing MISTRAL_API_KEY",
        };
      }

      const body = JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(input.classificationInstructions),
          },
          { role: "user", content: buildUserContent(input) },
        ],
      });

      try {
        const res = await fetch(MISTRAL_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
        });
        if (!res.ok) {
          // Read the body for a more useful reason, but never let parsing
          // failures throw into the caller.
          let detail = "";
          try {
            detail = JSON.stringify(await res.json());
          } catch {
            // ignore — non-JSON or empty body
          }
          return {
            ok: false,
            reason: `Mistral responded ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
          };
        }

        const payload = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          return {
            ok: false,
            reason: "Mistral response missing message content",
          };
        }

        try {
          const parsed = JSON.parse(content) as {
            summary?: unknown;
            category?: unknown;
          };
          if (
            typeof parsed.summary !== "string" ||
            typeof parsed.category !== "string"
          ) {
            return {
              ok: false,
              reason: "Mistral response is missing summary or category",
            };
          }
          return {
            ok: true,
            result: {
              summary: parsed.summary,
              category: parsed.category as ClassificationResult["category"],
            },
          };
        } catch {
          return {
            ok: false,
            reason: "Mistral response content was not valid JSON",
          };
        }
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
