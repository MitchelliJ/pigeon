/*
 * Integration tests for migration 0007 (`0007_llm_processing.sql`).
 *
 * Boots a real embedded Postgres cluster via `withTestDb`, runs all migrations
 * through `runMigrations`, then asserts the schema changes laid out in the LLM
 * Processing (Summarize + Classify) PRD §3.1 FR-1..FR-4:
 *   - `emails` gains nullable `summary`/`category`/`classified_at` columns,
 *     with `category` restricted by CHECK to
 *     ('requires_action','important','noise');
 *   - a new index `idx_emails_category_received_at` on
 *     `emails(category, received_at DESC)`;
 *   - `users` gains a nullable `classification_instructions` column;
 *   - the `jobs_type_check` CHECK is extended to also accept
 *     'summarize_classify';
 *   - a partial unique index `idx_jobs_summarize_classify_inflight` enforcing
 *     "at most one in-flight summarize_classify job per emailId".
 *
 * RED note: at authoring time migration 0007 does not exist on disk, so
 * `runMigrations` only applies 0001-0006. The `emails.summary`/`category`/
 * `classified_at` and `users.classification_instructions` columns do not
 * exist, `jobs.type` still rejects 'summarize_classify', and neither new
 * index exists — so every assertion below fails. That is the expected RED.
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

async function insertEmail(
  db: Awaited<ReturnType<typeof withTestDb>>["db"],
  mailboxId: string,
  providerUid: string,
): Promise<string> {
  const inserted = await db.query`
    INSERT INTO emails(
      mailbox_id, provider_uid, seen, from_name, from_address,
      subject, body, received_at
    ) VALUES (
      ${mailboxId}, ${providerUid}, ${false}, ${"Alice"}, ${"alice@example.com"},
      ${"Hello"}, ${"Body text"}, ${new Date("2026-01-01T00:00:00Z")}
    ) RETURNING id`;
  return inserted[0]?.id as string;
}

describe("migration 0007 — LLM processing schema", () => {
  it("adds nullable summary/category/classified_at columns to emails", async () => {
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

      expect(byName.get("summary")).toEqual({
        data_type: "text",
        is_nullable: "YES",
      });
      expect(byName.get("category")).toEqual({
        data_type: "text",
        is_nullable: "YES",
      });
      expect(byName.get("classified_at")).toEqual({
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      });
    } finally {
      await close();
    }
  });

  it("rejects an emails row with an invalid `category` value", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "catbogus@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "catbogus-mb@example.com",
      );

      await expect(
        db.query`
          INSERT INTO emails(
            mailbox_id, provider_uid, seen, from_name, from_address,
            subject, body, received_at, category
          ) VALUES (
            ${mailboxId}, ${"uid-bogus"}, ${false}, ${"Alice"}, ${"alice@example.com"},
            ${"Hello"}, ${"Body"}, ${new Date("2026-01-01T00:00:00Z")}, ${"bogus"}
          )`,
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it("accepts each valid `category` value", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "catvalid@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "catvalid-mb@example.com",
      );

      const categories = ["requires_action", "important", "noise"];
      for (const [i, category] of categories.entries()) {
        await expect(
          db.query`
            INSERT INTO emails(
              mailbox_id, provider_uid, seen, from_name, from_address,
              subject, body, received_at, category
            ) VALUES (
              ${mailboxId}, ${`uid-${i}`}, ${false}, ${"Alice"}, ${"alice@example.com"},
              ${"Hello"}, ${"Body"}, ${new Date("2026-01-01T00:00:00Z")}, ${category}
            )`,
        ).resolves.toBeDefined();
      }
    } finally {
      await close();
    }
  });

  it("has the idx_emails_category_received_at index", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows = await db.query`
        SELECT indexname FROM pg_indexes WHERE tablename = 'emails'`;
      const indexNames = rows.map((r) => r.indexname as string);
      expect(indexNames).toContain("idx_emails_category_received_at");
    } finally {
      await close();
    }
  });

  it("adds a nullable classification_instructions column to users", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows = await db.query`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'classification_instructions'`;
      expect(rows).toEqual([{ data_type: "text", is_nullable: "YES" }]);
    } finally {
      await close();
    }
  });

  it("accepts a jobs row with type = summarize_classify", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "sctype@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "sctype-mb@example.com",
      );
      const emailId = await insertEmail(db, mailboxId, "uid-sctype");

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"summarize_classify"}, ${{ emailId }})`,
      ).resolves.toBeDefined();
    } finally {
      await close();
    }
  });

  it("has the idx_jobs_summarize_classify_inflight partial unique index", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const rows = await db.query`
        SELECT indexname FROM pg_indexes WHERE tablename = 'jobs'`;
      const indexNames = rows.map((r) => r.indexname as string);
      expect(indexNames).toContain("idx_jobs_summarize_classify_inflight");
    } finally {
      await close();
    }
  });

  it("blocks a second in-flight summarize_classify job for the same emailId, but allows one once the first has succeeded", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "scinflight@example.com");
      const mailboxId = await insertMailbox(
        db,
        userId,
        "scinflight-mb@example.com",
      );
      const emailId = await insertEmail(db, mailboxId, "uid-scinflight");

      await db.query`
        INSERT INTO jobs(type, payload)
        VALUES (${"summarize_classify"}, ${{ emailId }})`;

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"summarize_classify"}, ${{ emailId }})`,
      ).rejects.toThrow();

      await db.query`
        UPDATE jobs SET status = ${"succeeded"}
        WHERE payload->>'emailId' = ${emailId}`;

      await expect(
        db.query`
          INSERT INTO jobs(type, payload)
          VALUES (${"summarize_classify"}, ${{ emailId }})`,
      ).resolves.toBeDefined();

      const rows = await db.query`
        SELECT status FROM jobs
        WHERE payload->>'emailId' = ${emailId}
        ORDER BY created_at`;
      expect(rows).toEqual([{ status: "succeeded" }, { status: "pending" }]);
    } finally {
      await close();
    }
  });
});
