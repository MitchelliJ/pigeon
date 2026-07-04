/** email.process job: triage persists once, enqueues delivery routing once. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@pigeon/config";
import { startTestDb, type TestDb } from "@pigeon/db/testing";
import { createMockProvider, type LlmProvider } from "@pigeon/llm";
import { JOB_DELIVERY_ROUTE, processEmail } from "../src/jobs/triage.js";

const logger = createLogger("error", { name: "triage-test" });

describe("email.process", () => {
  let db: TestDb;
  let emailId: string;

  beforeAll(async () => {
    db = await startTestDb();
    const user = await db.pool.query(
      `INSERT INTO users (email, password_hash, llm_instructions)
       VALUES ('t@t.dev', 'x', 'treat hosting as urgent') RETURNING id`,
    );
    const mailbox = await db.pool.query(
      `INSERT INTO mailboxes (user_id, provider, protocol, address, host, port, tls, username, credentials_sealed)
       VALUES ($1, 'mock', 'mock', 'a@b.c', 'mock', 1, false, 'a@b.c', 'v1.k.x.x.x') RETURNING id`,
      [user.rows[0].id],
    );
    const email = await db.pool.query(
      `INSERT INTO emails (mailbox_id, user_id, dedupe_key, from_name, from_address, subject, body_text, received_at)
       VALUES ($1, $2, '<e1@x>', 'Hosting Co', 'ops@hosting.example', 'Server bill', 'Your hosting invoice is due Friday.', now())
       RETURNING id`,
      [mailbox.rows[0].id, user.rows[0].id],
    );
    emailId = email.rows[0].id;
  });
  afterAll(async () => {
    await db.stop();
  });

  it("processes an email: persists triage and enqueues delivery routing", async () => {
    const outcome = await processEmail(db.pool, createMockProvider(), logger, emailId);
    expect(outcome).toBe("processed");

    const { rows } = await db.pool.query("SELECT * FROM emails WHERE id = $1", [emailId]);
    expect(rows[0].summary).toBeTruthy();
    expect(rows[0].priority).toBe("urgent"); // instructions said hosting = urgent
    expect(rows[0].needs_attention).toBe(true);
    expect(rows[0].processed_at).not.toBeNull();

    const jobs = await db.pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE type = $1",
      [JOB_DELIVERY_ROUTE],
    );
    expect(jobs.rows[0].n).toBe(1);
  });

  it("is idempotent: re-running changes nothing and enqueues nothing", async () => {
    const before = await db.pool.query("SELECT summary, processed_at FROM emails WHERE id = $1", [emailId]);
    const outcome = await processEmail(db.pool, createMockProvider(), logger, emailId);
    expect(outcome).toBe("already-processed");
    const after = await db.pool.query("SELECT summary, processed_at FROM emails WHERE id = $1", [emailId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const jobs = await db.pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE type = $1",
      [JOB_DELIVERY_ROUTE],
    );
    expect(jobs.rows[0].n).toBe(1);
  });

  it("a failing provider leaves the email unprocessed (job will retry)", async () => {
    const email2 = await db.pool.query(
      `INSERT INTO emails (mailbox_id, user_id, dedupe_key, from_name, from_address, subject, body_text, received_at)
       SELECT mailbox_id, user_id, '<e2@x>', 'X', 'x@x.x', 'Hello', 'Hi there', now()
       FROM emails WHERE id = $1 RETURNING id`,
      [emailId],
    );
    const failing: LlmProvider = {
      name: "failing",
      triage: async () => {
        throw new Error("LLM exploded");
      },
    };
    await expect(
      processEmail(db.pool, failing, logger, email2.rows[0].id),
    ).rejects.toThrow("LLM exploded");
    const { rows } = await db.pool.query(
      "SELECT processed_at FROM emails WHERE id = $1",
      [email2.rows[0].id],
    );
    expect(rows[0].processed_at).toBeNull();
  });
});
