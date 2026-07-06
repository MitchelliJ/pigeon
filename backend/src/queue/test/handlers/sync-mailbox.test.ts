/*
 * Integration tests for `handleSyncMailboxJob` (Job Queue, Workers &
 * Scheduler PRD §3.2, FR-6). This handler is a thin wrapper around
 * `syncMailbox` (Feature 4's `../../sync/engine`): it loads the mailbox's
 * `protocol`, resolves a connector via an injectable `getConnectorFn` (same
 * pattern as `../../mailboxes/routes.ts`'s `getConnectorFn` param), delegates
 * to the real `syncMailbox`, and — since `syncMailbox` itself never throws —
 * must throw when the result comes back `{ ok: false, reason }`, so a later
 * job-dispatch layer has something to catch and route to `failJob`.
 *
 * Reuses the exact fake `MailboxConnector` + seeding pattern from
 * `../../sync/test/engine.test.ts` (`createFakeConnector`, `insertUser`,
 * `insertMailbox`, `createVault(TEST_VAULT_KEY)`) — no real IMAP/POP3 socket
 * here, and the real `getConnector` is never touched.
 *
 * RED note: at authoring time `../../handlers/sync-mailbox`
 * (`handleSyncMailboxJob`) does not exist yet — this file is expected to fail
 * at import/module-resolution time, not just at an assertion.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../../test/db";
import { runMigrations } from "../../../migrate/runner";
import { createVault } from "../../../vault/index";
import { handleSyncMailboxJob } from "../../handlers/sync-mailbox";
import type { Db } from "../../../db/index";
import type { Vault } from "../../../vault/index";
import type {
  MailboxConnector,
  ListMessageIdsResult,
  FetchMessagesResult,
  TestConnectionParams,
} from "../../../mailboxes/connectors/types";

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

interface FakeConnector extends MailboxConnector {
  listMessageIdsResult: ListMessageIdsResult;
  fetchMessagesResult: FetchMessagesResult;
}

function createFakeConnector(): FakeConnector {
  const fake: FakeConnector = {
    listMessageIdsResult: { ok: true, ids: [] },
    fetchMessagesResult: { ok: true, messages: [] },
    async testConnection(_params: TestConnectionParams) {
      return { ok: true };
    },
    async listMessageIds(_params: TestConnectionParams, _opts) {
      return fake.listMessageIdsResult;
    },
    async fetchMessages(_params: TestConnectionParams, _ids, _opts) {
      return fake.fetchMessagesResult;
    },
  };
  return fake;
}

describe("handleSyncMailboxJob", () => {
  it("delegates to the real syncMailbox and resolves without throwing when the connector succeeds, inserting the new message", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "job-success@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "job-success-mb@example.com",
      );

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: true, ids: ["only-id"] };
      fake.fetchMessagesResult = {
        ok: true,
        messages: [
          {
            providerUid: "only-id",
            fromName: "Alice",
            fromAddress: "alice@example.com",
            subject: "Hello",
            body: "Body",
            receivedAt: new Date("2026-07-01T00:00:00Z"),
            seen: false,
          },
        ],
      };

      await expect(
        handleSyncMailboxJob(db, vault, { mailboxId }, () => fake),
      ).resolves.toBeUndefined();

      const rows = await db.query`
        SELECT provider_uid FROM emails WHERE mailbox_id = ${mailboxId}`;
      expect(rows.length).toBe(1);
      expect(rows[0]?.provider_uid).toBe("only-id");
    } finally {
      await close();
    }
  });

  it("throws with the connector's failure reason when syncMailbox reports ok: false", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "job-failure@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "job-failure-mb@example.com",
      );

      const fake = createFakeConnector();
      fake.listMessageIdsResult = { ok: false, reason: "boom" };

      await expect(
        handleSyncMailboxJob(db, vault, { mailboxId }, () => fake),
      ).rejects.toThrow("boom");
    } finally {
      await close();
    }
  });
});
