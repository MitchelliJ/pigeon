/*
 * Integration tests for migration 0003 (`0003_users_sessions.sql`).
 *
 * Boots a real embedded Postgres cluster via `withTestDb`, runs all migrations
 * through `runMigrations`, then asserts the `users`, `sessions`, `auth_tokens`,
 * and `invites` tables exist with the columns/constraints laid out in the
 * Authentication & User Accounts PRD §3.1.1 (citext email, NOT NULL name,
 * UNIQUE token hashes, CHECK-constrained `auth_tokens.kind`, UNIQUE invite
 * `code_hash`).
 *
 * RED note: at authoring time migration 0003 does not exist on disk, so
 * `runMigrations` only applies 0001 + 0002. `to_regclass('public.users')`
 * returns null and every assertion below fails — that is the expected RED.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "./db";
import { runMigrations } from "../src/migrate/runner";

describe("migration 0003 — users/sessions/auth_tokens/invites schema", () => {
  it("creates the users, sessions, auth_tokens, and invites tables", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const tables = ["users", "sessions", "auth_tokens", "invites"];
      for (const table of tables) {
        const rows =
          await db.query`SELECT to_regclass(${"public." + table}) AS name`;
        expect(rows[0]?.name).not.toBeNull();
      }
    } finally {
      await close();
    }
  });

  it("users.email is case-insensitive (citext)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      await db.query`INSERT INTO users(email, name, password_hash) VALUES (${"Mixed@Case.com"}, ${"Ada"}, ${"h"})`;
      const rows =
        await db.query`SELECT count(*)::int AS n FROM users WHERE email = ${"mixed@case.com"}`;
      expect(rows).toEqual([{ n: 1 }]);
    } finally {
      await close();
    }
  });

  it("users.name is NOT NULL", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      await expect(
        db.query`INSERT INTO users(email, name, password_hash) VALUES (${"x@y.z"}, ${null}, ${"h"})`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("sessions.token_hash is UNIQUE", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const inserted =
        await db.query`INSERT INTO users(email, name, password_hash) VALUES (${"u@v.w"}, ${"U"}, ${"h"}) RETURNING id`;
      const id = inserted[0]?.id;
      await db.query`INSERT INTO sessions(user_id, token_hash, expires_at) VALUES (${id}, ${"duphash"}, now() + interval '1 day')`;
      await expect(
        db.query`INSERT INTO sessions(user_id, token_hash, expires_at) VALUES (${id}, ${"duphash"}, now() + interval '1 day')`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("auth_tokens.kind CHECK rejects bogus kinds", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const inserted =
        await db.query`INSERT INTO users(email, name, password_hash) VALUES (${"a@b.c"}, ${"A"}, ${"h"}) RETURNING id`;
      const id = inserted[0]?.id;
      await expect(
        db.query`INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at) VALUES (${id}, ${"bogus"}, ${"h"}, now())`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("supports account-management user state and change-email tokens", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows = await db.query`
        SELECT a.attname AS column_name,
               format_type(a.atttypid, a.atttypmod) AS data_type,
               NOT a.attnotnull AS is_nullable
        FROM pg_attribute AS a
        JOIN pg_class AS c ON c.oid = a.attrelid
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'users'
          AND a.attname IN ('pending_email', 'deletion_requested_at')
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attname`;
      expect(rows).toEqual([
        {
          column_name: "deletion_requested_at",
          data_type: "timestamp with time zone",
          is_nullable: true,
        },
        {
          column_name: "pending_email",
          data_type: "citext",
          is_nullable: true,
        },
      ]);

      const inserted =
        await db.query`INSERT INTO users(email, name, password_hash) VALUES (${"owner@example.com"}, ${"Owner"}, ${"h"}) RETURNING id`;
      const id = inserted[0]?.id;

      await db.query`
        UPDATE users
        SET pending_email = ${"Mixed.Case+next@example.com"},
            deletion_requested_at = now()
        WHERE id = ${id}`;
      const updated = await db.query`
        SELECT pending_email = ${"mixed.case+next@example.com"} AS pending_email_matches,
               deletion_requested_at IS NOT NULL AS deletion_requested
        FROM users
        WHERE id = ${id}`;
      expect(updated).toEqual([
        { pending_email_matches: true, deletion_requested: true },
      ]);

      await db.query`
        INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at)
        VALUES (${id}, ${"change_email"}, ${"change-email-token"}, now() + interval '1 day')`;
      const tokenRows =
        await db.query`SELECT kind FROM auth_tokens WHERE token_hash = ${"change-email-token"}`;
      expect(tokenRows).toEqual([{ kind: "change_email" }]);

      await expect(
        db.query`INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at) VALUES (${id}, ${"totally_unknown"}, ${"unknown-token"}, now() + interval '1 day')`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("invites.code_hash is UNIQUE", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      await db.query`INSERT INTO invites(code_hash, created_at) VALUES (${"codehash"}, now())`;
      await expect(
        db.query`INSERT INTO invites(code_hash, created_at) VALUES (${"codehash"}, now())`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
