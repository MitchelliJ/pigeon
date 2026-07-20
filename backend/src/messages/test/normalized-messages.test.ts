/* Integration coverage for canonical messages shared by mailbox occurrences. */
import { describe, expect, it } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { createVault } from "../../vault/index";
import { syncMailbox } from "../../sync/engine";
import { loadCategoryCounts, loadEmailPage } from "../../emails/service";
import {
  enqueueDueClassifyJobs,
  scheduleDailyDigests,
  scheduleImmediateDeliveries,
} from "../../queue/scheduler";
import type { Db } from "../../db/index";
import type { MailboxConnector } from "../../mailboxes/connectors/types";

const VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";

async function insertUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, 'User', 'hash') RETURNING id`;
  return String(rows[0]?.id);
}

async function insertMailbox(
  db: Db,
  userId: string,
  address: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${userId}, 'imap', 'imap', 'Inbox', ${address}, 'imap.example.com',
      993, true, ${address}, ${createVault(VAULT_KEY).seal("password")}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

function connector(
  providerUid: string,
  rfcMessageId?: string,
): MailboxConnector {
  return {
    async testConnection() {
      return { ok: true };
    },
    async listMessageIds() {
      return { ok: true, ids: [providerUid] };
    },
    async fetchMessages() {
      return {
        ok: true,
        messages: [
          {
            providerUid,
            ...(rfcMessageId ? { rfcMessageId } : {}),
            fromName: "Sender",
            fromAddress: " Sender@Example.com ",
            subject: "  Shared   Subject ",
            body: "Exact body",
            receivedAt: new Date("2026-07-20T12:34:56.789Z"),
            seen: false,
          },
        ],
      };
    },
  };
}

async function sync(
  db: Db,
  mailboxId: string,
  providerUid: string,
  rfcMessageId?: string,
): Promise<void> {
  const result = await syncMailbox(
    db,
    createVault(VAULT_KEY),
    connector(providerUid, rfcMessageId),
    mailboxId,
  );
  expect(result).toEqual({ ok: true, inserted: 1 });
}

describe("normalized messages", () => {
  it("converges RFC and fallback duplicates per user while isolating users", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "owner@example.com");
      const first = await insertMailbox(db, userId, "one@example.com");
      const second = await insertMailbox(db, userId, "two@example.com");

      await Promise.all([
        sync(db, first, "uid-one", " <Physical@Example.COM> "),
        sync(db, second, "uid-two", "physical@example.com"),
      ]);

      expect(await db.query`SELECT count(*)::int AS n FROM messages`).toEqual([
        { n: 1 },
      ]);
      expect(
        await db.query`SELECT count(*)::int AS n FROM mailbox_messages`,
      ).toEqual([{ n: 2 }]);

      const otherUser = await insertUser(db, "other@example.com");
      const otherMailbox = await insertMailbox(
        db,
        otherUser,
        "other-box@example.com",
      );
      await sync(db, otherMailbox, "uid-other", "physical@example.com");
      expect(await db.query`SELECT count(*)::int AS n FROM messages`).toEqual([
        { n: 2 },
      ]);

      const fallbackUser = await insertUser(db, "fallback@example.com");
      const fallbackOne = await insertMailbox(
        db,
        fallbackUser,
        "fallback-one@example.com",
      );
      const fallbackTwo = await insertMailbox(
        db,
        fallbackUser,
        "fallback-two@example.com",
      );
      await sync(db, fallbackOne, "fallback-a");
      await sync(db, fallbackTwo, "fallback-b");
      const fallback = await db.query`
        SELECT count(*)::int AS n FROM messages WHERE user_id = ${fallbackUser}`;
      expect(fallback).toEqual([{ n: 1 }]);
    } finally {
      await close();
    }
  });

  it("deduplicates classification, delivery, digest, dashboard, and deletes orphans", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "flows@example.com");
      const first = await insertMailbox(db, userId, "flows-one@example.com");
      const second = await insertMailbox(db, userId, "flows-two@example.com");
      await sync(db, first, "flow-a", "flow@example.com");
      await sync(db, second, "flow-b", "flow@example.com");
      const messageId = String(
        (await db.query`SELECT id FROM messages`)[0]?.id,
      );

      await enqueueDueClassifyJobs(db);
      await enqueueDueClassifyJobs(db);
      expect(
        await db.query`
          SELECT count(*)::int AS n FROM jobs
          WHERE type = 'summarize_classify'
            AND payload->>'messageId' = ${messageId}`,
      ).toEqual([{ n: 1 }]);

      const classifiedAt = new Date("2026-07-20T13:00:00Z");
      await db.query`
        UPDATE messages SET summary = 'Summary', category = 'requires_action',
          classified_at = ${classifiedAt} WHERE id = ${messageId}`;
      const channel = await db.query`
        INSERT INTO channels(user_id, kind, config_encrypted, status, last_tested_at)
        VALUES (${userId}, 'discord', 'sealed', 'active', now()) RETURNING id`;
      await db.query`
        INSERT INTO delivery_settings(
          user_id, mode, digest_time, digest_days, delivery_baseline_at
        ) VALUES (
          ${userId}, 'quiet', '14:00', ARRAY[1,2,3,4,5,6,7]::smallint[],
          ${new Date("2026-07-20T12:00:00Z")}
        )`;

      await scheduleImmediateDeliveries(db, new Date("2026-07-20T13:30:00Z"));
      await scheduleImmediateDeliveries(db, new Date("2026-07-20T13:30:00Z"));
      expect(
        await db.query`
          SELECT count(*)::int AS n FROM delivery_attempts
          WHERE kind = 'immediate' AND message_id = ${messageId}`,
      ).toEqual([{ n: 1 }]);

      await db.query`
        DELETE FROM delivery_attempts WHERE kind = 'immediate'`;
      await db.query`
        UPDATE delivery_settings
        SET mode = 'daily', digest_time = '14:00', timezone = 'UTC'
        WHERE user_id = ${userId}`;
      await scheduleDailyDigests(db, new Date("2026-07-20T14:30:00Z"));
      expect(
        await db.query`SELECT count(*)::int AS n FROM digest_items`,
      ).toEqual([{ n: 1 }]);

      expect(await loadCategoryCounts(db, userId)).toEqual({
        requires_action: 1,
        important: 0,
        noise: 0,
      });
      const page = await loadEmailPage(
        db,
        userId,
        "requires_action",
        undefined,
        10,
      );
      expect(page.emails).toHaveLength(1);
      expect([...(page.emails[0]?.accountIds ?? [])].sort()).toEqual(
        [first, second].sort(),
      );

      await expect(
        db.query`
          INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid)
          VALUES (${first}, ${messageId}, 'another-uid')`,
      ).rejects.toMatchObject({ code: "23505" });

      await db.query`DELETE FROM digest_items`;
      const orphanAttempt = await db.query`
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, message_id, status
        ) VALUES (
          ${userId}, ${channel[0]?.id}, 'immediate', ${messageId}, 'pending'
        ) RETURNING id`;
      await db.query`
        INSERT INTO jobs(type, payload)
        VALUES (
          'deliver_channel',
          jsonb_build_object(
            'deliveryAttemptId', ${String(orphanAttempt[0]?.id)}::text
          )
        )`;

      await db.query`DELETE FROM mailbox_messages WHERE mailbox_id = ${first}`;
      expect(
        await db.query`SELECT id FROM messages WHERE id = ${messageId}`,
      ).toHaveLength(1);
      await db.query`DELETE FROM mailbox_messages WHERE mailbox_id = ${second}`;
      expect(
        await db.query`SELECT id FROM messages WHERE id = ${messageId}`,
      ).toHaveLength(0);
      expect(
        await db.query`
          SELECT id FROM jobs
          WHERE payload->>'deliveryAttemptId' = ${String(orphanAttempt[0]?.id)}`,
      ).toHaveLength(0);
      expect(channel).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
