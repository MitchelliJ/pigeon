/*
 * Unit tests for the imapflow-based IMAP connector (PRD "Incremental Sync
 * Engine & Watermarks" §3.2 FR-2). Per FR-2, protocol correctness is
 * `imapflow`'s own responsibility now (a purpose-built fake IMAP server for
 * tests is deprecated/unmaintained, and the maintained alternative requires
 * a stateful MongoDB the project's single-box constraint rules out) — so
 * these tests exercise `imap.ts`'s own logic (since-filtering, id mapping,
 * MIME parsing, error mapping) against an in-memory fake implementing the
 * small injectable `ImapClient` interface, never a real socket.
 *
 * RED note: `backend/src/mailboxes/connectors/{imap-client,imap}.ts` don't
 * export `createImapConnector`/`ImapClient`/`ImapClientFactory` yet — this
 * file's imports fail to resolve, so every test below fails at import time.
 * That is the expected RED; the GREEN step implements `imap.ts` on top of
 * `imapflow` behind that injectable client interface to match the shape
 * exercised here.
 */
import { describe, it, expect } from "vitest";
import { createImapConnector } from "../connectors/imap";
import type { ImapClient, ImapClientFactory } from "../connectors/imap-client";
import type { TestConnectionParams } from "../connectors/types";

const PARAMS: TestConnectionParams = {
  host: "imap.example.com",
  port: 993,
  tls: true,
  username: "alice",
  password: "s3cret",
};

/** A raw RFC822-ish plain-text message, similar in spirit to pop3.ts's fixtures. */
function buildPlainTextSource(opts: {
  fromName: string;
  fromAddress: string;
  subject: string;
  date: Date;
  body: string;
}): Buffer {
  const headers = [
    `From: ${opts.fromName} <${opts.fromAddress}>`,
    `Subject: ${opts.subject}`,
    `Date: ${opts.date.toUTCString()}`,
    "Content-Type: text/plain",
  ].join("\r\n");
  return Buffer.from(`${headers}\r\n\r\n${opts.body}\r\n`, "utf8");
}

/** A raw RFC822-ish HTML-only message (no text/plain part at all). */
function buildHtmlOnlySource(opts: {
  fromName: string;
  fromAddress: string;
  subject: string;
  date: Date;
  html: string;
}): Buffer {
  const headers = [
    `From: ${opts.fromName} <${opts.fromAddress}>`,
    `Subject: ${opts.subject}`,
    `Date: ${opts.date.toUTCString()}`,
    "Content-Type: text/html",
  ].join("\r\n");
  return Buffer.from(`${headers}\r\n\r\n${opts.html}\r\n`, "utf8");
}

type FetchItem = { uid: number; source?: Buffer; flags?: Set<string> };

/**
 * A small scriptable in-memory fake implementing the narrow `ImapClient`
 * interface FR-2 describes — no real socket, no real imapflow.
 */
class FakeImapClient implements ImapClient {
  connectError: unknown = undefined;
  searchResult: number[] = [];
  fetchItems: FetchItem[] = [];
  fetchError: unknown = undefined;
  searchError: unknown = undefined;

  connectCalls = 0;
  logoutCalls = 0;
  searchCalls: Array<{
    query: Record<string, unknown>;
    options?: { uid?: boolean };
  }> = [];
  lockedPaths: string[] = [];

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
  }

  async getMailboxLock(path: string): Promise<{ release(): void }> {
    this.lockedPaths.push(path);
    return { release: () => {} };
  }

  async search(
    query: Record<string, unknown>,
    options?: { uid?: boolean },
  ): Promise<number[]> {
    this.searchCalls.push({ query, options });
    if (this.searchError) throw this.searchError;
    return this.searchResult;
  }

  async *fetch(
    _range: number[],
    _options: Record<string, unknown>,
  ): AsyncIterable<FetchItem> {
    if (this.fetchError) throw this.fetchError;
    for (const item of this.fetchItems) {
      yield item;
    }
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1;
  }

  close(): void {}
}

function factoryFor(client: FakeImapClient): ImapClientFactory {
  return () => client;
}

describe("imap connector — testConnection", () => {
  it("resolves { ok: true } and calls logout() when connect() resolves", async () => {
    const client = new FakeImapClient();
    const connector = createImapConnector(factoryFor(client));

    const result = await connector.testConnection(PARAMS);

    expect(result).toEqual({ ok: true });
    expect(client.logoutCalls).toBe(1);
  });

  it("resolves { ok: false, reason: 'authentication failed' } when connect() rejects with authenticationFailed: true", async () => {
    const client = new FakeImapClient();
    client.connectError = { authenticationFailed: true, message: "bad creds" };
    const connector = createImapConnector(factoryFor(client));

    const result = await connector.testConnection(PARAMS);

    expect(result).toEqual({ ok: false, reason: "authentication failed" });
  });

  it("resolves { ok: false, reason: 'could not reach <host>:<port>' } without throwing when connect() rejects with a plain network error", async () => {
    const client = new FakeImapClient();
    client.connectError = new Error("ECONNREFUSED");
    const connector = createImapConnector(factoryFor(client));

    const result = await connector.testConnection(PARAMS);

    expect(result).toEqual({
      ok: false,
      reason: `could not reach ${PARAMS.host}:${PARAMS.port}`,
    });
  });
});

describe("imap connector — listMessageIds", () => {
  it("with no opts, searches { all: true } with { uid: true } and maps UIDs to string ids", async () => {
    const client = new FakeImapClient();
    client.searchResult = [101, 102, 103];
    const connector = createImapConnector(factoryFor(client));

    const result = await connector.listMessageIds(PARAMS);

    expect(result).toEqual({ ok: true, ids: ["101", "102", "103"] });
    expect(client.searchCalls).toEqual([
      { query: { all: true }, options: { uid: true } },
    ]);
  });

  it("with opts.since, searches { since: <date> } with { uid: true }", async () => {
    const client = new FakeImapClient();
    const since = new Date("2026-06-01T00:00:00.000Z");
    client.searchResult = [201];
    const connector = createImapConnector(factoryFor(client));

    const result = await connector.listMessageIds(PARAMS, { since });

    expect(result).toEqual({ ok: true, ids: ["201"] });
    expect(client.searchCalls).toEqual([
      { query: { since }, options: { uid: true } },
    ]);
  });

  it("resolves { ok: false, reason } without throwing when search() rejects", async () => {
    const client = new FakeImapClient();
    client.searchError = new Error("search boom");
    const connector = createImapConnector(factoryFor(client));

    const result = await connector.listMessageIds(PARAMS);

    expect(result.ok).toBe(false);
  });
});

describe("imap connector — fetchMessages", () => {
  it("resolves parsed FetchedMessages with correct fields and seen flag mapped from \\Seen", async () => {
    const date1 = new Date("2026-06-15T10:00:00.000Z");
    date1.setMilliseconds(0);
    const date2 = new Date("2026-06-16T11:00:00.000Z");
    date2.setMilliseconds(0);

    const client = new FakeImapClient();
    client.fetchItems = [
      {
        uid: 101,
        source: buildPlainTextSource({
          fromName: "Alice",
          fromAddress: "alice@example.com",
          subject: "Hello there",
          date: date1,
          body: "Hi Bob,\r\n\r\nJust checking in.\r\n\r\nAlice",
        }),
        flags: new Set(["\\Seen"]),
      },
      {
        uid: 102,
        source: buildPlainTextSource({
          fromName: "Carol",
          fromAddress: "carol@example.com",
          subject: "Unread thing",
          date: date2,
          body: "This is unread.",
        }),
        flags: new Set(),
      },
    ];
    const connector = createImapConnector(factoryFor(client));

    const result = await connector.fetchMessages(PARAMS, ["101", "102"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const msg1 = result.messages.find((m) => m.providerUid === "101");
    const msg2 = result.messages.find((m) => m.providerUid === "102");

    expect(msg1).toMatchObject({
      providerUid: "101",
      fromName: "Alice",
      fromAddress: "alice@example.com",
      subject: "Hello there",
      seen: true,
    });
    expect(msg1?.receivedAt.getTime()).toBe(date1.getTime());
    expect(msg1?.body).toContain("Just checking in.");

    expect(msg2).toMatchObject({
      providerUid: "102",
      fromName: "Carol",
      fromAddress: "carol@example.com",
      subject: "Unread thing",
      seen: false,
    });
    expect(msg2?.receivedAt.getTime()).toBe(date2.getTime());
  });

  it("falls back to html-to-text conversion for an HTML-only message, yielding non-empty tag-free body", async () => {
    const date = new Date("2026-06-15T10:00:00.000Z");
    const client = new FakeImapClient();
    client.fetchItems = [
      {
        uid: 201,
        source: buildHtmlOnlySource({
          fromName: "Dana",
          fromAddress: "dana@example.com",
          subject: "HTML update",
          date,
          html: "<html><body><p>Hello from Dana</p></body></html>",
        }),
        flags: new Set(),
      },
    ];
    const connector = createImapConnector(factoryFor(client));

    const result = await connector.fetchMessages(PARAMS, ["201"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const msg = result.messages.find((m) => m.providerUid === "201");
    expect(msg).toBeDefined();
    expect(msg?.body.length).toBeGreaterThan(0);
    expect(msg?.body).not.toMatch(/<[a-z][\s\S]*>/i);
  });

  it("resolves { ok: false, reason } without throwing when fetch() rejects", async () => {
    const client = new FakeImapClient();
    client.fetchError = new Error("fetch boom");
    const connector = createImapConnector(factoryFor(client));

    const result = await connector.fetchMessages(PARAMS, ["101"]);

    expect(result.ok).toBe(false);
  });
});
