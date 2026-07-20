/*
 * Stable user-scoped message identity. RFC Message-ID is authoritative when
 * present; conservative content identity is used only for messages without it.
 */
import { createHash } from "node:crypto";

export interface MessageIdentityInput {
  rfcMessageId?: string;
  fromAddress: string;
  subject: string;
  body: string;
  receivedAt: Date;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Build a strategy-prefixed identity key without provider-specific values. */
export function messageIdentityKey(input: MessageIdentityInput): string {
  const normalizedMessageId = input.rfcMessageId
    ?.trim()
    .replace(/^<|>$/g, "")
    .trim()
    .toLowerCase();
  if (normalizedMessageId) {
    return `rfc:${normalizedMessageId}`;
  }

  const sender = input.fromAddress.trim().toLowerCase();
  const subject = input.subject.trim().replace(/\s+/g, " ").toLowerCase();
  const receivedSecond = Math.floor(input.receivedAt.getTime() / 1000);
  const bodyHash = sha256(input.body);
  return `fallback:${sha256(
    `${sender}\n${subject}\n${String(receivedSecond)}\n${bodyHash}`,
  )}`;
}
