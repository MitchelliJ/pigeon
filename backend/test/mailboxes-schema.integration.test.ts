/*
 * Integration tests for migration 0004 (`0004_mailboxes.sql`).
 *
 * Boots a real embedded Postgres cluster via `withTestDb`, runs all migrations
 * through `runMigrations`, then asserts the `mailboxes` table exists with the
 * columns/constraints laid out in the Inbox Connectors & Provider Abstraction
 * PRD §3.2.1 (CITEXT address, CHECK-constrained `provider`/`protocol`/`status`,
 * UNIQUE `(user_id, address)`, `user_id` FK with `ON DELETE CASCADE`).
 *
 * RED note: at authoring time migration 0004 does not exist on disk, so
 * `runMigrations` only applies 0001-0003. `to_regclass('public.mailboxes')`
 * returns null and every assertion below fails — that is the expected RED.
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

describe("migration 0004 — mailboxes schema", () => {
  it("creates the mailboxes table", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows =
        await db.query`SELECT to_regclass('public.mailboxes') AS name`;
      expect(rows[0]?.name).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("inserts a row with all required columns and reads it back", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "mbowner@example.com");
      await db.query`
        INSERT INTO mailboxes(
          user_id, provider, protocol, label, address, host, port, tls,
          username, password_ciphertext
        ) VALUES (
          ${userId}, ${"imap"}, ${"imap"}, ${"Work"}, ${"work@example.com"},
          ${"imap.example.com"}, ${993}, ${true}, ${"work@example.com"},
          ${"gcm:iv:tag:ct"}
        )`;
      const rows =
        await db.query`SELECT label, address, status FROM mailboxes WHERE user_id = ${userId}`;
      expect(rows).toEqual([
        { label: "Work", address: "work@example.com", status: "connected" },
      ]);
    } finally {
      await close();
    }
  });

  it("provider CHECK rejects a bogus value", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "provchk@example.com");
      await expect(
        db.query`
          INSERT INTO mailboxes(
            user_id, provider, protocol, label, address, host, port, tls,
            username, password_ciphertext
          ) VALUES (
            ${userId}, ${"bogus"}, ${"imap"}, ${"Work"}, ${"a@example.com"},
            ${"imap.example.com"}, ${993}, ${true}, ${"a@example.com"},
            ${"gcm:iv:tag:ct"}
          )`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("protocol CHECK rejects a bogus value", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "protochk@example.com");
      await expect(
        db.query`
          INSERT INTO mailboxes(
            user_id, provider, protocol, label, address, host, port, tls,
            username, password_ciphertext
          ) VALUES (
            ${userId}, ${"imap"}, ${"bogus"}, ${"Work"}, ${"b@example.com"},
            ${"imap.example.com"}, ${993}, ${true}, ${"b@example.com"},
            ${"gcm:iv:tag:ct"}
          )`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("status CHECK rejects a bogus value and defaults to 'connected' when omitted", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "statuschk@example.com");
      await expect(
        db.query`
          INSERT INTO mailboxes(
            user_id, provider, protocol, label, address, host, port, tls,
            username, password_ciphertext, status
          ) VALUES (
            ${userId}, ${"imap"}, ${"imap"}, ${"Work"}, ${"c@example.com"},
            ${"imap.example.com"}, ${993}, ${true}, ${"c@example.com"},
            ${"gcm:iv:tag:ct"}, ${"bogus"}
          )`,
      ).rejects.toThrow();

      await db.query`
        INSERT INTO mailboxes(
          user_id, provider, protocol, label, address, host, port, tls,
          username, password_ciphertext
        ) VALUES (
          ${userId}, ${"imap"}, ${"imap"}, ${"Work"}, ${"d@example.com"},
          ${"imap.example.com"}, ${993}, ${true}, ${"d@example.com"},
          ${"gcm:iv:tag:ct"}
        )`;
      const rows =
        await db.query`SELECT status FROM mailboxes WHERE address = ${"d@example.com"}`;
      expect(rows).toEqual([{ status: "connected" }]);
    } finally {
      await close();
    }
  });

  it("UNIQUE (user_id, address) rejects a duplicate address for the same user", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "dupechk@example.com");
      await db.query`
        INSERT INTO mailboxes(
          user_id, provider, protocol, label, address, host, port, tls,
          username, password_ciphertext
        ) VALUES (
          ${userId}, ${"imap"}, ${"imap"}, ${"Work"}, ${"dup@example.com"},
          ${"imap.example.com"}, ${993}, ${true}, ${"dup@example.com"},
          ${"gcm:iv:tag:ct"}
        )`;
      await expect(
        db.query`
          INSERT INTO mailboxes(
            user_id, provider, protocol, label, address, host, port, tls,
            username, password_ciphertext
          ) VALUES (
            ${userId}, ${"imap"}, ${"imap"}, ${"Work 2"}, ${"dup@example.com"},
            ${"imap.example.com"}, ${993}, ${true}, ${"dup@example.com"},
            ${"gcm:iv:tag:ct"}
          )`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("cascades delete from users to mailboxes (ON DELETE CASCADE)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "cascadechk@example.com");
      await db.query`
        INSERT INTO mailboxes(
          user_id, provider, protocol, label, address, host, port, tls,
          username, password_ciphertext
        ) VALUES (
          ${userId}, ${"imap"}, ${"imap"}, ${"Work"}, ${"cascade@example.com"},
          ${"imap.example.com"}, ${993}, ${true}, ${"cascade@example.com"},
          ${"gcm:iv:tag:ct"}
        )`;
      await db.query`DELETE FROM users WHERE id = ${userId}`;
      const rows =
        await db.query`SELECT * FROM mailboxes WHERE user_id = ${userId}`;
      expect(rows.length).toBe(0);
    } finally {
      await close();
    }
  });
});
