/*
 * Integration tests for `handleSummarizeClassifyJob` (LLM Processing —
 * Summarize + Classify PRD §3.1 FR-1..FR-4). This handler loads one email
 * (joined to its mailbox's owning user for `classification_instructions`),
 * hands it to an injected `LlmClassifier` — resolved lazily via a
 * `getClassifierFn` param, the same injectable-dependency pattern as
 * `handleSyncMailboxJob`'s `getConnectorFn` — and writes the result back:
 *   - on `{ ok: true, result }` it sets `summary`/`category`/`classified_at`,
 *     but only `WHERE ... summary IS NULL`, so re-running is a no-op;
 *   - on `{ ok: false, reason }` it throws that reason (mirrors
 *     `handleSyncMailboxJob`'s "throw on ok:false" discipline) so a later
 *     dispatch layer can route to `failJob`.
 *
 * Uses embedded Postgres via `withTestDb` + `runMigrations` and a fake
 * `LlmClassifier` (no real Mistral call) whose result the test sets before
 * each run, mirroring `createFakeConnector`'s mutable-result-holder pattern
 * in `../sync-mailbox.test.ts`.
 *
 * RED note: at authoring time `../../handlers/summarize-classify`
 * (`handleSummarizeClassifyJob`) does not exist yet — this file is expected to
 * fail at import/module-resolution time, not just at an assertion.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../../test/db";
import { runMigrations } from "../../../migrate/runner";
import { handleSummarizeClassifyJob } from "../../handlers/summarize-classify";
import type { Db } from "../../../db/index";
import type {
  LlmClassifier,
  ClassifyInput,
  ClassifyResult,
} from "../../../llm/index";

async function insertUser(
  db: Db,
  email: string,
  classificationInstructions?: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash, classification_instructions)
    VALUES (${email}, ${"U"}, ${"h"}, ${classificationInstructions ?? null})
    RETURNING id`;
  return String(rows[0]?.id);
}

async function insertMailbox(
  db: Db,
  userId: string,
  address: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${userId}, ${"imap"}, ${"imap"}, ${"Work"}, ${address},
      ${"imap.example.com"}, ${993}, ${true}, ${address},
      ${"gcm:iv:tag:ct"}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

interface EmailOverrides {
  summary?: string;
  category?: "requires_action" | "important" | "noise";
  classifiedAt?: Date;
}

/** Insert a canonical message and mailbox occurrence, optionally classified. */
async function insertEmail(
  db: Db,
  mailboxId: string,
  overrides: EmailOverrides = {},
): Promise<string> {
  const rows = await db.query`
    WITH inserted AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body,
        received_at, summary, category, classified_at
      )
      SELECT
        user_id, 'uid-1', 'Alice', 'alice@example.com', 'Hello', 'Body text',
        ${new Date("2026-01-01T00:00:00Z")}, ${overrides.summary ?? null},
        ${overrides.category ?? null}, ${overrides.classifiedAt ?? null}
      FROM mailboxes WHERE id = ${mailboxId}
      RETURNING id
    )
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    SELECT ${mailboxId}, id, 'uid-1', false FROM inserted
    RETURNING message_id`;
  return String(rows[0]?.message_id);
}

interface FakeClassifier extends LlmClassifier {
  result: ClassifyResult;
  lastInput: ClassifyInput | undefined;
}

/** A fake LlmClassifier whose `result` the test sets before each run and which
 *  records the last `input` it was handed (mirrors `createFakeConnector`). */
function createFakeClassifier(): FakeClassifier {
  const fake: FakeClassifier = {
    name: "fake",
    result: { ok: true, result: { summary: "s", category: "noise" } },
    lastInput: undefined,
    async classify(input: ClassifyInput) {
      fake.lastInput = input;
      return fake.result;
    },
  };
  return fake;
}

describe("handleSummarizeClassifyJob", () => {
  it("writes summary, category and classified_at onto the email on a successful classify", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "classify-success@example.com");
      const mailboxId = await insertMailbox(db, userId, "cs-mb@example.com");
      const emailId = await insertEmail(db, mailboxId);

      const fake = createFakeClassifier();
      fake.result = {
        ok: true,
        result: { summary: "A short summary", category: "important" },
      };

      await handleSummarizeClassifyJob(db, { messageId: emailId }, () => fake);

      const rows = await db.query`
        SELECT summary, category, classified_at
        FROM messages WHERE id = ${emailId}`;
      expect(rows[0]?.summary).toBe("A short summary");
      expect(rows[0]?.category).toBe("important");
      expect(rows[0]?.classified_at).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("passes the owning user's classification_instructions into classify()", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(
        db,
        "classify-instructions@example.com",
        "newsletters are noise",
      );
      const mailboxId = await insertMailbox(db, userId, "ci-mb@example.com");
      const emailId = await insertEmail(db, mailboxId);

      const fake = createFakeClassifier();
      fake.result = {
        ok: true,
        result: { summary: "x", category: "noise" },
      };

      await handleSummarizeClassifyJob(db, { messageId: emailId }, () => fake);

      expect(fake.lastInput?.classificationInstructions).toBe(
        "newsletters are noise",
      );
    } finally {
      await close();
    }
  });

  it("throws the classifier's failure reason when the result is ok: false", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "classify-failure@example.com");
      const mailboxId = await insertMailbox(db, userId, "cf-mb@example.com");
      const emailId = await insertEmail(db, mailboxId);

      const fake = createFakeClassifier();
      fake.result = { ok: false, reason: "boom" };

      await expect(
        handleSummarizeClassifyJob(db, { messageId: emailId }, () => fake),
      ).rejects.toThrow("boom");
    } finally {
      await close();
    }
  });

  it("leaves an already-classified email unchanged (summary IS NULL guard makes re-runs a no-op)", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "classify-idempotent@example.com");
      const mailboxId = await insertMailbox(db, userId, "cid-mb@example.com");
      const emailId = await insertEmail(db, mailboxId, {
        summary: "original summary",
        category: "noise",
        classifiedAt: new Date("2026-02-02T00:00:00Z"),
      });

      const fake = createFakeClassifier();
      fake.result = {
        ok: true,
        result: { summary: "overwritten", category: "important" },
      };

      await handleSummarizeClassifyJob(db, { messageId: emailId }, () => fake);

      const rows = await db.query`
        SELECT summary, category FROM messages WHERE id = ${emailId}`;
      expect(rows[0]?.summary).toBe("original summary");
      expect(rows[0]?.category).toBe("noise");
    } finally {
      await close();
    }
  });
});
