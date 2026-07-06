/*
 * Connector lookup (PRD "Inbox Connectors & Provider Abstraction" §3.2.2,
 * FR-5). A single switch keyed on `protocol`, so Feature 11's OAuth
 * connectors (`gmail-oauth`/`microsoft-oauth`) can be added later without
 * touching any caller of `getConnector`.
 */

import type { MailboxConnector } from "./types";
import { imapConnector } from "./imap";
import { pop3Connector } from "./pop3";

export function getConnector(protocol: "imap" | "pop3"): MailboxConnector {
  switch (protocol) {
    case "imap":
      return imapConnector;
    case "pop3":
      return pop3Connector;
    default: {
      // The route layer's Zod validation (FR-6) guarantees protocol is
      // "imap" | "pop3" before this is ever reached — fail loudly instead of
      // silently misbehaving if that invariant is ever broken.
      const unreachable: never = protocol;
      throw new Error(`getConnector: unsupported protocol "${unreachable}"`);
    }
  }
}
