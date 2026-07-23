/*
 * Integration coverage for daily digest discovery and immutable snapshots.
 * A scheduler tick closes only the latest due UTC slot into a durable attempt,
 * ranked digest items, and one delivery job; successful delivery owns cutoff
 * advancement, not scheduling.
 */
import { describe, expect, it } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import {
  scheduleDailyDigests,
  scheduleQuietTriggeredDigests,
} from "../scheduler";
import type { Db } from "../../db/index";

type DeliveryMode = "daily" | "quiet";
type ChannelStatus = "active" | "error";
type Category = "requires_action" | "important" | "noise";

interface DeliveryOwner {
  userId: string;
  channelId: string | null;
}

interface SeededEmail {
  id: string;
  category: Category;
  summary: string;
}

async function insertUser(
  db: Db,
  suffix: string,
  deletionRequestedAt?: Date | null,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash, tier, deletion_requested_at)
    VALUES (
      ${`${suffix}@example.com`}, 'Digest User', 'hash', 'free',
      ${deletionRequestedAt ?? null}
    )
    RETURNING id
  `;
  return String(rows[0]?.id);
}

async function insertDeliveryOwner(
  db: Db,
  suffix: string,
  options: {
    mode: DeliveryMode;
    digestTime: string;
    digestDays: number[];
    baselineAt: Date;
    cutoffAt?: Date | null;
    channelStatus?: ChannelStatus | null;
    timezone?: string;
    deletionRequestedAt?: Date | null;
  },
): Promise<DeliveryOwner> {
  const userId = await insertUser(db, suffix, options.deletionRequestedAt);
  let channelId: string | null = null;

  if (options.channelStatus !== null) {
    const channelRows = await db.query`
      INSERT INTO channels(
        user_id, kind, config_encrypted, status, last_tested_at
      ) VALUES (
        ${userId}, 'discord', 'sealed-webhook',
        ${options.channelStatus ?? "active"}, ${options.baselineAt}
      )
      RETURNING id
    `;
    channelId = String(channelRows[0]?.id);
  }

  await db.query`
    INSERT INTO delivery_settings(
      user_id, mode, digest_time, digest_days, timezone, delivery_baseline_at,
      last_digest_cutoff_at
    ) VALUES (
      ${userId}, ${options.mode}, ${options.digestTime}::time,
      ${options.digestDays}, ${options.timezone ?? "UTC"},
      ${options.baselineAt}, ${options.cutoffAt ?? null}
    )
  `;

  return { userId, channelId };
}

async function insertMailbox(db: Db, userId: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${userId}, 'imap', 'imap', 'Digest inbox',
      ${`digest-${userId}@example.com`}, 'imap.example.com', 993, true,
      ${`digest-${userId}@example.com`}, 'sealed-password'
    )
    RETURNING id
  `;
  return String(rows[0]?.id);
}

async function insertClassifiedEmail(
  db: Db,
  mailboxId: string,
  input: {
    summary: string;
    category: Category;
    receivedAt: Date;
    classifiedAt: Date;
  },
): Promise<SeededEmail> {
  const rows = await db.query`
    WITH inserted AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body,
        received_at, summary, category, classified_at
      )
      SELECT
        user_id, ${input.summary}, 'Sender', 'sender@example.com', 'Subject',
        'Body', ${input.receivedAt}, ${input.summary}, ${input.category},
        ${input.classifiedAt}
      FROM mailboxes WHERE id = ${mailboxId}
      RETURNING id
    )
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    SELECT ${mailboxId}, id, ${input.summary}, false FROM inserted
    RETURNING message_id
  `;
  return {
    id: String(rows[0]?.message_id),
    category: input.category,
    summary: input.summary,
  };
}

describe("scheduleDailyDigests", () => {
  it("queues one empty catch-up for the latest due UTC slot and filters weekday, mode, and channel eligibility", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const now = new Date("2026-01-12T10:30:00.000Z"); // Monday
      const baselineAt = new Date("2026-01-08T12:00:00.000Z");
      const due = await insertDeliveryOwner(db, "digest-due", {
        mode: "daily",
        digestTime: "08:00",
        digestDays: [1, 2, 3, 4, 5, 6, 7],
        baselineAt,
      });

      await insertDeliveryOwner(db, "digest-wrong-weekday", {
        mode: "daily",
        digestTime: "08:00",
        digestDays: [2],
        baselineAt: new Date("2026-01-12T00:00:00.000Z"),
      });
      await insertDeliveryOwner(db, "digest-not-due-yet", {
        mode: "daily",
        digestTime: "11:00",
        digestDays: [1],
        baselineAt: new Date("2026-01-12T00:00:00.000Z"),
      });
      await insertDeliveryOwner(db, "digest-quiet", {
        mode: "quiet",
        digestTime: "08:00",
        digestDays: [1],
        baselineAt: new Date("2026-01-11T00:00:00.000Z"),
      });
      await insertDeliveryOwner(db, "digest-inactive", {
        mode: "daily",
        digestTime: "08:00",
        digestDays: [1],
        baselineAt: new Date("2026-01-11T00:00:00.000Z"),
        channelStatus: "error",
      });
      await insertDeliveryOwner(db, "digest-no-channel", {
        mode: "daily",
        digestTime: "08:00",
        digestDays: [1],
        baselineAt: new Date("2026-01-11T00:00:00.000Z"),
        channelStatus: null,
      });

      await Promise.all([
        scheduleDailyDigests(db, now),
        scheduleDailyDigests(db, now),
      ]);
      await scheduleDailyDigests(db, now);

      const attempts = await db.query`
        SELECT
          user_id, channel_id, kind, scheduled_for, window_start, window_end,
          status, omitted_count
        FROM delivery_attempts
        WHERE kind = 'digest'
      `;
      const jobs = await db.query`
        SELECT j.type, j.status, da.user_id, da.scheduled_for
        FROM jobs j
        JOIN delivery_attempts da
          ON da.id::text = j.payload->>'deliveryAttemptId'
        WHERE j.type = 'deliver_channel'
      `;
      const itemCount = await db.query`
        SELECT count(*)::int AS count FROM digest_items
      `;
      const settings = await db.query`
        SELECT delivery_baseline_at, last_digest_cutoff_at
        FROM delivery_settings
        WHERE user_id = ${due.userId}
      `;

      expect({ attempts, jobs, itemCount, settings }).toEqual({
        attempts: [
          {
            user_id: due.userId,
            channel_id: due.channelId,
            kind: "digest",
            scheduled_for: new Date("2026-01-12T08:00:00.000Z"),
            window_start: baselineAt,
            window_end: new Date("2026-01-12T08:00:00.000Z"),
            status: "pending",
            omitted_count: 0,
          },
        ],
        jobs: [
          {
            type: "deliver_channel",
            status: "pending",
            user_id: due.userId,
            scheduled_for: new Date("2026-01-12T08:00:00.000Z"),
          },
        ],
        itemCount: [{ count: 0 }],
        settings: [
          {
            delivery_baseline_at: baselineAt,
            last_digest_cutoff_at: null,
          },
        ],
      });
    } finally {
      await close();
    }
  });

  it("skips a fully eligible pending-deletion user while still scheduling the equivalent active user's daily digest", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const now = new Date("2026-01-12T10:30:00.000Z");
      const baselineAt = new Date("2026-01-08T12:00:00.000Z");
      const deletionRequestedAt = new Date("2026-01-11T09:00:00.000Z");
      await insertDeliveryOwner(db, "digest-active-deletion-filter", {
        mode: "daily",
        digestTime: "08:00",
        digestDays: [1, 2, 3, 4, 5, 6, 7],
        baselineAt,
      });
      await insertDeliveryOwner(db, "digest-pending-deletion-filter", {
        mode: "daily",
        digestTime: "08:00",
        digestDays: [1, 2, 3, 4, 5, 6, 7],
        baselineAt,
        deletionRequestedAt,
      });

      await scheduleDailyDigests(db, now);

      const attempts = await db.query`
        SELECT u.email, u.deletion_requested_at, da.kind, da.scheduled_for
        FROM delivery_attempts da
        JOIN users u ON u.id = da.user_id
        WHERE da.kind = 'digest'
        ORDER BY u.email
      `;
      const jobs = await db.query`
        SELECT u.email, j.type, j.status
        FROM jobs j
        JOIN delivery_attempts da
          ON da.id::text = j.payload->>'deliveryAttemptId'
        JOIN users u ON u.id = da.user_id
        WHERE j.type = 'deliver_channel'
        ORDER BY u.email
      `;

      expect({ attempts, jobs }).toEqual({
        attempts: [
          {
            email: "digest-active-deletion-filter@example.com",
            deletion_requested_at: null,
            kind: "digest",
            scheduled_for: new Date("2026-01-12T08:00:00.000Z"),
          },
        ],
        jobs: [
          {
            email: "digest-active-deletion-filter@example.com",
            type: "deliver_channel",
            status: "pending",
          },
        ],
      });
    } finally {
      await close();
    }
  });

  it("schedules Amsterdam wall-clock time with winter and summer DST offsets", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const winter = await insertDeliveryOwner(db, "digest-amsterdam-winter", {
        mode: "daily",
        digestTime: "08:00",
        digestDays: [1],
        timezone: "Europe/Amsterdam",
        baselineAt: new Date("2026-01-11T00:00:00.000Z"),
      });

      await scheduleDailyDigests(db, new Date("2026-01-12T07:05:00.000Z"));
      await db.query`
        UPDATE channels SET status = 'error' WHERE id = ${winter.channelId}
      `;

      await insertDeliveryOwner(db, "digest-amsterdam-summer", {
        mode: "daily",
        digestTime: "08:00",
        digestDays: [1],
        timezone: "Europe/Amsterdam",
        baselineAt: new Date("2026-07-12T00:00:00.000Z"),
      });
      await scheduleDailyDigests(db, new Date("2026-07-13T06:05:00.000Z"));

      const attempts = await db.query`
        SELECT u.email, da.scheduled_for
        FROM delivery_attempts da
        JOIN users u ON u.id = da.user_id
        WHERE da.kind = 'digest'
        ORDER BY u.email
      `;
      expect(attempts).toEqual([
        {
          email: "digest-amsterdam-summer@example.com",
          scheduled_for: new Date("2026-07-13T06:00:00.000Z"),
        },
        {
          email: "digest-amsterdam-winter@example.com",
          scheduled_for: new Date("2026-01-12T07:00:00.000Z"),
        },
      ]);
    } finally {
      await close();
    }
  });

  it("skips a fully eligible pending-deletion user while still scheduling the equivalent active user's quiet-triggered digest", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const now = new Date("2026-01-14T08:05:00.000Z");
      const baselineAt = new Date("2026-01-10T00:00:00.000Z");
      const classifiedAt = new Date("2026-01-14T08:00:00.000Z");
      const deletionRequestedAt = new Date("2026-01-13T09:00:00.000Z");
      const active = await insertDeliveryOwner(
        db,
        "quiet-active-deletion-filter",
        {
          mode: "quiet",
          digestTime: "08:00",
          digestDays: [1, 2, 3, 4, 5, 6, 7],
          baselineAt,
        },
      );
      const pendingDeletion = await insertDeliveryOwner(
        db,
        "quiet-pending-deletion-filter",
        {
          mode: "quiet",
          digestTime: "08:00",
          digestDays: [1, 2, 3, 4, 5, 6, 7],
          baselineAt,
          deletionRequestedAt,
        },
      );
      const activeMailboxId = await insertMailbox(db, active.userId);
      const pendingDeletionMailboxId = await insertMailbox(
        db,
        pendingDeletion.userId,
      );
      await insertClassifiedEmail(db, activeMailboxId, {
        summary: "active trigger",
        category: "requires_action",
        receivedAt: new Date("2026-01-14T07:55:00.000Z"),
        classifiedAt,
      });
      await insertClassifiedEmail(db, pendingDeletionMailboxId, {
        summary: "pending deletion trigger",
        category: "requires_action",
        receivedAt: new Date("2026-01-14T07:55:00.000Z"),
        classifiedAt,
      });

      await scheduleQuietTriggeredDigests(db, now);

      const attempts = await db.query`
        SELECT u.email, u.deletion_requested_at, da.kind, da.message_id, da.scheduled_for
        FROM delivery_attempts da
        JOIN users u ON u.id = da.user_id
        WHERE da.kind = 'digest'
        ORDER BY u.email
      `;
      const jobs = await db.query`
        SELECT u.email, j.type, j.status
        FROM jobs j
        JOIN delivery_attempts da
          ON da.id::text = j.payload->>'deliveryAttemptId'
        JOIN users u ON u.id = da.user_id
        WHERE j.type = 'deliver_channel'
        ORDER BY u.email
      `;

      expect({ attempts, jobs }).toEqual({
        attempts: [
          {
            email: "quiet-active-deletion-filter@example.com",
            deletion_requested_at: null,
            kind: "digest",
            message_id: expect.any(String),
            scheduled_for: now,
          },
        ],
        jobs: [
          {
            email: "quiet-active-deletion-filter@example.com",
            type: "deliver_channel",
            status: "pending",
          },
        ],
      });
    } finally {
      await close();
    }
  });

  it("snapshots ranked window-eligible emails in stable positions with a 25-item cap and overflow count", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const baselineAt = new Date("2026-01-10T00:00:00.000Z");
      const cutoffAt = new Date("2026-01-13T08:00:00.000Z");
      const scheduledFor = new Date("2026-01-14T08:00:00.000Z"); // Wednesday
      const owner = await insertDeliveryOwner(db, "digest-ranked", {
        mode: "daily",
        digestTime: "08:00",
        digestDays: [3],
        baselineAt,
        cutoffAt,
      });
      const mailboxId = await insertMailbox(db, owner.userId);
      const classifiedAt = new Date("2026-01-13T12:00:00.000Z");

      const actionNew = await insertClassifiedEmail(db, mailboxId, {
        summary: "action-new",
        category: "requires_action",
        receivedAt: new Date("2026-01-14T06:00:00.000Z"),
        classifiedAt: scheduledFor,
      });
      const actionOld = await insertClassifiedEmail(db, mailboxId, {
        summary: "action-old",
        category: "requires_action",
        receivedAt: new Date("2026-01-14T05:00:00.000Z"),
        classifiedAt,
      });
      const importantNew = await insertClassifiedEmail(db, mailboxId, {
        summary: "important-new",
        category: "important",
        receivedAt: new Date("2026-01-14T07:30:00.000Z"),
        classifiedAt,
      });
      const importantOld = await insertClassifiedEmail(db, mailboxId, {
        summary: "important-old",
        category: "important",
        receivedAt: new Date("2026-01-14T07:00:00.000Z"),
        classifiedAt,
      });
      const noise: SeededEmail[] = [];
      for (let index = 0; index < 23; index += 1) {
        noise.push(
          await insertClassifiedEmail(db, mailboxId, {
            summary: `noise-${String(index).padStart(2, "0")}`,
            category: "noise",
            receivedAt: new Date(
              new Date("2026-01-14T04:00:00.000Z").getTime() - index * 60_000,
            ),
            classifiedAt,
          }),
        );
      }

      await insertClassifiedEmail(db, mailboxId, {
        summary: "classified-at-open-boundary",
        category: "requires_action",
        receivedAt: new Date("2026-01-14T07:00:00.000Z"),
        classifiedAt: cutoffAt,
      });
      await insertClassifiedEmail(db, mailboxId, {
        summary: "classified-after-slot",
        category: "requires_action",
        receivedAt: new Date("2026-01-14T07:00:00.000Z"),
        classifiedAt: new Date("2026-01-14T08:00:00.001Z"),
      });
      await insertClassifiedEmail(db, mailboxId, {
        summary: "received-before-baseline",
        category: "requires_action",
        receivedAt: new Date("2026-01-09T23:59:59.999Z"),
        classifiedAt,
      });

      await scheduleDailyDigests(db, new Date("2026-01-14T08:05:00.000Z"));
      await db.query`
        UPDATE messages
        SET summary = 'mutated after scheduling', category = 'noise'
        WHERE id = ${actionNew.id}
      `;

      const attempts = await db.query`
        SELECT
          kind, scheduled_for, window_start, window_end, status, omitted_count
        FROM delivery_attempts
        WHERE user_id = ${owner.userId} AND kind = 'digest'
      `;
      const items = await db.query`
        SELECT di.message_id, di.position, di.category, di.summary
        FROM digest_items di
        JOIN delivery_attempts da ON da.id = di.delivery_attempt_id
        WHERE da.user_id = ${owner.userId}
        ORDER BY di.position
      `;
      const jobs = await db.query`
        SELECT j.type, j.status
        FROM jobs j
        JOIN delivery_attempts da
          ON da.id::text = j.payload->>'deliveryAttemptId'
        WHERE da.user_id = ${owner.userId}
      `;
      const settings = await db.query`
        SELECT delivery_baseline_at, last_digest_cutoff_at
        FROM delivery_settings
        WHERE user_id = ${owner.userId}
      `;
      const selected = [
        actionNew,
        actionOld,
        importantNew,
        importantOld,
        ...noise.slice(0, 21),
      ];

      expect({ attempts, items, jobs, settings }).toEqual({
        attempts: [
          {
            kind: "digest",
            scheduled_for: scheduledFor,
            window_start: cutoffAt,
            window_end: scheduledFor,
            status: "pending",
            omitted_count: 2,
          },
        ],
        items: selected.map((email, index) => ({
          message_id: email.id,
          position: index + 1,
          category: email.category,
          summary: email.summary,
        })),
        jobs: [{ type: "deliver_channel", status: "pending" }],
        settings: [
          {
            delivery_baseline_at: baselineAt,
            last_digest_cutoff_at: cutoffAt,
          },
        ],
      });
    } finally {
      await close();
    }
  });
});
