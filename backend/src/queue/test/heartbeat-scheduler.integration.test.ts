/* Integration coverage for quiet-mode heartbeat slot discovery and suppression. */
import { describe, expect, it } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { scheduleQuietHeartbeats } from "../scheduler";
import type { Db } from "../../db/index";

type DeliveryMode = "daily" | "quiet";
type ChannelStatus = "active" | "error";
type AttemptStatus = "pending" | "sent" | "failed";

interface Owner {
  userId: string;
  channelId: string;
}

async function insertOwner(
  db: Db,
  suffix: string,
  options: {
    mode?: DeliveryMode;
    channelStatus?: ChannelStatus;
    digestTime?: string;
    digestDays?: number[];
    timezone?: string;
    baselineAt: Date;
  },
): Promise<Owner> {
  const userRows = await db.query`
    INSERT INTO users(email, name, password_hash, tier)
    VALUES (${`${suffix}@example.com`}, 'Heartbeat User', 'hash', 'free')
    RETURNING id
  `;
  const userId = String(userRows[0]?.id);
  const channelRows = await db.query`
    INSERT INTO channels(
      user_id, kind, config_encrypted, status, last_tested_at
    ) VALUES (
      ${userId}, 'discord', 'sealed-webhook',
      ${options.channelStatus ?? "active"}, ${options.baselineAt}
    )
    RETURNING id
  `;
  const channelId = String(channelRows[0]?.id);

  await db.query`
    INSERT INTO delivery_settings(
      user_id, mode, digest_time, digest_days, timezone, delivery_baseline_at
    ) VALUES (
      ${userId}, ${options.mode ?? "quiet"},
      ${options.digestTime ?? "08:00"}::time,
      ${options.digestDays ?? [1, 2, 3, 4, 5, 6, 7]},
      ${options.timezone ?? "UTC"}, ${options.baselineAt}
    )
  `;

  return { userId, channelId };
}

async function insertImmediateAttempt(
  db: Db,
  owner: Owner,
  suffix: string,
  status: AttemptStatus,
  sentAt: Date | null,
): Promise<void> {
  const mailboxRows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${owner.userId}, 'imap', 'imap', 'Heartbeat inbox',
      ${`${suffix}@example.com`}, 'imap.example.com', 993, true,
      ${`${suffix}@example.com`}, 'sealed-password'
    )
    RETURNING id
  `;
  const messageRows = await db.query`
    INSERT INTO messages(
      user_id, identity_key, from_name, from_address, subject, body, received_at
    ) VALUES (
      ${owner.userId}, ${`test:${suffix}`}, 'Sender', 'sender@example.com',
      'Subject', 'Body', ${new Date("2026-01-11T09:00:00Z")}
    )
    RETURNING id
  `;
  const messageId = String(messageRows[0]?.id);
  await db.query`
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    VALUES (${String(mailboxRows[0]?.id)}, ${messageId}, ${suffix}, false)
  `;
  await db.query`
    INSERT INTO delivery_attempts(
      user_id, channel_id, kind, message_id, status, sent_at
    ) VALUES (
      ${owner.userId}, ${owner.channelId}, 'immediate',
      ${messageId}, ${status}, ${sentAt}
    )
  `;
}

describe("scheduleQuietHeartbeats", () => {
  it("schedules quiet heartbeats for Monday at 08:00 local regardless of digest settings", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const now = new Date("2026-01-12T09:00:00.000Z"); // Monday 10:00 in Amsterdam
      await insertOwner(db, "heartbeat-fixed-slot", {
        baselineAt: new Date("2025-12-01T00:00:00.000Z"),
        digestTime: "17:45",
        digestDays: [5],
        timezone: "Europe/Amsterdam",
      });

      await scheduleQuietHeartbeats(db, now);

      const attempts = await db.query`
        SELECT scheduled_for
        FROM delivery_attempts
        WHERE kind = 'heartbeat'
      `;
      expect(attempts).toEqual([
        { scheduled_for: new Date("2026-01-12T07:00:00.000Z") },
      ]);
    } finally {
      await close();
    }
  });

  it("queues only the latest eligible UTC slot with the effective previous-slot baseline and deduplicates concurrent ticks", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const now = new Date("2026-01-12T10:30:00.000Z"); // Monday
      const scheduledFor = new Date("2026-01-12T08:00:00.000Z");
      const previousSlotOwner = await insertOwner(db, "heartbeat-previous", {
        baselineAt: new Date("2026-01-08T12:00:00.000Z"),
        digestDays: [1, 5],
      });
      const baselineAt = new Date("2026-01-10T00:00:00.000Z");
      const baselineOwner = await insertOwner(db, "heartbeat-baseline", {
        baselineAt,
        digestDays: [1, 5],
      });
      await insertOwner(db, "heartbeat-daily", {
        mode: "daily",
        baselineAt: new Date("2026-01-08T00:00:00.000Z"),
      });
      await insertOwner(db, "heartbeat-inactive", {
        channelStatus: "error",
        baselineAt: new Date("2026-01-08T00:00:00.000Z"),
      });
      await insertOwner(db, "heartbeat-at-baseline", {
        baselineAt: scheduledFor,
        digestDays: [1],
      });

      await Promise.all([
        scheduleQuietHeartbeats(db, now),
        scheduleQuietHeartbeats(db, now),
      ]);
      await scheduleQuietHeartbeats(db, now);

      const attempts = await db.query`
        SELECT
          u.email, da.channel_id, da.kind, da.scheduled_for,
          da.window_start, da.window_end, da.status
        FROM delivery_attempts da
        JOIN users u ON u.id = da.user_id
        WHERE da.kind = 'heartbeat'
        ORDER BY u.email
      `;
      const jobs = await db.query`
        SELECT u.email, j.type, j.status
        FROM jobs j
        JOIN delivery_attempts da
          ON da.id::text = j.payload->>'deliveryAttemptId'
        JOIN users u ON u.id = da.user_id
        WHERE da.kind = 'heartbeat'
        ORDER BY u.email
      `;

      expect({ attempts, jobs }).toEqual({
        attempts: [
          {
            email: "heartbeat-baseline@example.com",
            channel_id: baselineOwner.channelId,
            kind: "heartbeat",
            scheduled_for: scheduledFor,
            window_start: baselineAt,
            window_end: scheduledFor,
            status: "pending",
          },
          {
            email: "heartbeat-previous@example.com",
            channel_id: previousSlotOwner.channelId,
            kind: "heartbeat",
            scheduled_for: scheduledFor,
            window_start: new Date("2026-01-08T12:00:00.000Z"),
            window_end: scheduledFor,
            status: "pending",
          },
        ],
        jobs: [
          {
            email: "heartbeat-baseline@example.com",
            type: "deliver_channel",
            status: "pending",
          },
          {
            email: "heartbeat-previous@example.com",
            type: "deliver_channel",
            status: "pending",
          },
        ],
      });
    } finally {
      await close();
    }
  });

  it("suppresses a heartbeat only for legacy immediate-delivery history inside the heartbeat window", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const now = new Date("2026-01-12T10:00:00.000Z");
      const baselineAt = new Date("2026-01-10T00:00:00.000Z");
      const windowStart = new Date("2026-01-05T08:00:00.000Z");
      const suppressed = await insertOwner(db, "heartbeat-suppressed", {
        baselineAt,
      });
      await insertImmediateAttempt(
        db,
        suppressed,
        "suppressed-sent",
        "sent",
        new Date("2026-01-11T12:00:00.000Z"),
      );

      const pendingAndFailed = await insertOwner(db, "heartbeat-retry-states", {
        baselineAt,
      });
      await insertImmediateAttempt(
        db,
        pendingAndFailed,
        "retry-pending",
        "pending",
        null,
      );
      await insertImmediateAttempt(
        db,
        pendingAndFailed,
        "retry-failed",
        "failed",
        null,
      );

      const boundary = await insertOwner(db, "heartbeat-boundary", {
        baselineAt,
      });
      await insertImmediateAttempt(
        db,
        boundary,
        "boundary-sent",
        "sent",
        windowStart,
      );
      const future = await insertOwner(db, "heartbeat-future", { baselineAt });
      await insertImmediateAttempt(
        db,
        future,
        "future-sent",
        "sent",
        new Date("2026-01-12T10:00:00.001Z"),
      );

      await scheduleQuietHeartbeats(db, now);

      const rows = await db.query`
        SELECT u.email, count(j.id)::int AS job_count
        FROM delivery_attempts da
        JOIN users u ON u.id = da.user_id
        LEFT JOIN jobs j
          ON da.id::text = j.payload->>'deliveryAttemptId'
         AND j.type = 'deliver_channel'
        WHERE da.kind = 'heartbeat'
        GROUP BY u.email
        ORDER BY u.email
      `;
      expect(rows).toEqual([
        { email: "heartbeat-boundary@example.com", job_count: 1 },
        { email: "heartbeat-future@example.com", job_count: 1 },
        { email: "heartbeat-retry-states@example.com", job_count: 1 },
      ]);
    } finally {
      await close();
    }
  });

  it("quiet-triggered digest suppresses heartbeat", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const now = new Date("2026-01-12T10:00:00.000Z");
      const owner = await insertOwner(db, "heartbeat-triggered-digest", {
        baselineAt: new Date("2026-01-10T00:00:00.000Z"),
      });
      const messageRows = await db.query`
        INSERT INTO messages(
          user_id, identity_key, from_name, from_address, subject, body,
          received_at
        ) VALUES (
          ${owner.userId}, 'test:heartbeat-triggered-digest', 'Sender',
          'sender@example.com', 'Subject', 'Body',
          ${new Date("2026-01-11T11:00:00.000Z")}
        )
        RETURNING id
      `;
      const triggerMessageId = String(messageRows[0]?.id);
      await db.query`
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, message_id, scheduled_for, window_start,
          window_end, status, sent_at
        ) VALUES (
          ${owner.userId}, ${owner.channelId}, 'digest', ${triggerMessageId},
          ${new Date("2026-01-11T12:00:00.000Z")},
          ${new Date("2026-01-10T00:00:00.000Z")},
          ${new Date("2026-01-11T12:00:00.000Z")}, 'sent',
          ${new Date("2026-01-11T12:00:00.000Z")}
        )
      `;

      await scheduleQuietHeartbeats(db, now);

      const rows = await db.query`
        SELECT
          count(DISTINCT da.id)::int AS attempt_count,
          count(DISTINCT j.id)::int AS job_count
        FROM delivery_attempts da
        LEFT JOIN jobs j
          ON da.id::text = j.payload->>'deliveryAttemptId'
         AND j.type = 'deliver_channel'
        WHERE da.user_id = ${owner.userId}
          AND da.kind = 'heartbeat'
      `;
      expect(rows).toEqual([{ attempt_count: 0, job_count: 0 }]);
    } finally {
      await close();
    }
  });
});
