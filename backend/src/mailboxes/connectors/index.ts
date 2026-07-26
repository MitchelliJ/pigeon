/*
 * Connector lookup (PRD "Inbox Connectors & Provider Abstraction" §3.2.2,
 * FR-5). A single switch keyed on `protocol`. `microsoft-oauth` (Feature 13)
 * routes to the IMAP connector since it speaks IMAP with an XOAUTH2 access
 * token in place of a password.
 */

import type { MailboxConnector } from "./types";
import { imapConnector } from "./imap";
import { pop3Connector } from "./pop3";

export function getConnector(
  protocol: "imap" | "pop3" | "microsoft-oauth",
): MailboxConnector {
  switch (protocol) {
    case "imap":
    case "microsoft-oauth":
      return imapConnector;
    case "pop3":
      return pop3Connector;
    default: {
      // The route layer's Zod validation (FR-6) guarantees protocol is
      // "imap" | "pop3" | "microsoft-oauth" before this is ever reached — fail
      // loudly instead of silently misbehaving if that invariant is ever
      // broken.
      const unreachable: never = protocol;
      throw new Error(`getConnector: unsupported protocol "${unreachable}"`);
    }
  }
}
