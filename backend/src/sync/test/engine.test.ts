/*
 * Integration tests for `syncMailbox` (Incremental Sync Engine & Watermarks
 * PRD §3.3, FR-6..FR-8, and §3.6 FR-18).
 *
 * Boots a real embedded Postgres per test via `withTestDb` + `runMigrations`,
 * seals a fake password through a real `createVault(TEST_VAULT_KEY)` (same
 * fixed test key pattern as `../../mailboxes/test/dashboard.test.ts` /
 * `../../../test/config.test.ts`), and drives `syncMailbox` against a fake
 * `MailboxConnector` that records what it was called with and returns
 * scripted `listMessageIds`/`fetchMessages` results — no real IMAP/POP3
 * socket here (that's `../../mailboxes/connectors/test/*`'s job).
 *
 * RED note: at authoring time `../engine` (`syncMailbox`) does not exist yet
 * — this file is expected to fail at import/module-resolution time, not just
 * at an assertion, until Feature 4's engine is implemented.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { createVault } from "../../vault/index";
import { syncMailbox } from "../engine";
import type { Db } from "../../db/index";
import type { Vault } from "../../vault/index";
import type {
  MailboxConnector,
  ListMessageIdsResult,
  FetchMessagesResult,
  TestConnectionParams,
} from "../../mailboxes/connectors/types";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";

async function insertUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, ${"U"}, ${"h"})
    RETURNING id`;
  return String(rows[0]?.id);
}

/** Insert a mailbox row (last_synced_at left NULL — "never synced"). */
async function insertMailbox(
  db: Db,
  vault: Vault,
  userId: string,
  address: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${userId}, ${"imap"}, ${"imap"}, ${"Work"}, ${address},
      ${"imap.example.com"}, ${993}, ${true}, ${address},
      ${vault.seal("fake-password")}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

/** One recorded call to the fake connector's `listMessageIds`. */
interface ListCall {
  opts?: { since?: Date };
}

/** One recorded call to the fake connector's `fetchMessages`. */
interface FetchCall {
  ids: string[];
  opts?: { since?: Date };
}

/**
 * A `MailboxConnector` fake with mutable "what to return" fields and arrays
 * recording every call's arguments, so each test can script results and
 * assert on what the engine actually passed in.
 */
interface FakeConnector extends MailboxConnector {
  listMessageIdsResult: ListMessageIdsResult;
  fetchMessagesResult: FetchMessagesResult;
  listMessageIdsCalls: ListCall[];
  fetchMessagesCalls: FetchCall[];
}

function createFakeConnector(): FakeConnector {
  const fake: FakeConnector = {
    listMessageIdsResult: { ok: true, ids: [] },
    fetchMessagesResult: { ok: true, messages: [] },
    listMessageIdsCalls: [],
    fetchMessagesCalls: [],
    async testConnection(_params: TestConnectionParams) {
      return { ok: true };
    },
    async listMessageIds(_params: TestConnectionParams, opts) {
      fake.listMessageIdsCalls.push({ opts });
      return fake.listMessageIdsResult;
    },
    async fetchMessages(_params: TestConnectionParams, ids, opts) {
      fake.fetchMessagesCalls.push({ ids, opts });
      return fake.fetchMessagesResult;
    },
  };
  return fake;
}

describe("syncMailbox", () => {
  it("first sync (last_synced_at IS NULL) passes a since ~7 days ago, ingests fetched messages, and marks the mailbox connected/synced", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "firstsync@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "firstsync-mb@example.com",
      );

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: true, ids: ["a", "b"] };
      fake.fetchMessagesResult = {
        ok: true,
        messages: [
          {
            providerUid: "a",
            fromName: "Alice",
            fromAddress: "alice@example.com",
            subject: "Subject A",
            body: "Body A",
            receivedAt: new Date("2026-07-01T00:00:00Z"),
            seen: false,
          },
          {
            providerUid: "b",
            fromName: "Bob",
            fromAddress: "bob@example.com",
            subject: "Subject B",
            body: "Body B",
            receivedAt: new Date("2026-07-02T00:00:00Z"),
            seen: true,
          },
        ],
      };

      await syncMailbox(db, vault, fake, mailboxId);

      // since ~ 7 days ago, within tolerance.
      expect(fake.listMessageIdsCalls.length).toBe(1);
      const since = fake.listMessageIdsCalls[0]?.opts?.since;
      expect(since).toBeInstanceOf(Date);
      const daysAgo =
        (Date.now() - (since as Date).getTime()) / (1000 * 60 * 60 * 24);
      expect(daysAgo).toBeGreaterThan(6.9);
      expect(daysAgo).toBeLessThan(7.1);

      // both messages ingested with the right content.
      const emailRows = await db.query`
        SELECT provider_uid, from_name, from_address, subject, body, seen
        FROM emails WHERE mailbox_id = ${mailboxId} ORDER BY provider_uid`;
      expect(emailRows).toEqual([
        {
          provider_uid: "a",
          from_name: "Alice",
          from_address: "alice@example.com",
          subject: "Subject A",
          body: "Body A",
          seen: false,
        },
        {
          provider_uid: "b",
          from_name: "Bob",
          from_address: "bob@example.com",
          subject: "Subject B",
          body: "Body B",
          seen: true,
        },
      ]);

      // mailbox marked connected + last_synced_at set to "now".
      const mailboxRows = await db.query`
        SELECT status, last_synced_at FROM mailboxes WHERE id = ${mailboxId}`;
      expect(mailboxRows[0]?.status).toBe("connected");
      const lastSyncedAt = mailboxRows[0]?.last_synced_at as Date | null;
      expect(lastSyncedAt).not.toBeNull();
      expect(
        Math.abs(Date.now() - (lastSyncedAt as Date).getTime()),
      ).toBeLessThan(60_000);
    } finally {
      await close();
    }
  });

  it("incremental sync (mailbox already synced before) omits the since bound", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "incremental@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "incremental-mb@example.com",
      );
      await db.query`
        UPDATE mailboxes SET last_synced_at = now() - interval '1 hour'
        WHERE id = ${mailboxId}`;

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: true, ids: [] };

      await syncMailbox(db, vault, fake, mailboxId);

      expect(fake.listMessageIdsCalls.length).toBe(1);
      expect(fake.listMessageIdsCalls[0]?.opts?.since).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("only fetches genuinely new ids, diffing against ids already stored in emails", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "dedupe@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "dedupe-mb@example.com",
      );
      await db.query`
        UPDATE mailboxes SET last_synced_at = now() - interval '1 hour'
        WHERE id = ${mailboxId}`;
      await db.query`
        INSERT INTO emails(
          mailbox_id, provider_uid, seen, from_name, from_address,
          subject, body, received_at
        ) VALUES (
          ${mailboxId}, ${"already-have"}, ${false}, ${"Old"},
          ${"old@example.com"}, ${"Old subject"}, ${"Old body"},
          ${new Date("2026-06-01T00:00:00Z")}
        )`;

      const fake = createFakeConnector();
      fake.listMessageIdsResult = {
        ok: true,
        ids: ["already-have", "brand-new"],
      };
      fake.fetchMessagesResult = {
        ok: true,
        messages: [
          {
            providerUid: "brand-new",
            fromName: "New",
            fromAddress: "new@example.com",
            subject: "New subject",
            body: "New body",
            receivedAt: new Date("2026-07-03T00:00:00Z"),
            seen: false,
          },
        ],
      };

      await syncMailbox(db, vault, fake, mailboxId);

      expect(fake.fetchMessagesCalls.length).toBe(1);
      const idsFetched = fake.fetchMessagesCalls[0]?.ids ?? [];
      expect(idsFetched).toContain("brand-new");
      expect(idsFetched).not.toContain("already-have");
    } finally {
      await close();
    }
  });

  it("re-running with no new server-side ids inserts zero new emails rows", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "nonew@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "nonew-mb@example.com",
      );
      await db.query`
        UPDATE mailboxes SET last_synced_at = now() - interval '1 hour'
        WHERE id = ${mailboxId}`;
      await db.query`
        INSERT INTO emails(
          mailbox_id, provider_uid, seen, from_name, from_address,
          subject, body, received_at
        ) VALUES (
          ${mailboxId}, ${"existing"}, ${false}, ${"Old"},
          ${"old@example.com"}, ${"Old subject"}, ${"Old body"},
          ${new Date("2026-06-01T00:00:00Z")}
        )`;

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: true, ids: ["existing"] };
      fake.fetchMessagesResult = { ok: true, messages: [] };

      await syncMailbox(db, vault, fake, mailboxId);

      const rows = await db.query`
        SELECT provider_uid FROM emails WHERE mailbox_id = ${mailboxId}`;
      expect(rows.length).toBe(1);
    } finally {
      await close();
    }
  });

  it("never throws and never duplicates a row, even if fetchMessages returns a message for an id already stored", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "backstop@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "backstop-mb@example.com",
      );
      await db.query`
        INSERT INTO emails(
          mailbox_id, provider_uid, seen, from_name, from_address,
          subject, body, received_at
        ) VALUES (
          ${mailboxId}, ${"dupe"}, ${false}, ${"Original"},
          ${"original@example.com"}, ${"Original subject"},
          ${"Original body"}, ${new Date("2026-06-01T00:00:00Z")}
        )`;

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: true, ids: ["dupe"] };
      fake.fetchMessagesResult = {
        ok: true,
        messages: [
          {
            providerUid: "dupe",
            fromName: "Raced",
            fromAddress: "raced@example.com",
            subject: "Raced subject",
            body: "Raced body",
            receivedAt: new Date("2026-07-04T00:00:00Z"),
            seen: false,
          },
        ],
      };

      // Must resolve without throwing despite the upstream ON CONFLICT
      // backstop being exercised.
      await syncMailbox(db, vault, fake, mailboxId);

      const rows = await db.query`
        SELECT provider_uid FROM emails
        WHERE mailbox_id = ${mailboxId} AND provider_uid = ${"dupe"}`;
      expect(rows.length).toBe(1);
    } finally {
      await close();
    }
  });

  it("a connector failure sets status='error' and leaves last_synced_at unchanged", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "failure@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "failure-mb@example.com",
      );
      const fixedTimestamp = new Date("2020-01-01T00:00:00.000Z");
      await db.query`
        UPDATE mailboxes SET last_synced_at = ${fixedTimestamp}
        WHERE id = ${mailboxId}`;

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: false, reason: "boom" };

      await syncMailbox(db, vault, fake, mailboxId);

      const rows = await db.query`
        SELECT status, last_synced_at FROM mailboxes WHERE id = ${mailboxId}`;
      expect(rows[0]?.status).toBe("error");
      expect((rows[0]?.last_synced_at as Date).getTime()).toBe(
        fixedTimestamp.getTime(),
      );
    } finally {
      await close();
    }
  });
});
