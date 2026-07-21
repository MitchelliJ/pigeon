/*
 * Integration tests for migration 0009 (`0009_discord_delivery.sql`).
 *
 * Boots a real embedded Postgres cluster via `withTestDb`, runs all migrations
 * through `runMigrations`, then asserts the schema changes laid out in the
 * Channel Connectors & Delivery Modes (Discord) PRD §4.1: channels,
 * delivery_settings, delivery_attempts, digest_items, and the deliver_channel
 * queue extension.
 *
 * RED note: at authoring time migration 0009 does not exist on disk, so
 * `runMigrations` only applies the earlier migrations. The new tables,
 * constraints, defaults, and deliver_channel job type are absent — that is the
 * expected RED.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { withTestDb } from "./db";
import { runMigrations } from "../src/migrate/runner";

type TestDbClient = Awaited<ReturnType<typeof withTestDb>>["db"];

async function insertUser(db: TestDbClient, email: string): Promise<string> {
  const inserted =
    await db.query`INSERT INTO users(email, name, password_hash) VALUES (${email}, ${"U"}, ${"h"}) RETURNING id`;
  return inserted[0]?.id as string;
}

async function insertMailbox(
  db: TestDbClient,
  userId: string,
  address: string,
): Promise<string> {
  const inserted = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${userId}, ${"imap"}, ${"imap"}, ${"Work"}, ${address},
      ${"imap.example.com"}, ${993}, ${true}, ${address},
      ${"gcm:iv:tag:ct"}
    ) RETURNING id`;
  return inserted[0]?.id as string;
}

async function insertEmail(
  db: TestDbClient,
  mailboxId: string,
  providerUid: string,
): Promise<string> {
  const inserted = await db.query`
    WITH message AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body,
        received_at, summary, category, classified_at
      ) SELECT
        user_id, ${providerUid}, 'Alice', 'alice@example.com', 'Hello',
        'Body text', ${new Date("2026-01-01T00:00:00Z")},
        'One sentence summary.', 'requires_action',
        ${new Date("2026-01-01T00:01:00Z")}
      FROM mailboxes WHERE id = ${mailboxId}
      RETURNING id
    )
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    SELECT ${mailboxId}, id, ${providerUid}, false FROM message
    RETURNING message_id`;
  return inserted[0]?.message_id as string;
}

async function insertChannel(
  db: TestDbClient,
  userId: string,
): Promise<string> {
  const inserted = await db.query`
    INSERT INTO channels(user_id, kind, config_encrypted, status, last_tested_at)
    VALUES (
      ${userId}, ${"discord"}, ${"sealed-discord-config"}, ${"active"},
      ${new Date("2026-01-01T00:00:00Z")}
    ) RETURNING id`;
  return inserted[0]?.id as string;
}

async function seedUserChannelAndEmail(
  db: TestDbClient,
  suffix: string,
): Promise<{ userId: string; channelId: string; emailId: string }> {
  const userId = await insertUser(db, `${suffix}@example.com`);
  const mailboxId = await insertMailbox(db, userId, `${suffix}-mb@example.com`);
  const emailId = await insertEmail(db, mailboxId, `uid-${suffix}`);
  const channelId = await insertChannel(db, userId);
  return { userId, channelId, emailId };
}

async function insertDigestAttempt(
  db: TestDbClient,
  userId: string,
  channelId: string,
): Promise<string> {
  const inserted = await db.query`
    INSERT INTO delivery_attempts(
      user_id, channel_id, kind, scheduled_for, window_start, window_end, status
    ) VALUES (
      ${userId}, ${channelId}, ${"digest"},
      ${new Date("2026-01-02T08:00:00Z")},
      ${new Date("2026-01-01T08:00:00Z")},
      ${new Date("2026-01-02T08:00:00Z")}, ${"pending"}
    ) RETURNING id`;
  return inserted[0]?.id as string;
}

async function resolveMigrationsDir(): Promise<string> {
  const primary = resolve(process.cwd(), "db/migrations");
  try {
    await readdir(primary);
    return primary;
  } catch {
    const fallback = resolve(process.cwd(), "../db/migrations");
    await readdir(fallback);
    return fallback;
  }
}

async function applyMigrationsThrough(
  db: TestDbClient,
  maxId: number,
): Promise<void> {
  const dir = await resolveMigrationsDir();
  const migrations = (await readdir(dir))
    .map((filename) => {
      const match = /^(\d+)_.*\.sql$/.exec(filename);
      if (!match) return undefined;
      return {
        id: Number(match[1]),
        filename,
        path: resolve(dir, filename),
      };
    })
    .filter(
      (
        migration,
      ): migration is { id: number; filename: string; path: string } =>
        migration !== undefined && migration.id <= maxId,
    )
    .sort((a, b) => a.id - b.id);

  for (const migration of migrations) {
    const sql = await readFile(migration.path, "utf8");
    await db.withTx(async (tx) => {
      await tx.unsafe(sql);
      await tx`
        INSERT INTO schema_migrations(id, filename)
        VALUES (${migration.id}, ${migration.filename})`;
    });
  }
}

describe("migration 0009 — Discord delivery schema", () => {
  it("creates channels with one Discord-only active/error channel per user and cascades from users", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "channelowner@example.com");
      await insertChannel(db, userId);

      await expect(insertChannel(db, userId)).rejects.toThrow();
      await expect(
        db.query`
          INSERT INTO channels(user_id, kind, config_encrypted, status, last_tested_at)
          VALUES (${userId}, ${"signal"}, ${"sealed"}, ${"active"}, ${new Date("2026-01-01T00:00:00Z")})`,
      ).rejects.toThrow();
      await expect(
        db.query`
          INSERT INTO channels(user_id, kind, config_encrypted, status, last_tested_at)
          VALUES (${userId}, ${"discord"}, ${"sealed"}, ${"disabled"}, ${new Date("2026-01-01T00:00:00Z")})`,
      ).rejects.toThrow();
      await expect(
        db.query`
          INSERT INTO channels(user_id, kind, config_encrypted, status)
          VALUES (${userId}, ${"discord"}, ${"sealed"}, ${"active"})`,
      ).rejects.toThrow();

      await db.query`DELETE FROM users WHERE id = ${userId}`;
      const rows = await db.query`SELECT COUNT(*)::int AS count FROM channels`;
      expect(rows).toEqual([{ count: 0 }]);
    } finally {
      await close();
    }
  });

  it("creates delivery_settings with daily Amsterdam defaults and cascades from users", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "settingsowner@example.com");

      await db.query`
        INSERT INTO delivery_settings(user_id, delivery_baseline_at)
        VALUES (${userId}, ${new Date("2026-01-01T00:00:00Z")})`;

      const rows = await db.query`
        SELECT
          mode,
          digest_time::text AS digest_time,
          digest_days,
          timezone,
          delivery_baseline_at IS NOT NULL AS has_baseline,
          last_digest_cutoff_at
        FROM delivery_settings
        WHERE user_id = ${userId}`;
      expect(rows).toEqual([
        {
          mode: "daily",
          digest_time: "08:00:00",
          digest_days: [1, 2, 3, 4, 5, 6, 7],
          timezone: "Europe/Amsterdam",
          has_baseline: true,
          last_digest_cutoff_at: null,
        },
      ]);

      await db.query`DELETE FROM users WHERE id = ${userId}`;
      const countRows =
        await db.query`SELECT COUNT(*)::int AS count FROM delivery_settings`;
      expect(countRows).toEqual([{ count: 0 }]);
    } finally {
      await close();
    }
  });

  it("rejects empty, out-of-range, and duplicate delivery_settings.digest_days", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const emptyUserId = await insertUser(db, "emptydays@example.com");
      const outOfRangeUserId = await insertUser(db, "baddays@example.com");
      const duplicateUserId = await insertUser(db, "duplicatedays@example.com");

      for (const [userId, digestDays] of [
        [emptyUserId, []],
        [outOfRangeUserId, [0, 8]],
        [duplicateUserId, [1, 1, 2]],
      ] as const) {
        await expect(
          db.query`
            INSERT INTO delivery_settings(
              user_id, digest_days, delivery_baseline_at
            ) VALUES (
              ${userId}, ${digestDays}, ${new Date("2026-01-01T00:00:00Z")}
            )`,
        ).rejects.toThrow();
      }
    } finally {
      await close();
    }
  });

  it("enforces valid delivery_attempts shapes, statuses, and non-negative omitted_count", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, channelId, emailId } = await seedUserChannelAndEmail(
        db,
        "attemptshape",
      );

      await expect(
        db.query`
          INSERT INTO delivery_attempts(
            user_id, channel_id, kind, message_id, status
          ) VALUES (
            ${userId}, ${channelId}, ${"immediate"}, ${emailId}, ${"pending"}
          )`,
      ).resolves.toBeDefined();
      await expect(
        db.query`
          INSERT INTO delivery_attempts(
            user_id, channel_id, kind, scheduled_for, window_start, window_end, status
          ) VALUES (
            ${userId}, ${channelId}, ${"digest"},
            ${new Date("2026-01-02T08:00:00Z")},
            ${new Date("2026-01-01T08:00:00Z")},
            ${new Date("2026-01-02T08:00:00Z")}, ${"pending"}
          )`,
      ).resolves.toBeDefined();
      await expect(
        db.query`
          INSERT INTO delivery_attempts(user_id, channel_id, kind, status)
          VALUES (${userId}, ${channelId}, ${"immediate"}, ${"pending"})`,
      ).rejects.toThrow();
      await expect(
        db.query`
          INSERT INTO delivery_attempts(
            user_id, channel_id, kind, message_id, scheduled_for,
            window_start, status
          ) VALUES (
            ${userId}, ${channelId}, ${"digest"}, ${emailId},
            ${new Date("2026-01-03T08:00:00Z")},
            ${new Date("2026-01-02T08:00:00Z")}, ${"pending"}
          )`,
      ).rejects.toThrow();
      await expect(
        db.query`
          INSERT INTO delivery_attempts(
            user_id, channel_id, kind, message_id, status, omitted_count
          ) VALUES (
            ${userId}, ${channelId}, ${"immediate"}, ${emailId},
            ${"queued"}, ${0}
          )`,
      ).rejects.toThrow();
      await expect(
        db.query`
          INSERT INTO delivery_attempts(
            user_id, channel_id, kind, message_id, status, omitted_count
          ) VALUES (
            ${userId}, ${channelId}, ${"immediate"}, ${emailId},
            ${"failed"}, ${-1}
          )`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("accepts quiet-triggered digest attempt with trigger message and digest window", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, channelId, emailId } = await seedUserChannelAndEmail(
        db,
        "quiettriggereddigestattempt",
      );

      await expect(
        db.query`
          INSERT INTO delivery_attempts(
            user_id,
            channel_id,
            kind,
            message_id,
            scheduled_for,
            window_start,
            window_end,
            status,
            omitted_count
          ) VALUES (
            ${userId},
            ${channelId},
            ${"digest"},
            ${emailId},
            ${new Date("2026-01-02T08:00:00Z")},
            ${new Date("2026-01-01T08:00:00Z")},
            ${new Date("2026-01-02T08:00:00Z")},
            ${"pending"},
            ${0}
          )`,
      ).resolves.toBeDefined();
    } finally {
      await close();
    }
  });

  it("prevents duplicate immediate and digest delivery_attempts per channel", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, channelId, emailId } = await seedUserChannelAndEmail(
        db,
        "attemptunique",
      );

      await db.query`
        INSERT INTO delivery_attempts(user_id, channel_id, kind, message_id, status)
        VALUES (${userId}, ${channelId}, ${"immediate"}, ${emailId}, ${"pending"})`;
      await expect(
        db.query`
          INSERT INTO delivery_attempts(user_id, channel_id, kind, message_id, status)
          VALUES (${userId}, ${channelId}, ${"immediate"}, ${emailId}, ${"pending"})`,
      ).rejects.toThrow();

      const scheduledFor = new Date("2026-01-02T08:00:00Z");
      await db.query`
        INSERT INTO delivery_attempts(
          user_id, channel_id, kind, scheduled_for, window_start, window_end, status
        ) VALUES (
          ${userId}, ${channelId}, ${"digest"}, ${scheduledFor},
          ${new Date("2026-01-01T08:00:00Z")}, ${scheduledFor}, ${"pending"}
        )`;
      await expect(
        db.query`
          INSERT INTO delivery_attempts(
            user_id, channel_id, kind, scheduled_for, window_start, window_end, status
          ) VALUES (
            ${userId}, ${channelId}, ${"digest"}, ${scheduledFor},
            ${new Date("2026-01-01T08:00:00Z")}, ${scheduledFor}, ${"pending"}
          )`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("prevents duplicate quiet-triggered digest attempts", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, channelId, emailId } = await seedUserChannelAndEmail(
        db,
        "quiettriggeredunique",
      );

      await db.query`
        INSERT INTO delivery_attempts(
          user_id,
          channel_id,
          kind,
          message_id,
          scheduled_for,
          window_start,
          window_end,
          status
        ) VALUES (
          ${userId},
          ${channelId},
          ${"digest"},
          ${emailId},
          ${new Date("2026-01-02T08:00:00Z")},
          ${new Date("2026-01-01T08:00:00Z")},
          ${new Date("2026-01-02T08:00:00Z")},
          ${"pending"}
        )`;
      await expect(
        db.query`
          INSERT INTO delivery_attempts(
            user_id,
            channel_id,
            kind,
            message_id,
            scheduled_for,
            window_start,
            window_end,
            status
          ) VALUES (
            ${userId},
            ${channelId},
            ${"digest"},
            ${emailId},
            ${new Date("2026-01-03T08:00:00Z")},
            ${new Date("2026-01-02T08:00:00Z")},
            ${new Date("2026-01-03T08:00:00Z")},
            ${"pending"}
          )`,
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await close();
    }
  });

  it("fails pending legacy immediate attempts", async () => {
    const { db, close } = await withTestDb();
    try {
      await applyMigrationsThrough(db, 12);
      const {
        userId,
        channelId,
        emailId: pendingMessageId,
      } = await seedUserChannelAndEmail(db, "legacy-immediate-pending");
      const historyMailboxId = await insertMailbox(
        db,
        userId,
        "legacy-immediate-history@example.com",
      );
      const sentMessageId = await insertEmail(
        db,
        historyMailboxId,
        "uid-legacy-immediate-sent",
      );
      const failedMessageId = await insertEmail(
        db,
        historyMailboxId,
        "uid-legacy-immediate-failed",
      );

      await db.query`
        INSERT INTO delivery_attempts(
          user_id,
          channel_id,
          kind,
          message_id,
          status,
          provider_message_id,
          last_error,
          sent_at
        ) VALUES
          (
            ${userId},
            ${channelId},
            ${"immediate"},
            ${pendingMessageId},
            ${"pending"},
            ${null},
            ${null},
            ${null}
          ),
          (
            ${userId},
            ${channelId},
            ${"immediate"},
            ${sentMessageId},
            ${"sent"},
            ${"discord-message-1"},
            ${null},
            ${new Date("2026-01-02T08:00:00Z")}
          ),
          (
            ${userId},
            ${channelId},
            ${"immediate"},
            ${failedMessageId},
            ${"failed"},
            ${null},
            ${"legacy failure"},
            ${null}
          )`;

      await runMigrations(db);

      const rows = await db.query`
        SELECT m.identity_key, da.status
        FROM delivery_attempts da
        JOIN messages m ON m.id = da.message_id
        WHERE da.channel_id = ${channelId}
          AND da.kind = ${"immediate"}
        ORDER BY m.identity_key`;
      expect(rows).toEqual([
        { identity_key: "uid-legacy-immediate-failed", status: "failed" },
        { identity_key: "uid-legacy-immediate-pending", status: "failed" },
        { identity_key: "uid-legacy-immediate-sent", status: "sent" },
      ]);
    } finally {
      await close();
    }
  });

  it("enforces digest_items position bounds and uniqueness per attempt", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, channelId, emailId } = await seedUserChannelAndEmail(
        db,
        "digestitems",
      );
      const mailboxId = await insertMailbox(
        db,
        userId,
        "digestitems-second-mb@example.com",
      );
      const secondEmailId = await insertEmail(
        db,
        mailboxId,
        "uid-digestitems-2",
      );
      const attemptId = await insertDigestAttempt(db, userId, channelId);

      await db.query`
        INSERT INTO digest_items(
          delivery_attempt_id, message_id, position, category, summary
        ) VALUES (
          ${attemptId}, ${emailId}, ${1}, ${"requires_action"}, ${"Summary one."}
        )`;
      await expect(
        db.query`
          INSERT INTO digest_items(
            delivery_attempt_id, message_id, position, category, summary
          ) VALUES (
            ${attemptId}, ${secondEmailId}, ${0}, ${"important"}, ${"Summary two."}
          )`,
      ).rejects.toThrow();
      await expect(
        db.query`
          INSERT INTO digest_items(
            delivery_attempt_id, message_id, position, category, summary
          ) VALUES (
            ${attemptId}, ${secondEmailId}, ${26}, ${"important"}, ${"Summary two."}
          )`,
      ).rejects.toThrow();
      await expect(
        db.query`
          INSERT INTO digest_items(
            delivery_attempt_id, message_id, position, category, summary
          ) VALUES (
            ${attemptId}, ${secondEmailId}, ${1}, ${"important"}, ${"Summary two."}
          )`,
      ).rejects.toThrow();
      await expect(
        db.query`
          INSERT INTO digest_items(
            delivery_attempt_id, message_id, position, category, summary
          ) VALUES (
            ${attemptId}, ${emailId}, ${2}, ${"requires_action"}, ${"Summary one."}
          )`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("accepts deliver_channel jobs and prevents duplicate in-flight jobs for a deliveryAttemptId", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, channelId } = await seedUserChannelAndEmail(
        db,
        "deliverjob",
      );
      const deliveryAttemptId = await insertDigestAttempt(
        db,
        userId,
        channelId,
      );

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"deliver_channel"}, ${{ deliveryAttemptId }})`,
      ).resolves.toBeDefined();
      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"deliver_channel"}, ${{ deliveryAttemptId }})`,
      ).rejects.toThrow();

      await db.query`
        UPDATE jobs SET status = ${"succeeded"}
        WHERE type = ${"deliver_channel"}
          AND payload->>'deliveryAttemptId' = ${deliveryAttemptId}`;
      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"deliver_channel"}, ${{ deliveryAttemptId }})`,
      ).resolves.toBeDefined();
    } finally {
      await close();
    }
  });
});
