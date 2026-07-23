/*
 * Integration tests for migration 0006 (`0006_jobs.sql`).
 *
 * Boots a real embedded Postgres cluster via `withTestDb`, runs all migrations
 * through `runMigrations`, then asserts the `jobs` table exists with the
 * columns/constraints laid out in the Job Queue, Workers & Scheduler PRD
 * §3.1 FR-1: closed `type`/`status` enums via CHECK constraints, sane
 * defaults, and the partial unique index enforcing "at most one in-flight
 * sync_mailbox job per mailbox".
 *
 * RED note: at authoring time migration 0006 does not exist on disk, so
 * `runMigrations` only applies 0001-0005. `to_regclass('public.jobs')`
 * returns null, and every assertion below fails — that is the expected RED.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "./db";
import { runMigrations } from "../src/migrate/runner";

async function insertUser(
  db: Awaited<ReturnType<typeof withTestDb>>["db"],
  email: string,
): Promise<string> {
  const inserted =
    await db.query`INSERT INTO users(email, name, password_hash) VALUES (${email}, ${"U"}, ${"h"}) RETURNING id`;
  return inserted[0]?.id as string;
}

async function insertMailbox(
  db: Awaited<ReturnType<typeof withTestDb>>["db"],
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

describe("migration 0006 — jobs schema", () => {
  it("creates the jobs table", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows = await db.query`SELECT to_regclass('public.jobs') AS name`;
      expect(rows[0]?.name).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("has the expected columns with correct types/nullability", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows = await db.query`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'jobs'
        ORDER BY column_name`;

      const byName = new Map(
        rows.map((r) => [
          r.column_name as string,
          { data_type: r.data_type, is_nullable: r.is_nullable },
        ]),
      );

      expect(byName.get("id")).toEqual({
        data_type: "uuid",
        is_nullable: "NO",
      });
      expect(byName.get("type")).toEqual({
        data_type: "text",
        is_nullable: "NO",
      });
      expect(byName.get("payload")).toEqual({
        data_type: "jsonb",
        is_nullable: "NO",
      });
      expect(byName.get("status")).toEqual({
        data_type: "text",
        is_nullable: "NO",
      });
      expect(byName.get("attempts")).toEqual({
        data_type: "integer",
        is_nullable: "NO",
      });
      expect(byName.get("max_attempts")).toEqual({
        data_type: "integer",
        is_nullable: "NO",
      });
      expect(byName.get("run_at")).toEqual({
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      });
      expect(byName.get("locked_at")).toEqual({
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      });
      expect(byName.get("last_error")).toEqual({
        data_type: "text",
        is_nullable: "YES",
      });
      expect(byName.get("created_at")).toEqual({
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      });
      expect(byName.get("updated_at")).toEqual({
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      });
    } finally {
      await close();
    }
  });

  it("rejects an insert with an invalid `type` value", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "jobtypeowner@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "jobtypeowner-mb@example.com",
      );

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"bogus_type"}, ${{ mailboxId }})`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("rejects an insert with an invalid `status` value", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "jobstatusowner@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "jobstatusowner-mb@example.com",
      );

      await expect(
        db.query`
          INSERT INTO jobs(type, payload, status)
          VALUES (
            ${"sync_mailbox"}, ${{ mailboxId }}, ${"bogus_status"}
          )`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("inserts a valid sync_mailbox job and reads back the expected defaults", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "jobdefaultsowner@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "jobdefaultsowner-mb@example.com",
      );

      await db.query`
        INSERT INTO jobs(type, payload)
        VALUES (${"sync_mailbox"}, ${{ mailboxId }})`;

      const rows = await db.query`
        SELECT status, attempts, max_attempts
        FROM jobs WHERE payload->>'mailboxId' = ${mailboxId}`;

      expect(rows).toEqual([
        { status: "pending", attempts: 0, max_attempts: 3 },
      ]);
    } finally {
      await close();
    }
  });

  it("partial unique index blocks a second in-flight sync_mailbox job for the same mailbox, but allows one once the first has succeeded", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "jobinflightowner@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "jobinflightowner-mb@example.com",
      );

      await db.query`
        INSERT INTO jobs(type, payload)
        VALUES (${"sync_mailbox"}, ${{ mailboxId }})`;

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"sync_mailbox"}, ${{ mailboxId }})`,
      ).rejects.toThrow();

      await db.query`
        UPDATE jobs SET status = ${"succeeded"}
        WHERE payload->>'mailboxId' = ${mailboxId}`;

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"sync_mailbox"}, ${{ mailboxId }})`,
      ).resolves.toBeDefined();

      const rows = await db.query`
        SELECT status FROM jobs
        WHERE payload->>'mailboxId' = ${mailboxId}
        ORDER BY created_at`;
      expect(rows).toEqual([{ status: "succeeded" }, { status: "pending" }]);
    } finally {
      await close();
    }
  });

  it("accepts erase_account jobs and only blocks concurrent in-flight duplicates for the same userId", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "eraseaccountowner@example.com");

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"erase_account"}, ${{ userId }})`,
      ).resolves.toBeDefined();

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"erase_account"}, ${{ userId }})`,
      ).rejects.toThrow();

      await db.query`
        UPDATE jobs SET status = ${"running"}
        WHERE type = ${"erase_account"}
          AND payload->>'userId' = ${userId}`;

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"erase_account"}, ${{ userId }})`,
      ).rejects.toThrow();

      await db.query`
        UPDATE jobs SET status = ${"failed"}
        WHERE type = ${"erase_account"}
          AND payload->>'userId' = ${userId}`;

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"erase_account"}, ${{ userId }})`,
      ).resolves.toBeDefined();

      await db.query`
        UPDATE jobs SET status = ${"succeeded"}
        WHERE type = ${"erase_account"}
          AND status = ${"pending"}
          AND payload->>'userId' = ${userId}`;

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"erase_account"}, ${{ userId }})`,
      ).resolves.toBeDefined();
    } finally {
      await close();
    }
  });

  it("has a unique index enforcing at most one in-flight sync_mailbox job per mailbox", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows = await db.query`
        SELECT indexname FROM pg_indexes WHERE tablename = 'jobs'`;
      const indexNames = rows.map((r) => r.indexname as string);
      expect(indexNames).toContain("idx_jobs_sync_mailbox_inflight");
    } finally {
      await close();
    }
  });
});
