/*
 * End-to-end wiring test for the summarize + classify pipeline (LLM Processing
 * PRD FR-24): scheduler tick → job queue → worker tick, exercised against a
 * real embedded Postgres with a fake `LlmClassifier` standing in for Mistral.
 *
 * The flow under test, with no mailbox sync involved:
 *   1. an email exists (from a prior sync) with `summary IS NULL`;
 *   2. one `enqueueDueClassifyJobs(db)` tick enqueues a `summarize_classify`
 *      job for it (the scheduler side, per FR-9);
 *   3. one `runWorkerTick(...)` tick claims, dispatches to the classifier, and
 *      completes it (the worker side).
 * After both ticks the email carries its summary/category/classified_at and the
 * job row is `succeeded`.
 *
 * A `vault` is still required positionally by `runWorkerTick` even though no
 * mailbox credential is decrypted here, so we build one with the shared
 * `TEST_VAULT_KEY`. The connector factory arg is passed `undefined` (no
 * sync_mailbox job is dispatched) so the worker falls back to its default.
 *
 * RED note: at authoring time `runWorkerTick` neither accepts a classifier
 * param nor dispatches `summarize_classify` jobs, so the job stays `pending`
 * and the email is never classified (and the 5th argument is an arity mismatch
 * at compile time) — that is the expected RED.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { createVault } from "../../vault/index";
import { enqueueDueClassifyJobs } from "../scheduler";
import { runWorkerTick } from "../worker-loop";
import type { Db } from "../../db/index";
import type { Vault } from "../../vault/index";
import type {
  LlmClassifier,
  ClassifyInput,
  ClassifyResult,
} from "../../llm/index";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";

async function insertUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, ${"U"}, ${"h"})
    RETURNING id`;
  return String(rows[0]?.id);
}

async function insertMailbox(
  db: Db,
  vault: Vault,
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
      ${vault.seal("fake-password")}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

/** Insert a minimal valid emails row with `summary IS NULL`, returning its id. */
async function insertEmail(db: Db, mailboxId: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO emails(
      mailbox_id, provider_uid, seen, from_name, from_address,
      subject, body, received_at
    ) VALUES (
      ${mailboxId}, ${"uid-e2e"}, ${false}, ${"Alice"},
      ${"alice@example.com"}, ${"Hello"}, ${"Body text"},
      ${new Date("2026-01-01T00:00:00Z")}
    ) RETURNING id`;
  return String(rows[0]?.id);
}

/** A fake LlmClassifier resolving a fixed successful classification. */
function createFakeClassifier(): LlmClassifier {
  const result: ClassifyResult = {
    ok: true,
    result: { summary: "A short summary", category: "requires_action" },
  };
  return {
    name: "fake",
    async classify(_input: ClassifyInput) {
      return result;
    },
  };
}

describe("summarize + classify e2e wiring (FR-24)", () => {
  it("classifies an unprocessed email via one scheduler tick followed by one worker tick", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const vault = createVault(TEST_VAULT_KEY);
      const userId = await insertUser(db, "e2e-classify@example.com");
      const mailboxId = await insertMailbox(
        db,
        vault,
        userId,
        "e2e-classify-mb@example.com",
      );
      const emailId = await insertEmail(db, mailboxId);

      await enqueueDueClassifyJobs(db);
      await runWorkerTick(db, vault, 5, undefined, createFakeClassifier());

      const emailRows = await db.query`
        SELECT summary, category, classified_at
        FROM emails WHERE id = ${emailId}`;
      expect(emailRows[0]?.summary).toBe("A short summary");
      expect(emailRows[0]?.category).toBe("requires_action");
      expect(emailRows[0]?.classified_at).not.toBeNull();

      const jobRows = await db.query`
        SELECT status FROM jobs WHERE payload->>'emailId' = ${emailId}`;
      expect(jobRows[0]?.status).toBe("succeeded");
    } finally {
      await close();
    }
  });
});
