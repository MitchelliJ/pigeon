/*
 * Resend outbound mail provider.
 *
 * Talks to the Resend HTTP API directly via `global.fetch` (the endpoint
 * contract is identical to the `resend` SDK, so we avoid adding the npm
 * dependency). Transport failures — non-2xx responses or a rejecting fetch —
 * are surfaced as `{ ok: false, reason }` and NEVER thrown into the request
 * path, per FR-27. The auth caller logs the reason and still answers 202.
 */

import type {
  MailInput,
  MailResult,
  MailSender,
  MailSenderConfig,
} from "./index";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Build a Resend-backed MailSender. `apiKey` and `from` are captured from the
 * config at creation time, so a single sender is self-contained.
 */
export function createResendSender(config: MailSenderConfig): MailSender {
  const apiKey = config.RESEND_API_KEY;
  const from = config.MAIL_FROM;

  return {
    name: "resend",

    async send(input: MailInput): Promise<MailResult> {
      // Defensive: config validation guarantees these in production, but a
      // misconfigured test or manual call should not throw into the caller.
      if (!apiKey || !from) {
        return {
          ok: false,
          reason: "Resend sender missing RESEND_API_KEY or MAIL_FROM",
        };
      }

      const body = JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      });

      try {
        const res = await fetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
        });
        if (!res.ok) {
          // Read the body for a more useful reason, but never let parsing
          // failures throw into the request path.
          let detail = "";
          try {
            detail = JSON.stringify(await res.json());
          } catch {
            // ignore — non-JSON or empty body
          }
          return {
            ok: false,
            reason: `Resend responded ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
          };
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
