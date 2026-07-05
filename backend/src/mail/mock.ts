/*
 * Mock outbound mail provider.
 *
 * Used in development / test when no Resend API key is configured (FR-28).
 * Logs each email at `info` level (subject + a clickable link when present)
 * for dev visibility, and pushes the same payload onto an in-process outbox
 * that tests inspect via `mockMail.outbox()` / `mockMail.clear()`.
 *
 * Note on the type-only cycle: this file imports only *types* from `./index`,
 * and `./index` imports the `mockMail` *value* from here. Types are erased at
 * runtime, so there is no runtime circular dependency.
 */

import type { MailInput, MailResult, MailSender } from "./index";

/** One captured outbound email in the mock outbox. */
export interface MockOutboxEntry {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Extract the first http(s) link from a string, for clickable dev logging. */
function firstLink(text: string): string | undefined {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : undefined;
}

const outbox: MockOutboxEntry[] = [];

/**
 * Singleton MailSender for dev/test. Identity is stable (`name === "mock"`) so
 * tests can assert that `createMailSender(devConfig) === mockMail`.
 */
export const mockMail: MailSender & {
  outbox(): MockOutboxEntry[];
  clear(): void;
} = {
  name: "mock",

  async send(input: MailInput): Promise<MailResult> {
    const entry: MockOutboxEntry = {
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    };
    outbox.push(entry);
    const link = firstLink(input.html) ?? firstLink(input.text);
    // Minimal info-level log: subject + a clickable link when present.
    console.log(
      `[mail:mock] to=${input.to} subject="${input.subject}"${link ? ` link=${link}` : ""}`,
    );
    return { ok: true };
  },

  /** Return a shallow copy so callers can't mutate the internal buffer. */
  outbox(): MockOutboxEntry[] {
    return [...outbox];
  },

  clear(): void {
    outbox.length = 0;
  },
};
