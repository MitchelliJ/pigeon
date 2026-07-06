/**
 * Integration tests for the emails service (LLM Processing — Summarize +
 * Classify PRD Sec. 3.1): `loadCategoryCounts` and `loadEmailPage`.
 *
 * RED note: at authoring time `../service` does not exist yet — this file is
 * expected to fail at import time (module not found), not merely at an
 * assertion, until `backend/src/emails/service.ts` is implemented.
 *
 * Mirrors the setup style of `../../mailboxes/test/dashboard.test.ts`:
 * `withTestDb()` boots a real embedded Postgres, `runMigrations` applies the
 * schema, and rows are seeded directly. This module never touches mailbox
 * credentials, so there is no vault here and mailbox rows use a placeholder
 * ciphertext.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { loadCategoryCounts, loadEmailPage } from "../service";
import type { Db } from "../../db/index";
import type { Email } from "@pigeon/shared";

/** Insert a user row directly, returning its id. */
async function insertUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, ${email}, 'not-a-real-hash')
    RETURNING id
  `;
  return String(rows[0]?.id);
}

/**
 * Insert a minimal valid mailbox row for `userId`. `password_ciphertext` is a
 * placeholder to satisfy the NOT NULL column — this service never reads it.
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
 * Insert a minimal valid `emails` row for `mailboxId`. A classified row always
 * carries both `summary` and `classified_at`, so when `category` is provided we
 * set all three; when it is omitted the row stays unclassified (all NULL).
 * Returns the new email id.
 */
async function insertEmail(
  db: Db,
  mailboxId: string,
  overrides: { category?: string; receivedAt?: Date; subject?: string } = {},
): Promise<string> {
  const { category, receivedAt = new Date(), subject = "S" } = overrides;
  const classified = category !== undefined;
  const summary = classified ? "placeholder summary" : null;
  const classifiedAt = classified ? new Date() : null;
  const rows = await db.query`
    INSERT INTO emails (
      mailbox_id, provider_uid, seen, from_name, from_address, subject, body,
      received_at, summary, category, classified_at
    )
    VALUES (
      ${mailboxId}, ${randomUUID()}, false, 'A', 'a@example.com', ${subject},
      'B', ${receivedAt}, ${summary}, ${category ?? null}, ${classifiedAt}
    )
    RETURNING id
  `;
  return String(rows[0]?.id);
}

describe("loadCategoryCounts", () => {
  it("groups a user's classified emails by category, defaulting an empty category to 0", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "amy@example.com");
      const m1 = await insertMailbox(db, userId, "amy-one@example.com");
      const m2 = await insertMailbox(db, userId, "amy-two@example.com");
      await insertEmail(db, m1, { category: "requires_action" });
      await insertEmail(db, m1, { category: "requires_action" });
      await insertEmail(db, m2, { category: "important" });

      const counts = await loadCategoryCounts(db, userId);

      expect(counts).toEqual({ requires_action: 2, important: 1, noise: 0 });
    } finally {
      await close();
    }
  });

  it("never counts another user's emails", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "ben@example.com");
      const mine = await insertMailbox(db, userId, "ben@example.com");
      await insertEmail(db, mine, { category: "important" });

      const otherId = await insertUser(db, "eve@example.com");
      const theirs = await insertMailbox(db, otherId, "eve@example.com");
      await insertEmail(db, theirs, { category: "important" });
      await insertEmail(db, theirs, { category: "important" });
      await insertEmail(db, theirs, { category: "requires_action" });

      const counts = await loadCategoryCounts(db, userId);

      expect(counts).toEqual({ requires_action: 0, important: 1, noise: 0 });
    } finally {
      await close();
    }
  });

  it("never counts unclassified (category IS NULL) emails", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "cara@example.com");
      const mailbox = await insertMailbox(db, userId, "cara@example.com");
      await insertEmail(db, mailbox, { category: "important" });
      await insertEmail(db, mailbox, { category: "important" });
      await insertEmail(db, mailbox); // unclassified
      await insertEmail(db, mailbox); // unclassified
      await insertEmail(db, mailbox); // unclassified

      const counts = await loadCategoryCounts(db, userId);

      expect(counts).toEqual({ requires_action: 0, important: 2, noise: 0 });
    } finally {
      await close();
    }
  });
});

describe("loadEmailPage", () => {
  it("returns only the requested category, newest received_at first", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "dan@example.com");
      const mailbox = await insertMailbox(db, userId, "dan@example.com");
      await insertEmail(db, mailbox, {
        category: "requires_action",
        subject: "ra-oldest",
        receivedAt: new Date("2026-01-01T00:00:00Z"),
      });
      await insertEmail(db, mailbox, {
        category: "requires_action",
        subject: "ra-newest",
        receivedAt: new Date("2026-01-03T00:00:00Z"),
      });
      await insertEmail(db, mailbox, {
        category: "requires_action",
        subject: "ra-mid",
        receivedAt: new Date("2026-01-02T00:00:00Z"),
      });
      await insertEmail(db, mailbox, {
        category: "important",
        subject: "imp",
        receivedAt: new Date("2026-01-04T00:00:00Z"),
      });

      const page = await loadEmailPage(
        db,
        userId,
        "requires_action",
        undefined,
        10,
      );

      expect(page.emails.map((e) => e.subject)).toEqual([
        "ra-newest",
        "ra-mid",
        "ra-oldest",
      ]);
    } finally {
      await close();
    }
  });

  it("respects limit and reports a non-null nextCursor when more rows remain", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "fay@example.com");
      const mailbox = await insertMailbox(db, userId, "fay@example.com");
      for (let i = 0; i < 5; i++) {
        await insertEmail(db, mailbox, {
          category: "requires_action",
          receivedAt: new Date(2026, 0, i + 1),
        });
      }

      const page = await loadEmailPage(
        db,
        userId,
        "requires_action",
        undefined,
        2,
      );

      expect(page.emails).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("paginates through every row via nextCursor, ending with nextCursor null and no duplicates", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "gus@example.com");
      const mailbox = await insertMailbox(db, userId, "gus@example.com");
      const seededIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        seededIds.push(
          await insertEmail(db, mailbox, {
            category: "requires_action",
            receivedAt: new Date(2026, 0, i + 1),
          }),
        );
      }

      const collected: string[] = [];
      let cursor: string | undefined = undefined;
      let lastCursor: string | null = "start";
      // Guard against a broken pagination loop running forever.
      for (let guard = 0; guard < 10; guard++) {
        const page: { emails: Email[]; nextCursor: string | null } =
          await loadEmailPage(db, userId, "requires_action", cursor, 2);
        collected.push(...page.emails.map((e) => e.id));
        lastCursor = page.nextCursor;
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      expect(lastCursor).toBeNull();
      expect([...collected].sort()).toEqual([...seededIds].sort());
    } finally {
      await close();
    }
  });

  it("never returns another user's emails in the paginated results", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "hal@example.com");
      const mine = await insertMailbox(db, userId, "hal@example.com");
      const mineId1 = await insertEmail(db, mine, {
        category: "requires_action",
        receivedAt: new Date("2026-01-01T00:00:00Z"),
      });
      const mineId2 = await insertEmail(db, mine, {
        category: "requires_action",
        receivedAt: new Date("2026-01-02T00:00:00Z"),
      });

      const otherId = await insertUser(db, "ida@example.com");
      const theirs = await insertMailbox(db, otherId, "ida@example.com");
      for (let i = 0; i < 3; i++) {
        await insertEmail(db, theirs, {
          category: "requires_action",
          receivedAt: new Date(2026, 0, i + 10),
        });
      }

      const page = await loadEmailPage(
        db,
        userId,
        "requires_action",
        undefined,
        10,
      );

      expect(page.emails.map((e) => e.id).sort()).toEqual(
        [mineId1, mineId2].sort(),
      );
    } finally {
      await close();
    }
  });

  it("sets needsAttention true exactly for requires_action and leaves suggestedAction undefined", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "jon@example.com");
      const mailbox = await insertMailbox(db, userId, "jon@example.com");
      await insertEmail(db, mailbox, { category: "requires_action" });
      await insertEmail(db, mailbox, { category: "important" });

      const action = await loadEmailPage(
        db,
        userId,
        "requires_action",
        undefined,
        10,
      );
      const important = await loadEmailPage(
        db,
        userId,
        "important",
        undefined,
        10,
      );

      expect(action.emails[0]?.needsAttention).toBe(true);
      expect(important.emails[0]?.needsAttention).toBe(false);
      expect(action.emails[0]?.suggestedAction).toBeUndefined();
      expect(important.emails[0]?.suggestedAction).toBeUndefined();
    } finally {
      await close();
    }
  });
});
