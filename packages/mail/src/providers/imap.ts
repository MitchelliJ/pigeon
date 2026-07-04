/**
 * IMAP inbox provider (imapflow + mailparser).
 *
 * Watermark: { uidValidity, lastUid }. UIDs only ever grow within a
 * uidValidity generation; when the server changes uidValidity we fall back
 * to a fresh capped backfill (dedupe keys protect against re-import).
 */
import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import {
  FIRST_SYNC_BACKFILL,
  truncateBody,
  type FetchOptions,
  type FetchResult,
  type IncomingMessage,
  type InboxProvider,
  type MailConnection,
  type SyncState,
} from "../types.js";

interface ImapState {
  uidValidity?: string;
  lastUid?: number;
}

export type ImapAuth = { user: string; pass: string } | { user: string; accessToken: string };

export function makeImapClient(
  conn: Pick<MailConnection, "host" | "port" | "tls">,
  auth: ImapAuth,
): ImapFlow {
  return new ImapFlow({
    host: conn.host,
    port: conn.port,
    secure: conn.tls,
    auth,
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
}

function makeClient(conn: MailConnection): ImapFlow {
  return makeImapClient(conn, { user: conn.username, pass: conn.secret });
}

export function parsedToMessage(parsed: ParsedMail, fallbackDate: Date): IncomingMessage {
  const fromAddr = parsed.from?.value?.[0];
  const bodyText = truncateBody(
    (parsed.text ?? "").trim() || (parsed.html ? stripHtml(parsed.html) : ""),
  );
  const dedupeKey =
    parsed.messageId?.trim() ||
    "hash:" +
      createHash("sha256")
        .update(`${fromAddr?.address ?? ""}|${parsed.subject ?? ""}|${(parsed.date ?? fallbackDate).toISOString()}|${bodyText.slice(0, 256)}`)
        .digest("hex");
  return {
    dedupeKey,
    fromName: fromAddr?.name ?? "",
    fromAddress: fromAddr?.address ?? "",
    subject: parsed.subject ?? "",
    bodyText,
    receivedAt: parsed.date ?? fallbackDate,
  };
}

function stripHtml(html: string | false): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Connection test shared by password and OAuth IMAP providers. */
export async function imapTestConnection(client: ImapFlow): Promise<void> {
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    lock.release();
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Watermark-driven fetch shared by password and OAuth IMAP providers. */
export async function imapFetchNew(
  client: ImapFlow,
  rawState: SyncState,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const limit = options.limit ?? 50;
  const state = rawState as ImapState;
  const messages: IncomingMessage[] = [];

  {
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const mailbox = client.mailbox;
        if (!mailbox || typeof mailbox === "boolean") {
          throw new Error("could not open INBOX");
        }
        const uidValidity = String(mailbox.uidValidity ?? "0");
        const uidNext = Number(mailbox.uidNext ?? 1);
        const sameGeneration = state.uidValidity === uidValidity;
        let sinceUid = sameGeneration ? (state.lastUid ?? 0) : 0;

        if (sinceUid === 0) {
          // First sync (or uidValidity reset): capped backfill of the most
          // recent messages so the dashboard isn't empty, watermark at tip.
          const exists = mailbox.exists ?? 0;
          if (exists > 0) {
            const startSeq = Math.max(1, exists - FIRST_SYNC_BACKFILL + 1);
            for await (const msg of client.fetch(`${startSeq}:*`, {
              uid: true,
              source: true,
              internalDate: true,
            })) {
              if (!msg.source) continue;
              const parsed = await simpleParser(msg.source);
              messages.push(parsedToMessage(parsed, msg.internalDate ? new Date(msg.internalDate) : new Date()));
              sinceUid = Math.max(sinceUid, msg.uid);
            }
          }
          return {
            messages,
            state: { uidValidity, lastUid: Math.max(sinceUid, uidNext - 1) },
            hasMore: false,
          };
        }

        if (uidNext - 1 <= sinceUid) {
          return { messages: [], state: { uidValidity, lastUid: sinceUid }, hasMore: false };
        }

        let maxUidSeen = sinceUid;
        let fetched = 0;
        let hasMore = false;
        for await (const msg of client.fetch(
          `${sinceUid + 1}:*`,
          { uid: true, source: true, internalDate: true },
          { uid: true },
        )) {
          // `N:*` returns the last message even when N > max UID — skip stale.
          if (msg.uid <= sinceUid) continue;
          if (fetched >= limit) {
            hasMore = true;
            continue;
          }
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          messages.push(parsedToMessage(parsed, msg.internalDate ? new Date(msg.internalDate) : new Date()));
          maxUidSeen = Math.max(maxUidSeen, msg.uid);
          fetched++;
        }
        return {
          messages,
          state: { uidValidity, lastUid: maxUidSeen },
          hasMore,
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }
}

export const imapProvider: InboxProvider = {
  protocol: "imap",
  testConnection: (conn) => imapTestConnection(makeClient(conn)),
  fetchNew: (conn, state, options) => imapFetchNew(makeClient(conn), state, options),
};
