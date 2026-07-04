import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@pigeon/config";
import { startTestDb, type TestDb } from "@pigeon/db/testing";
import {
  claimJob,
  completeJob,
  countJobs,
  createRunner,
  createScheduler,
  enqueue,
  failJob,
  reapStuckJobs,
  timeBucket,
} from "../src/index.js";

const logger = createLogger("error", { name: "queue-test" });

describe("queue", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.stop();
  });
  beforeEach(async () => {
    await db.pool.query("TRUNCATE jobs RESTART IDENTITY");
  });

  it("enqueues and claims in run_at order", async () => {
    await enqueue(db.pool, "a", { n: 1 });
    await enqueue(db.pool, "a", { n: 2 });
    const first = await claimJob(db.pool);
    const second = await claimJob(db.pool);
    expect((first!.payload as { n: number }).n).toBe(1);
    expect((second!.payload as { n: number }).n).toBe(2);
    expect(await claimJob(db.pool)).toBeNull();
  });

  it("suppresses duplicate idempotency keys", async () => {
    const id1 = await enqueue(db.pool, "sync", { mailbox: "m1" }, { idempotencyKey: "m1:100" });
    const id2 = await enqueue(db.pool, "sync", { mailbox: "m1" }, { idempotencyKey: "m1:100" });
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();
    expect((await countJobs(db.pool)).pending).toBe(1);
  });

  it("does not claim future-scheduled jobs", async () => {
    await enqueue(db.pool, "later", {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await claimJob(db.pool)).toBeNull();
  });

  it("retries with backoff then dead-letters", async () => {
    await enqueue(db.pool, "flaky", {}, { maxAttempts: 2 });
    const j1 = await claimJob(db.pool);
    expect(await failJob(db.pool, j1!, "boom 1")).toBe("pending");
    // backoff pushed run_at into the future
    expect(await claimJob(db.pool)).toBeNull();
    await db.pool.query("UPDATE jobs SET run_at = now() WHERE id = $1", [j1!.id]);
    const j2 = await claimJob(db.pool);
    expect(j2!.attempts).toBe(2);
    expect(await failJob(db.pool, j2!, "boom 2")).toBe("failed");
    expect((await countJobs(db.pool)).failed).toBe(1);
  });

  it("reaps jobs whose lock expired", async () => {
    await enqueue(db.pool, "crashy");
    await claimJob(db.pool);
    expect(await reapStuckJobs(db.pool)).toBe(0);
    await db.pool.query("UPDATE jobs SET locked_until = now() - interval '1 second'");
    expect(await reapStuckJobs(db.pool)).toBe(1);
    expect((await countJobs(db.pool)).pending).toBe(1);
  });

  it("runner drains registered handlers and records failures", async () => {
    const seen: number[] = [];
    const runner = createRunner(db.pool, logger);
    runner.register<{ n: number }>("ok", async (p) => {
      seen.push(p.n);
    });
    runner.register("bad", async () => {
      throw new Error("nope");
    });
    await enqueue(db.pool, "ok", { n: 7 });
    await enqueue(db.pool, "bad", {}, { maxAttempts: 1 });
    const processed = await runner.drain();
    expect(processed).toBe(2);
    expect(seen).toEqual([7]);
    const counts = await countJobs(db.pool);
    expect(counts.done).toBe(1);
    expect(counts.failed).toBe(1);
  });

  it("scheduler tick enqueues idempotently across double ticks", async () => {
    const everyMs = 60_000;
    const scheduler = createScheduler(db.pool, logger, [
      {
        name: "demo",
        everyMs: 0, // always due
        run: async (pool) => {
          await enqueue(pool, "tick-work", {}, { idempotencyKey: timeBucket(everyMs) });
        },
      },
    ]);
    await scheduler.tick();
    await scheduler.tick();
    expect((await countJobs(db.pool)).pending).toBe(1);
  });
});
