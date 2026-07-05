/*
 * Outbound mail module — provider selection.
 *
 * A thin outbound-email seam: `createMailSender(config)` returns a MailSender
 * backed by either the Resend provider (production / when an API key is set)
 * or the in-process mock singleton (dev/test). The auth module calls this to
 * send verification and password-reset emails; transport failures surface as
 * `{ ok: false, reason }` rather than throwing, so request handlers stay
 * resilient (FR-7 / FR-21 still answer 202). See PRD §3.2, FR-26..FR-29.
 */

import { createResendSender } from "./resend";
import { mockMail } from "./mock";
import type { Config } from "../config";

/** Sender address + recipient + content for one outbound email. */
export interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Result of an attempted send: success or a surfaced, non-thrown failure. */
export type MailResult = { ok: true } | { ok: false; reason: string };

/** A pluggable outbound mail provider. `name` is its stable identifier. */
export interface MailSender {
  name: string;
  send(input: MailInput): Promise<MailResult>;
}

/**
 * The slice of `Config` the mail module reads. The real `Config` (which has
 * more fields) is structurally assignable to this, so we keep the mail module
 * decoupled from the full config shape.
 */
export interface MailSenderConfig {
  NODE_ENV: "development" | "test" | "production";
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  APP_BASE_URL: string;
}

/**
 * Choose a MailSender from config.
 *
 * Selection rule (matches FR-28 / FR-31):
 *   - In production, the Resend provider is required (RESEND_API_KEY + MAIL_FROM
 *     are guaranteed by config validation; we still guard defensively).
 *   - If an API key is set regardless of env, use Resend (lets dev hit live
 *     Resend when experimenting).
 *   - Otherwise fall back to the in-process mock singleton.
 */
export function createMailSender(config: MailSenderConfig): MailSender {
  if (config.NODE_ENV === "production") {
    if (!config.RESEND_API_KEY || !config.MAIL_FROM) {
      throw new Error(
        "createMailSender: RESEND_API_KEY and MAIL_FROM are required in production",
      );
    }
    return createResendSender(config);
  }
  if (config.RESEND_API_KEY) {
    return createResendSender(config);
  }
  return mockMail;
}

/** Re-export so callers (and tests) can reach the mock singleton via the
 *  module root, and so `Config` is usable through this entry point too. */
export { mockMail };
export type { Config };
