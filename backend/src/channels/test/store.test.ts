/**
 * Store tests for delivery settings persistence defaults.
 *
 * RED note: `../store` does not exist yet. This test is expected to fail at
 * import/typecheck time until the channel store exposes `getDeliverySettings`.
 */
import { describe, expect, it } from "vitest";

import { withTestDb } from "../../../test/db";
import type { Db } from "../../db/index";
import { runMigrations } from "../../migrate/runner";
import { getDeliverySettings } from "../store";

async function createUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, 'Test User', 'not-a-real-hash')
    RETURNING id
  `;

  return String(rows[0]?.id);
}

describe("channel delivery settings store", () => {
  it("lazily creates and returns daily UTC defaults with a baseline and null last digest", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await createUser(db, "settings-defaults@example.com");

      const settings = await getDeliverySettings(db, userId);

      expect(settings).toMatchObject({
        userId,
        mode: "daily",
        digestTime: "08:00",
        digestDays: [1, 2, 3, 4, 5, 6, 7],
        timezone: "UTC",
        deliveryBaselineAt: expect.any(Date),
        lastDigestCutoffAt: null,
      });
    } finally {
      await close();
    }
  });
});
