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
