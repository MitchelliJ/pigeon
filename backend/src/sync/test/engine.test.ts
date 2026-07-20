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

async function insertStoredMessage(
  db: Db,
  userId: string,
  mailboxId: string,
  providerUid: string,
): Promise<void> {
  const rows = await db.query`
    INSERT INTO messages(
      user_id, identity_key, from_name, from_address, subject, body, received_at
    ) VALUES (
      ${userId}, ${`test:${providerUid}`}, 'Old', 'old@example.com',
      'Old subject', 'Old body', ${new Date("2026-06-01T00:00:00Z")}
    ) RETURNING id`;
  await db.query`
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    VALUES (${mailboxId}, ${rows[0]?.id}, ${providerUid}, false)`;
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
            receivedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
            seen: false,
          },
          {
            providerUid: "b",
            fromName: "Bob",
            fromAddress: "bob@example.com",
            subject: "Subject B",
            body: "Body B",
            receivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
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
        SELECT mm.provider_uid, m.from_name, m.from_address, m.subject, m.body,
          mm.seen
        FROM mailbox_messages mm
        JOIN messages m ON m.id = mm.message_id
        WHERE mm.mailbox_id = ${mailboxId} ORDER BY mm.provider_uid`;
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

  it("first sync with zero in-window messages inserts nothing but still marks the mailbox connected and sets last_synced_at", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "zeroinwindow@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "zeroinwindow-mb@example.com",
      );

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: true, ids: ["old-1", "old-2"] };
      fake.fetchMessagesResult = {
        ok: true,
        messages: [
          {
            providerUid: "old-1",
            fromName: "Old One",
            fromAddress: "old1@example.com",
            subject: "Old 1",
            body: "Old body 1",
            receivedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
            seen: false,
          },
          {
            providerUid: "old-2",
            fromName: "Old Two",
            fromAddress: "old2@example.com",
            subject: "Old 2",
            body: "Old body 2",
            receivedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            seen: true,
          },
        ],
      };

      await syncMailbox(db, vault, fake, mailboxId);

      const emailRows = await db.query`
        SELECT provider_uid FROM mailbox_messages WHERE mailbox_id = ${mailboxId}`;
      const mailboxRows = await db.query`
        SELECT status, last_synced_at FROM mailboxes WHERE id = ${mailboxId}`;

      expect(emailRows.length).toBe(0);
      expect(mailboxRows[0]?.status).toBe("connected");
      expect(mailboxRows[0]?.last_synced_at).toBeInstanceOf(Date);
    } finally {
      await close();
    }
  });

  it("first sync filters fetched messages by received_at cutoff", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "cutoff@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "cutoff-mb@example.com",
      );

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: true, ids: ["too-old", "in-window"] };
      fake.fetchMessagesResult = {
        ok: true,
        messages: [
          {
            providerUid: "too-old",
            fromName: "Old",
            fromAddress: "old@example.com",
            subject: "Old subject",
            body: "Old body",
            receivedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
            seen: false,
          },
          {
            providerUid: "in-window",
            fromName: "New",
            fromAddress: "new@example.com",
            subject: "New subject",
            body: "New body",
            receivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
            seen: false,
          },
        ],
      };

      await syncMailbox(db, vault, fake, mailboxId);

      const emailRows = await db.query`
        SELECT provider_uid FROM mailbox_messages
        WHERE mailbox_id = ${mailboxId}
        ORDER BY provider_uid`;
      const mailboxRows = await db.query`
        SELECT status, last_synced_at FROM mailboxes WHERE id = ${mailboxId}`;

      expect({
        providerUids: emailRows.map((row) => row.provider_uid),
        status: mailboxRows[0]?.status,
        lastSyncedAtSet: mailboxRows[0]?.last_synced_at instanceof Date,
      }).toEqual({
        providerUids: ["in-window"],
        status: "connected",
        lastSyncedAtSet: true,
      });
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

  it("incremental sync filters fetched messages by last_synced_at", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "watermark@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "watermark-mb@example.com",
      );
      const lastSyncedAt = new Date("2026-07-10T12:00:00.000Z");
      await db.query`
        UPDATE mailboxes SET last_synced_at = ${lastSyncedAt}
        WHERE id = ${mailboxId}`;

      const fake = createFakeConnector();
      fake.listMessageIdsResult = {
        ok: true,
        ids: ["before-watermark", "after-watermark"],
      };
      fake.fetchMessagesResult = {
        ok: true,
        messages: [
          {
            providerUid: "before-watermark",
            fromName: "Before",
            fromAddress: "before@example.com",
            subject: "Before subject",
            body: "Before body",
            receivedAt: new Date("2026-07-10T11:59:59.000Z"),
            seen: false,
          },
          {
            providerUid: "after-watermark",
            fromName: "After",
            fromAddress: "after@example.com",
            subject: "After subject",
            body: "After body",
            receivedAt: new Date("2026-07-10T12:00:01.000Z"),
            seen: false,
          },
        ],
      };

      await syncMailbox(db, vault, fake, mailboxId);

      const rows = await db.query`
        SELECT provider_uid FROM mailbox_messages
        WHERE mailbox_id = ${mailboxId}
        ORDER BY provider_uid`;
      expect(rows.map((row) => row.provider_uid)).toEqual(["after-watermark"]);
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
      await insertStoredMessage(db, userId, mailboxId, "already-have");

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
      await insertStoredMessage(db, userId, mailboxId, "existing");

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: true, ids: ["existing"] };
      fake.fetchMessagesResult = { ok: true, messages: [] };

      await syncMailbox(db, vault, fake, mailboxId);

      const rows = await db.query`
        SELECT provider_uid FROM mailbox_messages WHERE mailbox_id = ${mailboxId}`;
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
      await insertStoredMessage(db, userId, mailboxId, "dupe");

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
        SELECT provider_uid FROM mailbox_messages
        WHERE mailbox_id = ${mailboxId} AND provider_uid = ${"dupe"}`;
      expect(rows.length).toBe(1);
    } finally {
      await close();
    }
  });

  it("sets last_synced_at on first sync failure", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "first-failure@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "first-failure-mb@example.com",
      );

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: false, reason: "boom" };

      const attemptStartedAt = new Date();
      const result = await syncMailbox(db, vault, fake, mailboxId);
      const attemptFinishedAt = new Date();

      const rows = await db.query`
        SELECT status, last_synced_at FROM mailboxes WHERE id = ${mailboxId}`;
      const lastSyncedAt = rows[0]?.last_synced_at as Date | null;

      expect({
        resultOk: result.ok,
        status: rows[0]?.status,
        lastSyncedAtSet: lastSyncedAt instanceof Date,
        lastSyncedAtNearAttempt:
          lastSyncedAt instanceof Date &&
          lastSyncedAt.getTime() >= attemptStartedAt.getTime() - 1_000 &&
          lastSyncedAt.getTime() <= attemptFinishedAt.getTime() + 1_000,
      }).toEqual({
        resultOk: false,
        status: "error",
        lastSyncedAtSet: true,
        lastSyncedAtNearAttempt: true,
      });
    } finally {
      await close();
    }
  });

  it("already-synced connector failure sets status='error' and leaves last_synced_at unchanged", async () => {
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

  it("first sync failure does not re-arm as a first sync on the next attempt", async () => {
    // Regression/baseline pin for the "no forever-loop" invariant: a
    // first-attempt connector failure sets last_synced_at (task-3 GREEN), so
    // the next syncMailbox call on that mailbox must NOT be treated as a
    // first sync — the connector must be called WITHOUT the seven-days-ago
    // `opts.since` cutoff. The mailbox is now incremental.
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "first-failure-rearm@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "first-failure-rearm-mb@example.com",
      );

      // First attempt: connector fails. Must mark last_synced_at so the
      // historical window does not get re-armed forever.
      const failingFake = createFakeConnector();
      failingFake.listMessageIdsResult = { ok: false, reason: "boom" };
      const firstResult = await syncMailbox(db, vault, failingFake, mailboxId);
      expect(firstResult.ok).toBe(false);
      const afterFailure = await db.query`
        SELECT status, last_synced_at FROM mailboxes WHERE id = ${mailboxId}`;
      expect(afterFailure[0]?.status).toBe("error");
      expect(afterFailure[0]?.last_synced_at).toBeInstanceOf(Date);

      // Second attempt on the SAME mailbox with a NEW connector instance that
      // succeeds with an empty id list. Because last_synced_at is now set,
      // this is an incremental sync — the connector must NOT receive the
      // seven-days-ago `opts.since` backfill cutoff.
      const okFake = createFakeConnector();
      okFake.listMessageIdsResult = { ok: true, ids: [] };
      await syncMailbox(db, vault, okFake, mailboxId);

      expect(okFake.listMessageIdsCalls.length).toBe(1);
      expect(okFake.listMessageIdsCalls[0]?.opts?.since).toBeUndefined();
    } finally {
      await close();
    }
  });
});
