/**
 * Integration tests for `GET /api/emails` (LLM Processing — Summarize +
 * Classify PRD §3.4, FR-12/FR-14): the paginated, per-category triage inbox
 * read, delegated to `loadEmailPage` and scoped to the caller's own mailboxes.
 *
 * RED note: at authoring time `../routes` (`emailsRoutes`) does not exist yet —
 * this file is expected to fail at import/mount time (module not found), not
 * just at an assertion, until it is implemented.
 *
 * Mirrors the setup pattern of `../../mailboxes/test/dashboard.test.ts`:
 * `withTestDb()`, `runMigrations`, a `users` row inserted directly, a session
 * minted directly via `generateToken()`/`hashToken()` into `sessions`, and
 * requests driven with `app.request(...)` plus a `pigeon_session=<token>`
 * cookie. This route only reads, so it needs no vault/connector — the mailbox
 * row's `password_ciphertext` NOT NULL column is satisfied with a plain
 * placeholder string the route never touches.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { generateToken, hashToken } from "../../auth/tokens";
import { emailsRoutes } from "../routes";
import type { Db } from "../../db/index";
import type { Email } from "@pigeon/shared";

/** Minimal shape of a successful `GET /api/emails` response body. */
type EmailsBody = { emails: Email[]; nextCursor: string | null };

/** Minimal shape of an error/status JSON response body, for `.json()` casts. */
type ErrorBody = { error?: string; code?: string };

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

/**
 * Insert a mailbox row directly for `userId`. This route never decrypts
 * credentials, so `password_ciphertext` is a plain placeholder (no vault) —
 * enough to satisfy the NOT NULL column. Returns the new mailbox's id.
 */
async function insertMailbox(
  db: Db,
  userId: string,
  address: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes (
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext, status
    )
    VALUES (
      ${userId}, 'imap', 'imap', ${address}, ${address}, 'imap.example.com',
      993, true, ${address}, 'placeholder-ciphertext', 'connected'
    )
    RETURNING id
  `;
  return String(rows[0]?.id);
}

/**
 * Insert a classified `emails` row for `mailboxId`. A classified row always
 * carries `summary`, `category`, and `classified_at` — the fields the emails
 * read keys off. `provider_uid` is a fresh UUID so rows never collide.
 */
async function insertClassifiedEmail(
  db: Db,
  mailboxId: string,
  overrides: { category: string; receivedAt?: Date; subject?: string },
): Promise<void> {
  const { category, receivedAt = new Date(), subject = "S" } = overrides;
  await db.query`
    INSERT INTO emails (
      mailbox_id, provider_uid, seen, from_name, from_address, subject, body,
      received_at, summary, category, classified_at
    )
    VALUES (
      ${mailboxId}, ${randomUUID()}, false, 'A', 'a@example.com', ${subject},
      'B', ${receivedAt}, 'placeholder summary', ${category}, now()
    )
  `;
}

describe("GET /api/emails", () => {
  it("returns the caller's page of a category, newest first, shaped as { emails, nextCursor }", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, token } = await createUserWithSession(
        db,
        "amy@example.com",
        "Amy Example",
      );
      const mailboxId = await insertMailbox(db, userId, "amy@example.com");
      await insertClassifiedEmail(db, mailboxId, {
        category: "important",
        subject: "imp-old",
        receivedAt: new Date(2026, 0, 1),
      });
      await insertClassifiedEmail(db, mailboxId, {
        category: "important",
        subject: "imp-new",
        receivedAt: new Date(2026, 0, 2),
      });

      const app = emailsRoutes(db);
      const res = await app.request("/api/emails?category=important", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as EmailsBody;
      expect(body.emails.map((e) => e.subject)).toEqual(["imp-new", "imp-old"]);
      expect(body.nextCursor).toBeNull();
    } finally {
      await close();
    }
  });

  it("rejects a request with no category query param: 400 with error/code body", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { token } = await createUserWithSession(
        db,
        "ben@example.com",
        "Ben Example",
      );

      const app = emailsRoutes(db);
      const res = await app.request("/api/emails", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error).toBeTruthy();
      expect(body.code).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("rejects an invalid category value: 400", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { token } = await createUserWithSession(
        db,
        "cal@example.com",
        "Cal Example",
      );

      const app = emailsRoutes(db);
      const res = await app.request("/api/emails?category=bogus", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("scopes results to the caller's own mailboxes, never another user's mail", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, token } = await createUserWithSession(
        db,
        "dot@example.com",
        "Dot Example",
      );
      const mailboxId = await insertMailbox(db, userId, "dot@example.com");
      await insertClassifiedEmail(db, mailboxId, {
        category: "important",
        subject: "dot-imp",
        receivedAt: new Date(2026, 0, 1),
      });

      // A second user with their own important mail — none of it may leak.
      const other = await createUserWithSession(
        db,
        "eli@example.com",
        "Eli Example",
      );
      const otherMailboxId = await insertMailbox(
        db,
        other.userId,
        "eli@example.com",
      );
      await insertClassifiedEmail(db, otherMailboxId, {
        category: "important",
        subject: "eli-imp",
        receivedAt: new Date(2026, 0, 2),
      });

      const app = emailsRoutes(db);
      const res = await app.request("/api/emails?category=important", {
        headers: { cookie: `pigeon_session=${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as EmailsBody;
      expect(body.emails.map((e) => e.subject)).toEqual(["dot-imp"]);
    } finally {
      await close();
    }
  });

  it("clamps an over-max limit instead of rejecting it: limit=999 succeeds with 200", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, token } = await createUserWithSession(
        db,
        "fay@example.com",
        "Fay Example",
      );
      const mailboxId = await insertMailbox(db, userId, "fay@example.com");
      for (let i = 0; i < 5; i++) {
        await insertClassifiedEmail(db, mailboxId, {
          category: "important",
          subject: `imp-${i}`,
          receivedAt: new Date(2026, 0, i + 1),
        });
      }

      const app = emailsRoutes(db);
      const res = await app.request(
        "/api/emails?category=important&limit=999",
        {
          headers: { cookie: `pigeon_session=${token}` },
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as EmailsBody;
      // Fewer than the max were seeded, so all come back and the page never
      // exceeds the documented cap of 50 — proving the over-max value was
      // clamped (accepted), not rejected.
      expect(body.emails).toHaveLength(5);
      expect(body.emails.length).toBeLessThanOrEqual(50);
    } finally {
      await close();
    }
  });

  it("paginates via nextCursor: a follow-up request with the cursor returns the next page", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { userId, token } = await createUserWithSession(
        db,
        "gus@example.com",
        "Gus Example",
      );
      const mailboxId = await insertMailbox(db, userId, "gus@example.com");
      for (let i = 0; i < 3; i++) {
        await insertClassifiedEmail(db, mailboxId, {
          category: "important",
          subject: `imp-${i}`,
          receivedAt: new Date(2026, 0, i + 1),
        });
      }

      const app = emailsRoutes(db);
      const firstRes = await app.request(
        "/api/emails?category=important&limit=2",
        { headers: { cookie: `pigeon_session=${token}` } },
      );
      expect(firstRes.status).toBe(200);
      const firstBody = (await firstRes.json()) as EmailsBody;
      expect(firstBody.emails).toHaveLength(2);
      expect(firstBody.nextCursor).not.toBeNull();

      const cursor = encodeURIComponent(firstBody.nextCursor as string);
      const secondRes = await app.request(
        `/api/emails?category=important&limit=2&cursor=${cursor}`,
        { headers: { cookie: `pigeon_session=${token}` } },
      );
      expect(secondRes.status).toBe(200);
      const secondBody = (await secondRes.json()) as EmailsBody;
      expect(secondBody.emails).toHaveLength(1);
      expect(secondBody.nextCursor).toBeNull();
    } finally {
      await close();
    }
  });

  it("rejects a malformed cursor: 400 with invalid_cursor code", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const { token } = await createUserWithSession(
        db,
        "hal@example.com",
        "Hal Example",
      );

      const app = emailsRoutes(db);
      const res = await app.request(
        "/api/emails?category=important&cursor=%25%25%25",
        { headers: { cookie: `pigeon_session=${token}` } },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.code).toBe("invalid_cursor");
    } finally {
      await close();
    }
  });

  it("rejects a request with no session cookie: 401", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);

      const app = emailsRoutes(db);
      const res = await app.request("/api/emails?category=important");

      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });
});
