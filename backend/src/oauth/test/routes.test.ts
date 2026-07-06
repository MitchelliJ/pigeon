/**
 * Integration tests for `GET /api/oauth/providers` (Inbox Connectors &
 * Provider Abstraction PRD §3.2.6, FR-11).
 *
 * RED note: at authoring time `../routes` (`oauthRoutes`) does not exist
 * yet — this file is expected to fail at import/mount time (module not
 * found), not just at an assertion, until it is implemented.
 *
 * Mirrors the exact setup pattern used by
 * `../../mailboxes/test/dashboard.test.ts`: `withTestDb()`, `runMigrations`,
 * inserting a `users` row directly, minting a session directly via
 * `generateToken()`/`hashToken()` into the `sessions` table, and driving
 * requests with `app.request(...)` plus a `pigeon_session=<token>` cookie.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { generateToken, hashToken } from "../../auth/tokens";
import { oauthRoutes } from "../routes";
import type { Db } from "../../db/index";

/** Insert a user row directly and mint a live session, returning its cookie token. */
async function createUserWithSession(
  db: Db,
  email: string,
  name: string,
): Promise<{ userId: string; token: string }> {
  const userRows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, ${name}, 'not-a-real-hash')
    RETURNING id
  `;
  const userId = String(userRows[0]?.id);

  const token = generateToken();
  const tokenHash = hashToken(token);
  await db.query`
    INSERT INTO sessions(user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, now() + interval '1 day')
  `;

  return { userId, token };
}

describe("GET /api/oauth/providers", () => {
  it("responds 200 with an empty providers array for an authenticated caller", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { token } = await createUserWithSession(
        db,
        "olive@example.com",
        "Olive Example",
      );

      const app = oauthRoutes(db);
      const res = await app.request("/api/oauth/providers", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { providers: unknown[] };
      expect(body).toEqual({ providers: [] });
    } finally {
      await close();
    }
  });

  it("rejects a request with no session cookie: 401", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);

      const app = oauthRoutes(db);
      const res = await app.request("/api/oauth/providers");

      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });
});
