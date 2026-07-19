import { describe, expect, it } from "vitest";

import { withTestDb } from "../../../test/db";
import type { Db } from "../../db/index";
import { runMigrations } from "../../migrate/runner";
import { updateDeliverySettings } from "../service";
import { getDeliverySettings } from "../store";

async function insertUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, ${email}, 'not-a-real-hash')
    RETURNING id
  `;

  return String(rows[0]?.id);
}

async function insertChannel(db: Db, userId: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO channels(user_id, kind, config_encrypted, status, last_tested_at)
    VALUES (${userId}, 'discord', 'sealed', 'active', now())
    RETURNING id
  `;

  return String(rows[0]?.id);
}

async function setStoredDeliveryState(db: Db, userId: string): Promise<void> {
  await db.query`
    INSERT INTO delivery_settings(
      user_id,
      mode,
      digest_time,
      digest_days,
      delivery_baseline_at,
      last_digest_cutoff_at
    )
    VALUES (
      ${userId},
      'daily',
      '08:00',
      ARRAY[1,2,3,4,5,6,7]::SMALLINT[],
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z'
    )
  `;
}

describe("delivery settings service", () => {
  it("rejects an invalid delivery mode", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "invalid-mode@example.com");

      await expect(
        updateDeliverySettings(db, userId, { mode: "weekly" }),
      ).rejects.toMatchObject({ code: "invalid_delivery_settings" });
    } finally {
      await close();
    }
  });

  it("rejects an invalid digest time format", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "invalid-time@example.com");

      await expect(
        updateDeliverySettings(db, userId, { digestTime: "8:00" }),
      ).rejects.toMatchObject({ code: "invalid_delivery_settings" });
    } finally {
      await close();
    }
  });

  it("rejects empty, duplicate, or invalid digest days", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "invalid-days@example.com");

      for (const digestDays of [[], [1, 1], [0], [8]]) {
        await expect(
          updateDeliverySettings(db, userId, { digestDays }),
        ).rejects.toMatchObject({ code: "invalid_delivery_settings" });
      }
    } finally {
      await close();
    }
  });

  it("resets baseline and clears last digest cutoff when mode changes", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "mode-change@example.com");
      await setStoredDeliveryState(db, userId);

      await updateDeliverySettings(db, userId, { mode: "quiet" });

      const settings = await getDeliverySettings(db, userId);
      expect({
        baselineWasReset:
          settings.deliveryBaselineAt > new Date("2026-01-01T00:00:00Z"),
        lastDigestCutoffAt: settings.lastDigestCutoffAt,
      }).toEqual({ baselineWasReset: true, lastDigestCutoffAt: null });
    } finally {
      await close();
    }
  });

  it("preserves baseline when only digest schedule changes", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "schedule-change@example.com");
      await setStoredDeliveryState(db, userId);

      await updateDeliverySettings(db, userId, {
        digestTime: "09:30",
        digestDays: [1, 3, 5],
      });

      const settings = await getDeliverySettings(db, userId);
      expect(settings.deliveryBaselineAt).toEqual(
        new Date("2026-01-01T00:00:00Z"),
      );
    } finally {
      await close();
    }
  });

  it("marks pending delivery attempts failed when mode changes", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "pending-attempt@example.com");
      const channelId = await insertChannel(db, userId);
      await setStoredDeliveryState(db, userId);
      const attemptRows = await db.query`
        INSERT INTO delivery_attempts(
          user_id,
          channel_id,
          kind,
          scheduled_for,
          window_start,
          window_end,
          status
        )
        VALUES (
          ${userId},
          ${channelId},
          'digest',
          '2026-01-03T08:00:00Z',
          '2026-01-02T08:00:00Z',
          '2026-01-03T08:00:00Z',
          'pending'
        )
        RETURNING id
      `;

      await updateDeliverySettings(db, userId, { mode: "quiet" });

      const rows = await db.query`
        SELECT status FROM delivery_attempts WHERE id = ${String(attemptRows[0]?.id)}
      `;
      expect(rows[0]?.status).toBe("failed");
    } finally {
      await close();
    }
  });

  it("returns settings with UTC timezone", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "timezone@example.com");

      const settings = await updateDeliverySettings(db, userId, {
        digestTime: "08:00",
      });

      expect(settings.timezone).toBe("UTC");
    } finally {
      await close();
    }
  });
});
