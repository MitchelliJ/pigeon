/*
 * Integration tests for the `@pigeon/backend` migration runner.
 *
 * Exercises `runMigrations` against a real embedded Postgres cluster (via the
 * `withTestDb` harness), asserting the behaviors laid out in the infrastructure
 * PRD (FR-5..FR-10): initial application, schema_migrations tracking, health
 * table writability, idempotency, and the out-of-order guard (FR-8).
 *
 * RED note: at authoring time `backend/src/migrate/runner.ts` and the
 * `db/migrations/*.sql` files do not exist yet — the import of `runMigrations`
 * fails and this file cannot resolve. That import failure is the expected RED.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "./db";
import { runMigrations } from "../src/migrate/runner";

describe("runMigrations", () => {
  it("applies the initial migrations and records them in schema_migrations", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows =
        await db.query`SELECT id, filename FROM schema_migrations ORDER BY id`;
      expect(rows.length).toBe(13);
      const r0 = rows[0];
      // postgres.js returns BIGINT as string; coerce for the numeric assertion.
      expect(Number(r0?.id)).toBe(1);
      expect(r0?.filename).toBe("0001_schema_migrations.sql");
      const r1 = rows[1];
      expect(Number(r1?.id)).toBe(2);
      expect(r1?.filename).toBe("0002_health.sql");
      const r2 = rows[2];
      expect(Number(r2?.id)).toBe(3);
      expect(r2?.filename).toBe("0003_users_sessions.sql");
      const r3 = rows[3];
      expect(Number(r3?.id)).toBe(4);
      expect(r3?.filename).toBe("0004_mailboxes.sql");
      const r4 = rows[4];
      expect(Number(r4?.id)).toBe(5);
      expect(r4?.filename).toBe("0005_emails.sql");
      const r5 = rows[5];
      expect(Number(r5?.id)).toBe(6);
      expect(r5?.filename).toBe("0006_jobs.sql");
      const r6 = rows[6];
      expect(Number(r6?.id)).toBe(7);
      expect(r6?.filename).toBe("0007_llm_processing.sql");
      const r7 = rows[7];
      expect(Number(r7?.id)).toBe(8);
      expect(r7?.filename).toBe("0008_invites_created_by_ondelete.sql");
      const r8 = rows[8];
      expect(Number(r8?.id)).toBe(9);
      expect(r8?.filename).toBe("0009_discord_delivery.sql");
      const r9 = rows[9];
      expect(Number(r9?.id)).toBe(10);
      expect(r9?.filename).toBe("0010_quiet_heartbeats.sql");
      const r10 = rows[10];
      expect(Number(r10?.id)).toBe(11);
      expect(r10?.filename).toBe("0011_delivery_timezones.sql");
      const r11 = rows[11];
      expect(Number(r11?.id)).toBe(12);
      expect(r11?.filename).toBe("0012_normalized_messages.sql");
      const r12 = rows[12];
      expect(Number(r12?.id)).toBe(13);
      expect(r12?.filename).toBe("0013_quiet_triggered_digests.sql");
    } finally {
      await close();
    }
  });

  it("makes the health table writable", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      await expect(
        db.query`INSERT INTO health(checked_at) VALUES (now())`,
      ).resolves.toBeDefined();
      const count = await db.query`SELECT count(*)::int AS n FROM health`;
      expect(count).toEqual([{ n: 1 }]);
    } finally {
      await close();
    }
  });

  it("is idempotent — re-running applies nothing and does not throw", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      await runMigrations(db);
      const count =
        await db.query`SELECT count(*)::int AS n FROM schema_migrations`;
      expect(count).toEqual([{ n: 13 }]);
    } finally {
      await close();
    }
  });

  it("throws when an applied migration id exceeds the max id on disk (FR-8 out-of-order guard)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      // Simulate a stale database that has a higher applied id than any file
      // currently shipped on disk; the runner must refuse to proceed.
      await db.query`INSERT INTO schema_migrations(id, filename) VALUES (999, '0999_imaginary.sql')`;
      await expect(runMigrations(db)).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
