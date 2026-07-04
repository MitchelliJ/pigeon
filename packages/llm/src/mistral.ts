/**
 * Mistral triage provider — plain fetch against the chat completions API,
 * JSON-mode response. Endpoint overridable (tests point it at a fake).
 */
import {
  normalizePriority,
  normalizeSummary,
  type LlmProvider,
  type TriageInput,
  type TriageResult,
} from "./types.js";

const SYSTEM_PROMPT = `You are the email triage engine of Pigeon, an app that
only notifies people when an email actually needs them.

Given one email, respond with ONLY a JSON object:
{
  "summary": string,          // ONE sentence, plain language, the gist + any deadline/amount
  "priority": "urgent" | "important" | "everything",
  "needs_attention": boolean, // true only if the user must reply, decide or act
  "suggested_action": string  // short imperative label like "Reply now" or "Pay invoice"; "" if none
}

Priority rules:
- "urgent": requires the user's action — reply needed, RSVP, payment due,
  parcel to pick up, account verification, deadline today/tomorrow.
- "important": the user should know, but no action required — delivery windows,
  upcoming charges, appointment confirmations, security notices.
- "everything": newsletters, promotions, receipts, routine automated mail.

When the user supplies their own instructions, they OVERRIDE these rules.`;

export interface MistralOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs?: number;
}

export class MistralError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "MistralError";
  }
}

export function createMistralProvider(options: MistralOptions): LlmProvider {
  const { apiKey, model, baseUrl, timeoutMs = 30_000 } = options;

  return {
    name: "mistral",

    async triage(input: TriageInput): Promise<TriageResult> {
      const userContent = [
        input.instructions?.trim()
          ? `My triage instructions (these override the defaults):\n${input.instructions.trim()}\n`
          : "",
        `From: ${input.fromName} <${input.fromAddress}>`,
        `Subject: ${input.subject}`,
        ``,
        input.bodyText.slice(0, 8_000),
      ]
        .filter(Boolean)
        .join("\n");

      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 300,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new MistralError(
          `mistral responded ${res.status}: ${body.slice(0, 300)}`,
          res.status,
        );
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new MistralError("mistral returned no content");

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new MistralError(`mistral returned non-JSON content: ${content.slice(0, 200)}`);
      }

      const priority = normalizePriority(parsed.priority);
      const suggested = String(parsed.suggested_action ?? "").trim();
      return {
        summary: normalizeSummary(parsed.summary, input.subject || "(no subject)"),
        priority,
        needsAttention: Boolean(parsed.needs_attention),
        suggestedAction: suggested || undefined,
      };
    },
  };
}
