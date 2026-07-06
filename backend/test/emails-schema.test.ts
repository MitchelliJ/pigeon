/*
 * Integration tests for migration 0005 (`0005_emails.sql`).
 *
 * Boots a real embedded Postgres cluster via `withTestDb`, runs all migrations
 * through `runMigrations`, then asserts the `emails` table exists with the
 * columns/constraints laid out in the Incremental Sync Engine & Watermarks
 * PRD §3.1 (all NOT NULL content columns, UNIQUE `(mailbox_id, provider_uid)`
 * as the dedupe mechanism, `mailbox_id` FK to `mailboxes(id)` with
 * `ON DELETE CASCADE`), plus the companion `mailboxes.last_synced_at` column.
 *
 * RED note: at authoring time migration 0005 does not exist on disk, so
 * `runMigrations` only applies 0001-0004. `to_regclass('public.emails')`
 * returns null, `mailboxes.last_synced_at` does not exist, and every
 * assertion below fails — that is the expected RED.
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

describe("migration 0005 — emails schema", () => {
  it("creates the emails table", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows = await db.query`SELECT to_regclass('public.emails') AS name`;
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
        WHERE table_name = 'emails'
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
      expect(byName.get("mailbox_id")).toEqual({
        data_type: "uuid",
        is_nullable: "NO",
      });
      expect(byName.get("provider_uid")).toEqual({
        data_type: "text",
        is_nullable: "NO",
      });
      expect(byName.get("seen")).toEqual({
        data_type: "boolean",
        is_nullable: "NO",
      });
      expect(byName.get("from_name")).toEqual({
        data_type: "text",
        is_nullable: "NO",
      });
      expect(byName.get("from_address")).toEqual({
        data_type: "text",
        is_nullable: "NO",
      });
      expect(byName.get("subject")).toEqual({
        data_type: "text",
        is_nullable: "NO",
      });
      expect(byName.get("body")).toEqual({
        data_type: "text",
        is_nullable: "NO",
      });
      expect(byName.get("received_at")).toEqual({
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      });
      expect(byName.get("created_at")).toEqual({
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      });
    } finally {
      await close();
    }
  });

  it("has a UNIQUE constraint covering (mailbox_id, provider_uid)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows = await db.query`
        SELECT tc.constraint_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        WHERE tc.table_name = 'emails'
          AND tc.constraint_type = 'UNIQUE'`;

      const byConstraint = new Map<string, Set<string>>();
      for (const r of rows) {
        const name = r.constraint_name as string;
        const col = r.column_name as string;
        if (!byConstraint.has(name)) byConstraint.set(name, new Set());
        byConstraint.get(name)?.add(col);
      }

      const matching = [...byConstraint.values()].some(
        (cols) => cols.has("mailbox_id") && cols.has("provider_uid"),
      );
      expect(matching).toBe(true);
    } finally {
      await close();
    }
  });

  it("inserts an emails row referencing a mailbox and reads it back", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "emailowner@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "emailowner-mb@example.com",
      );

      await db.query`
        INSERT INTO emails(
          mailbox_id, provider_uid, seen, from_name, from_address,
          subject, body, received_at
        ) VALUES (
          ${mailboxId}, ${"uid-1"}, ${true}, ${"Alice"}, ${"alice@example.com"},
          ${"Hello"}, ${"Body text"}, ${new Date("2026-01-01T00:00:00Z")}
        )`;

      const rows = await db.query`
        SELECT subject, from_address, body, seen, provider_uid
        FROM emails WHERE mailbox_id = ${mailboxId}`;

      expect(rows).toEqual([
        {
          subject: "Hello",
          from_address: "alice@example.com",
          body: "Body text",
          seen: true,
          provider_uid: "uid-1",
        },
      ]);
    } finally {
      await close();
    }
  });

  it("cascades delete from mailboxes to emails (ON DELETE CASCADE)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "cascadeowner@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "cascadeowner-mb@example.com",
      );

      await db.query`
        INSERT INTO emails(
          mailbox_id, provider_uid, seen, from_name, from_address,
          subject, body, received_at
        ) VALUES (
          ${mailboxId}, ${"uid-cascade"}, ${false}, ${"Bob"}, ${"bob@example.com"},
          ${"Subj"}, ${"Body"}, ${new Date("2026-01-01T00:00:00Z")}
        )`;

      await db.query`DELETE FROM mailboxes WHERE id = ${mailboxId}`;

      const rows =
        await db.query`SELECT * FROM emails WHERE mailbox_id = ${mailboxId}`;
      expect(rows.length).toBe(0);
    } finally {
      await close();
    }
  });

  it("UNIQUE (mailbox_id, provider_uid) rejects a duplicate provider_uid for the same mailbox", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "dupeowner@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "dupeowner-mb@example.com",
      );

      await db.query`
        INSERT INTO emails(
          mailbox_id, provider_uid, seen, from_name, from_address,
          subject, body, received_at
        ) VALUES (
          ${mailboxId}, ${"uid-dup"}, ${false}, ${"Carl"}, ${"carl@example.com"},
          ${"Subj 1"}, ${"Body 1"}, ${new Date("2026-01-01T00:00:00Z")}
        )`;

      await expect(
        db.query`
          INSERT INTO emails(
            mailbox_id, provider_uid, seen, from_name, from_address,
            subject, body, received_at
          ) VALUES (
            ${mailboxId}, ${"uid-dup"}, ${false}, ${"Carl 2"}, ${"carl2@example.com"},
            ${"Subj 2"}, ${"Body 2"}, ${new Date("2026-01-02T00:00:00Z")}
          )`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("mailboxes.last_synced_at is a nullable timestamptz, defaulting to NULL on insert", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);

      const columnRows = await db.query`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'mailboxes' AND column_name = 'last_synced_at'`;
      expect(columnRows).toEqual([
        { data_type: "timestamp with time zone", is_nullable: "YES" },
      ]);

      const userId = await insertUser(db, "syncedowner@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "syncedowner-mb@example.com",
      );

      const rows =
        await db.query`SELECT last_synced_at FROM mailboxes WHERE id = ${mailboxId}`;
      expect(rows).toEqual([{ last_synced_at: null }]);
    } finally {
      await close();
    }
  });
});
