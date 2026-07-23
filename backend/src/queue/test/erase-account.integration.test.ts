/*
 * Integration coverage for account-erasure scheduling and stale erase-account
 * job scrubbing against the real jobs table and migrations.
 */
import { describe, expect, it } from "vitest";
import { withTestDb } from "../../../test/db";
import type { Db } from "../../db/index";
import { runMigrations } from "../../migrate/runner";
import { handleEraseAccountJob } from "../handlers/erase-account";
import { enqueueDueAccountErasures } from "../scheduler";

async function insertUser(
  db: Db,
  email: string,
  deletionRequestedAt: Date | null,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash, tier, deletion_requested_at)
    VALUES (${email}, 'Erase User', 'hash', 'free', ${deletionRequestedAt})
    RETURNING id
  `;
  return String(rows[0]?.id);
}

async function insertEraseAccountJob(db: Db, userId: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO jobs(type, payload, status)
    VALUES ('erase_account', ${{ userId }}, 'pending')
    RETURNING id
  `;
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
      ${userId}, 'imap', 'imap', 'Inbox', ${address}, 'imap.example.com', 993,
      true, ${address}, 'sealed-password'
    )
    RETURNING id
  `;
  return String(rows[0]?.id);
}

async function insertMessage(db: Db, mailboxId: string): Promise<string> {
  const rows = await db.query`
    WITH inserted AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body,
        received_at, summary, category, classified_at
      )
      SELECT
        user_id,
        ${mailboxId},
        'Sender',
        'sender@example.com',
        'Subject',
        'Body',
        now(),
        'Summary',
        'important',
        now()
      FROM mailboxes
      WHERE id = ${mailboxId}
      RETURNING id
    )
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    SELECT ${mailboxId}, id, ${mailboxId}, false FROM inserted
    RETURNING message_id
  `;
  return String(rows[0]?.message_id);
}

async function insertChannel(db: Db, userId: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO channels(
      user_id, kind, config_encrypted, status, last_tested_at
    ) VALUES (
      ${userId}, 'discord', 'sealed-webhook', 'active', now()
    )
    RETURNING id
  `;
  return String(rows[0]?.id);
}

describe("enqueueDueAccountErasures", () => {
  it("enqueues exactly one in-flight erase_account job only for a due user across repeated scheduler calls", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const now = Date.now();
      const dueDeletionRequestedAt = new Date(
        now - 24 * 60 * 60 * 1000 - 60 * 1000,
      );
      const notDueDeletionRequestedAt = new Date(
        now - 24 * 60 * 60 * 1000 + 60 * 1000,
      );

      const dueUserId = await insertUser(
        db,
        "erase-due@example.com",
        dueDeletionRequestedAt,
      );
      await insertUser(
        db,
        "erase-not-due@example.com",
        notDueDeletionRequestedAt,
      );

      await enqueueDueAccountErasures(db);
      await enqueueDueAccountErasures(db);
      await enqueueDueAccountErasures(db);

      const jobs = await db.query`
        SELECT type, status, payload
        FROM jobs
        WHERE type = 'erase_account'
        ORDER BY payload->>'userId'
      `;

      expect(jobs).toEqual([
        {
          type: "erase_account",
          status: "pending",
          payload: { userId: dueUserId },
        },
      ]);
    } finally {
      await close();
    }
  });

  it("handleEraseAccountJob scrubs stale cancelled and not-yet-due jobs without deleting account data", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const cancelledUserId = await insertUser(
        db,
        "erase-cancelled@example.com",
        null,
      );
      const notDueUserId = await insertUser(
        db,
        "erase-not-due-stale@example.com",
        new Date(Date.now() - 60 * 60 * 1000),
      );

      await db.query`
        INSERT INTO sessions(user_id, token_hash, expires_at)
        VALUES
          (${cancelledUserId}, ${"cancelled-session"}, now() + interval '1 day'),
          (${notDueUserId}, ${"not-due-session"}, now() + interval '1 day')
      `;
      await db.query`
        INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at)
        VALUES
          (
            ${cancelledUserId},
            'change_email',
            ${"cancelled-token"},
            now() + interval '1 day'
          ),
          (
            ${notDueUserId},
            'change_email',
            ${"not-due-token"},
            now() + interval '1 day'
          )
      `;

      const cancelledJobId = await insertEraseAccountJob(db, cancelledUserId);
      const notDueJobId = await insertEraseAccountJob(db, notDueUserId);

      await handleEraseAccountJob(db, cancelledJobId, {
        userId: cancelledUserId,
      });
      await handleEraseAccountJob(db, notDueJobId, {
        userId: notDueUserId,
      });

      const state = await db.query`
        SELECT
          u.email,
          EXISTS (SELECT 1 FROM users WHERE id = u.id) AS user_exists,
          EXISTS (SELECT 1 FROM sessions WHERE user_id = u.id) AS session_exists,
          EXISTS (
            SELECT 1
            FROM auth_tokens
            WHERE user_id = u.id AND kind = 'change_email'
          ) AS auth_token_exists,
          (
            SELECT payload
            FROM jobs
            WHERE id = ${cancelledJobId}
              AND u.id = ${cancelledUserId}
          ) AS cancelled_job_payload,
          (
            SELECT payload
            FROM jobs
            WHERE id = ${notDueJobId}
              AND u.id = ${notDueUserId}
          ) AS not_due_job_payload
        FROM users u
        WHERE u.id IN (${cancelledUserId}, ${notDueUserId})
        ORDER BY u.email
      `;

      expect(state).toEqual([
        {
          email: "erase-cancelled@example.com",
          user_exists: true,
          session_exists: true,
          auth_token_exists: true,
          cancelled_job_payload: {},
          not_due_job_payload: null,
        },
        {
          email: "erase-not-due-stale@example.com",
          user_exists: true,
          session_exists: true,
          auth_token_exists: true,
          cancelled_job_payload: null,
          not_due_job_payload: {},
        },
      ]);
    } finally {
      await close();
    }
  });

  it("handleEraseAccountJob deletes a due account via FK cascades while preserving invite history and scrubbing the erase job payload", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const targetUserId = await insertUser(
        db,
        "erase-target@example.com",
        new Date(Date.now() - 25 * 60 * 60 * 1000),
      );
      const controlUserId = await insertUser(
        db,
        "erase-control@example.com",
        null,
      );

      await db.query`
        INSERT INTO sessions(user_id, token_hash, expires_at)
        VALUES
          (${targetUserId}, 'target-session', now() + interval '1 day'),
          (${controlUserId}, 'control-session', now() + interval '1 day')
      `;
      await db.query`
        INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at)
        VALUES
          (${targetUserId}, 'change_email', 'target-token', now() + interval '1 day'),
          (${controlUserId}, 'change_email', 'control-token', now() + interval '1 day')
      `;

      const targetMailboxId = await insertMailbox(
        db,
        targetUserId,
        "target-mailbox@example.com",
      );
      const controlMailboxId = await insertMailbox(
        db,
        controlUserId,
        "control-mailbox@example.com",
      );
      const targetMessageId = await insertMessage(db, targetMailboxId);
      const controlMessageId = await insertMessage(db, controlMailboxId);
      const targetChannelId = await insertChannel(db, targetUserId);
      const controlChannelId = await insertChannel(db, controlUserId);

      await db.query`
        INSERT INTO delivery_settings(user_id, mode, delivery_baseline_at)
        VALUES
          (${targetUserId}, 'daily', now() - interval '1 day'),
          (${controlUserId}, 'daily', now() - interval '1 day')
      `;

      await db.query`
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, message_id, status
        ) VALUES (
          ${targetUserId}, ${targetChannelId}, 'immediate', ${targetMessageId}, 'pending'
        )
      `;
      const targetDigestAttemptRows = await db.query`
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, message_id, scheduled_for, window_start,
          window_end, status
        ) VALUES (
          ${targetUserId},
          ${targetChannelId},
          'digest',
          ${targetMessageId},
          now() + interval '1 hour',
          now() - interval '1 hour',
          now() + interval '1 hour',
          'pending'
        )
        RETURNING id
      `;
      const controlDigestAttemptRows = await db.query`
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, message_id, scheduled_for, window_start,
          window_end, status
        ) VALUES (
          ${controlUserId},
          ${controlChannelId},
          'digest',
          ${controlMessageId},
          now() + interval '1 hour',
          now() - interval '1 hour',
          now() + interval '1 hour',
          'pending'
        )
        RETURNING id
      `;

      const targetDigestAttemptId = String(targetDigestAttemptRows[0]?.id);
      const controlDigestAttemptId = String(controlDigestAttemptRows[0]?.id);

      await db.query`
        INSERT INTO digest_items(
          delivery_attempt_id, message_id, position, category, summary
        ) VALUES
          (${targetDigestAttemptId}, ${targetMessageId}, 1, 'important', 'Target digest item'),
          (${controlDigestAttemptId}, ${controlMessageId}, 1, 'important', 'Control digest item')
      `;

      const inviteRows = await db.query`
        INSERT INTO invites(code_hash, created_by_user_id)
        VALUES ('target-invite', ${targetUserId})
        RETURNING id
      `;
      const inviteId = String(inviteRows[0]?.id);
      const eraseJobId = await insertEraseAccountJob(db, targetUserId);

      await handleEraseAccountJob(db, eraseJobId, { userId: targetUserId });

      const stateRows = await db.query`
        SELECT
          NOT EXISTS (SELECT 1 FROM users WHERE id = ${targetUserId}) AS target_user_gone,
          (SELECT count(*)::int FROM sessions WHERE user_id = ${targetUserId}) AS target_session_count,
          (SELECT count(*)::int FROM auth_tokens WHERE user_id = ${targetUserId}) AS target_auth_token_count,
          (SELECT count(*)::int FROM mailboxes WHERE user_id = ${targetUserId}) AS target_mailbox_count,
          (SELECT count(*)::int FROM messages WHERE user_id = ${targetUserId}) AS target_message_count,
          (
            SELECT count(*)::int
            FROM mailbox_messages
            WHERE mailbox_id = ${targetMailboxId}
          ) AS target_mailbox_message_count,
          (SELECT count(*)::int FROM channels WHERE user_id = ${targetUserId}) AS target_channel_count,
          (
            SELECT count(*)::int
            FROM delivery_settings
            WHERE user_id = ${targetUserId}
          ) AS target_delivery_settings_count,
          (
            SELECT count(*)::int
            FROM delivery_attempts
            WHERE user_id = ${targetUserId}
          ) AS target_delivery_attempt_count,
          (
            SELECT count(*)::int
            FROM digest_items
            WHERE delivery_attempt_id = ${targetDigestAttemptId}
          ) AS target_digest_item_count,
          EXISTS (SELECT 1 FROM users WHERE id = ${controlUserId}) AS control_user_exists,
          (SELECT count(*)::int FROM sessions WHERE user_id = ${controlUserId}) AS control_session_count,
          (SELECT count(*)::int FROM auth_tokens WHERE user_id = ${controlUserId}) AS control_auth_token_count,
          (SELECT count(*)::int FROM mailboxes WHERE user_id = ${controlUserId}) AS control_mailbox_count,
          (SELECT count(*)::int FROM messages WHERE user_id = ${controlUserId}) AS control_message_count,
          (
            SELECT count(*)::int
            FROM mailbox_messages
            WHERE mailbox_id = ${controlMailboxId}
          ) AS control_mailbox_message_count,
          (SELECT count(*)::int FROM channels WHERE user_id = ${controlUserId}) AS control_channel_count,
          (
            SELECT count(*)::int
            FROM delivery_settings
            WHERE user_id = ${controlUserId}
          ) AS control_delivery_settings_count,
          (
            SELECT count(*)::int
            FROM delivery_attempts
            WHERE user_id = ${controlUserId}
          ) AS control_delivery_attempt_count,
          (
            SELECT count(*)::int
            FROM digest_items
            WHERE delivery_attempt_id = ${controlDigestAttemptId}
          ) AS control_digest_item_count,
          (
            SELECT created_by_user_id IS NULL
            FROM invites
            WHERE id = ${inviteId}
          ) AS invite_creator_cleared,
          (SELECT payload FROM jobs WHERE id = ${eraseJobId}) AS erase_job_payload
      `;

      expect(stateRows).toEqual([
        {
          target_user_gone: true,
          target_session_count: 0,
          target_auth_token_count: 0,
          target_mailbox_count: 0,
          target_message_count: 0,
          target_mailbox_message_count: 0,
          target_channel_count: 0,
          target_delivery_settings_count: 0,
          target_delivery_attempt_count: 0,
          target_digest_item_count: 0,
          control_user_exists: true,
          control_session_count: 1,
          control_auth_token_count: 1,
          control_mailbox_count: 1,
          control_message_count: 1,
          control_mailbox_message_count: 1,
          control_channel_count: 1,
          control_delivery_settings_count: 1,
          control_delivery_attempt_count: 1,
          control_digest_item_count: 1,
          invite_creator_cleared: true,
          erase_job_payload: {},
        },
      ]);
    } finally {
      await close();
    }
  });
});
