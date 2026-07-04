/** Over-quota emails are filed without an LLM call and don't count usage. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@pigeon/config";
import { startTestDb, type TestDb } from "@pigeon/db/testing";
import type { LlmProvider } from "@pigeon/llm";
import { currentPeriod, tierLimits } from "@pigeon/quota";
import { processEmail } from "../src/jobs/triage.js";

const logger = createLogger("error", { name: "quota-triage-test" });

describe("email.process under quota pressure", () => {
  let db: TestDb;
  let userId: string;
  let mailboxId: string;
  let llmCalls = 0;

  const countingProvider: LlmProvider = {
    name: "counting",
    triage: async () => {
      llmCalls++;
      return { summary: "Summarized.", priority: "important", needsAttention: false };
    },
  };

  async function newEmail(dedupe: string): Promise<string> {
    const { rows } = await db.pool.query(
      `INSERT INTO emails (mailbox_id, user_id, dedupe_key, from_name, from_address, subject, body_text, received_at)
       VALUES ($1,$2,$3,'S','s@x.y','Subject here','Body',now()) RETURNING id`,
      [mailboxId, userId, dedupe],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = await startTestDb();
    const user = await db.pool.query(
      "INSERT INTO users (email, password_hash, tier) VALUES ('qq@t.dev','x','free') RETURNING id",
    );
    userId = user.rows[0].id;
    const mb = await db.pool.query(
      `INSERT INTO mailboxes (user_id, provider, protocol, address, host, port, tls, username, credentials_sealed)
       VALUES ($1,'mock','mock','qq@t.dev','mock',1,false,'q','x') RETURNING id`,
      [userId],
    );
    mailboxId = mb.rows[0].id;
  });
  afterAll(async () => {
    await db.stop();
  });

  it("processes normally within quota and counts usage", async () => {
    const emailId = await newEmail("<q1@x>");
    expect(await processEmail(db.pool, countingProvider, logger, emailId)).toBe("processed");
    expect(llmCalls).toBe(1);
    const { rows } = await db.pool.query(
      "SELECT emails_processed FROM usage_counters WHERE user_id = $1 AND period = $2",
      [userId, currentPeriod()],
    );
    expect(rows[0].emails_processed).toBe(1);
  });

  it("over quota: files the email without calling the LLM", async () => {
    await db.pool.query(
      "UPDATE usage_counters SET emails_processed = $2 WHERE user_id = $1",
      [userId, tierLimits("free").monthlyEmailQuota],
    );
    const emailId = await newEmail("<q2@x>");
    expect(await processEmail(db.pool, countingProvider, logger, emailId)).toBe("quota-exceeded");
    expect(llmCalls).toBe(1); // unchanged

    const { rows } = await db.pool.query("SELECT * FROM emails WHERE id = $1", [emailId]);
    expect(rows[0].processed_at).not.toBeNull();
    expect(rows[0].priority).toBe("everything");
    expect(rows[0].summary).toContain("quota");

    // Usage did NOT increment past the cap.
    const counter = await db.pool.query(
      "SELECT emails_processed FROM usage_counters WHERE user_id = $1 AND period = $2",
      [userId, currentPeriod()],
    );
    expect(counter.rows[0].emails_processed).toBe(tierLimits("free").monthlyEmailQuota);
    // Still routed to delivery (it may appear in the digest).
    const jobs = await db.pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE type = 'delivery.route'",
    );
    expect(jobs.rows[0].n).toBe(2);
  });
});
