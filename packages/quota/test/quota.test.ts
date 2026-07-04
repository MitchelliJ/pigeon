import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "@pigeon/db/testing";
import {
  canAddMailbox,
  canProcessEmail,
  currentPeriod,
  getUsage,
  incrementEmailsProcessed,
  tierLimits,
} from "../src/index.js";

describe("quota", () => {
  let db: TestDb;
  let userId: string;

  beforeAll(async () => {
    db = await startTestDb();
    const { rows } = await db.pool.query(
      "INSERT INTO users (email, password_hash, tier) VALUES ('q@t.dev','x','free') RETURNING id",
    );
    userId = rows[0].id;
  });
  afterAll(async () => {
    await db.stop();
  });

  it("period is a UTC calendar month", () => {
    expect(currentPeriod(new Date("2026-07-02T23:59:00Z"))).toBe("2026-07");
    expect(currentPeriod(new Date("2026-08-01T00:00:00Z"))).toBe("2026-08");
  });

  it("unknown tiers fall back to free limits", () => {
    expect(tierLimits("bogus")).toEqual(tierLimits("free"));
  });

  it("counts processed emails per month and enforces the cap", async () => {
    expect(await canProcessEmail(db.pool, userId, "free")).toBe(true);
    const cap = tierLimits("free").monthlyEmailQuota;
    await db.pool.query(
      "INSERT INTO usage_counters (user_id, period, emails_processed) VALUES ($1, $2, $3)",
      [userId, currentPeriod(), cap - 1],
    );
    expect(await canProcessEmail(db.pool, userId, "free")).toBe(true);
    await incrementEmailsProcessed(db.pool, userId);
    expect(await canProcessEmail(db.pool, userId, "free")).toBe(false);
    // A higher tier still has room with the same counter.
    expect(await canProcessEmail(db.pool, userId, "pro")).toBe(true);
  });

  it("mailbox allowance follows the tier", async () => {
    expect(await canAddMailbox(db.pool, userId, "free")).toBe(true);
    await db.pool.query(
      `INSERT INTO mailboxes (user_id, provider, protocol, address, host, port, tls, username, credentials_sealed)
       VALUES ($1,'mock','mock','q@t.dev','mock',1,false,'q','x')`,
      [userId],
    );
    expect(await canAddMailbox(db.pool, userId, "free")).toBe(false); // free = 1
    expect(await canAddMailbox(db.pool, userId, "pro")).toBe(true);

    const usage = await getUsage(db.pool, userId, "free");
    expect(usage.mailboxes).toBe(1);
    expect(usage.emailsProcessed).toBe(tierLimits("free").monthlyEmailQuota);
  });
});
