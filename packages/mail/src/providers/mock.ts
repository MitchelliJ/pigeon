/**
 * Mock inbox provider — a fully working in-process "mail server" so the
 * complete pipeline (connect → sync → summarize → deliver) runs with zero
 * external services. Selected with protocol "mock" (hidden behind a dev
 * toggle in the UI). Tests and the dev seed script push messages via
 * `mockMailServer.deliver()`.
 */
import { randomUUID } from "node:crypto";
import {
  truncateBody,
  type FetchOptions,
  type FetchResult,
  type IncomingMessage,
  type InboxProvider,
  type MailConnection,
  type SyncState,
} from "../types.js";

interface StoredMessage extends IncomingMessage {
  uid: number;
}

class MockMailServer {
  private inboxes = new Map<string, StoredMessage[]>();
  private uidCounter = 0;

  /** Push a message into an address's inbox (tests / dev seeding). */
  deliver(address: string, msg: Partial<IncomingMessage> & { subject: string }): void {
    const list = this.inboxes.get(address) ?? [];
    list.push({
      uid: ++this.uidCounter,
      dedupeKey: msg.dedupeKey ?? `<mock-${randomUUID()}@pigeon.test>`,
      fromName: msg.fromName ?? "Mock Sender",
      fromAddress: msg.fromAddress ?? "sender@example.com",
      subject: msg.subject,
      bodyText: truncateBody(msg.bodyText ?? ""),
      receivedAt: msg.receivedAt ?? new Date(),
    });
    this.inboxes.set(address, list);
  }

  list(address: string): StoredMessage[] {
    return this.inboxes.get(address) ?? [];
  }

  reset(): void {
    this.inboxes.clear();
    this.uidCounter = 0;
  }
}

export const mockMailServer = new MockMailServer();

const WELCOME_SAMPLES: Array<Pick<IncomingMessage, "fromName" | "fromAddress" | "subject" | "bodyText">> = [
  {
    fromName: "Pigeon",
    fromAddress: "hello@pigeon.app",
    subject: "Welcome to Pigeon 🕊️",
    bodyText:
      "This mailbox is connected through the built-in mock provider. " +
      "New messages delivered to it flow through sync, summarization and " +
      "notification exactly like real mail. Connect a real IMAP mailbox " +
      "whenever you're ready.",
  },
  {
    fromName: "Cloud Hosting",
    fromAddress: "billing@hosting.example",
    subject: "Action required: payment method expires tomorrow",
    bodyText:
      "Your card on file expires tomorrow and your server renewal of €24 " +
      "is due. Please update your payment method today to avoid downtime.",
  },
  {
    fromName: "Weekly Digest",
    fromAddress: "newsletter@news.example",
    subject: "10 things happening this week",
    bodyText:
      "Here is your weekly roundup of community news, events and articles. " +
      "Unsubscribe anytime.",
  },
];

interface MockState {
  lastUid?: number;
  seeded?: boolean;
}

export const mockProvider: InboxProvider = {
  protocol: "mock",

  async testConnection(conn) {
    if (conn.secret === "fail") {
      throw new Error("mock connection refused (password was literally 'fail')");
    }
  },

  async fetchNew(conn, rawState: SyncState, options: FetchOptions = {}): Promise<FetchResult> {
    const limit = options.limit ?? 50;
    const state = rawState as MockState;

    if (!state.seeded) {
      for (const sample of WELCOME_SAMPLES) {
        mockMailServer.deliver(conn.address, { ...sample });
      }
    }

    const all = mockMailServer.list(conn.address);
    const sinceUid = state.lastUid ?? 0;
    const fresh = all.filter((m) => m.uid > sinceUid);
    const batch = fresh.slice(0, limit);
    const lastUid = batch.length > 0 ? batch[batch.length - 1]!.uid : sinceUid;

    return {
      messages: batch.map(({ uid, ...msg }) => msg),
      state: { lastUid, seeded: true } satisfies MockState,
      hasMore: fresh.length > batch.length,
    };
  },
};
