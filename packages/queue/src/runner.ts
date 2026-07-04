/**
 * Worker-side job runner: a registry of typed handlers plus a polling loop.
 * Polls fast while work is flowing, idles at `idleDelayMs` otherwise, and
 * periodically reaps jobs whose worker died mid-run.
 */
import type { Logger } from "@pigeon/config";
import type { Pool } from "@pigeon/db";
import { claimJob, completeJob, failJob, reapStuckJobs, type Job } from "./queue.js";

export interface HandlerContext {
  pool: Pool;
  logger: Logger;
}

export type JobHandler<P = unknown> = (
  payload: P,
  job: Job<P>,
  ctx: HandlerContext,
) => Promise<void>;

export interface Runner {
  register<P>(type: string, handler: JobHandler<P>): void;
  /** Resolves once the loop has stopped (call `stop()` to end it). */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Process due jobs until the queue is empty — used by tests. */
  drain(): Promise<number>;
}

export function createRunner(
  pool: Pool,
  logger: Logger,
  {
    concurrency = 4,
    idleDelayMs = 1_000,
    reapEveryMs = 60_000,
  }: { concurrency?: number; idleDelayMs?: number; reapEveryMs?: number } = {},
): Runner {
  const handlers = new Map<string, JobHandler<never>>();
  let running = false;
  let loopDone: Promise<void> | null = null;

  async function processOne(): Promise<boolean> {
    const job = await claimJob(pool, [...handlers.keys()]);
    if (!job) return false;
    const handler = handlers.get(job.type);
    if (!handler) {
      // Shouldn't happen (claim filters by registered types), but stay safe.
      await failJob(pool, job, `no handler for type ${job.type}`);
      return true;
    }
    const started = Date.now();
    try {
      await handler(job.payload as never, job as never, { pool, logger });
      await completeJob(pool, job.id);
      logger.debug("job done", { id: job.id, type: job.type, ms: Date.now() - started });
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      const outcome = await failJob(pool, job, message);
      logger.warn("job failed", {
        id: job.id,
        type: job.type,
        attempt: job.attempts,
        of: job.maxAttempts,
        outcome,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  async function loop() {
    let lastReap = 0;
    while (running) {
      if (Date.now() - lastReap > reapEveryMs) {
        lastReap = Date.now();
        const reaped = await reapStuckJobs(pool).catch(() => 0);
        if (reaped > 0) logger.warn("reaped stuck jobs", { count: reaped });
      }
      let didWork = false;
      try {
        const results = await Promise.all(
          Array.from({ length: concurrency }, () => processOne()),
        );
        didWork = results.some(Boolean);
      } catch (err) {
        logger.error("job loop error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!didWork) {
        await new Promise((r) => setTimeout(r, idleDelayMs));
      }
    }
  }

  return {
    register(type, handler) {
      if (handlers.has(type)) throw new Error(`handler for ${type} already registered`);
      handlers.set(type, handler as JobHandler<never>);
    },
    async start() {
      running = true;
      loopDone = loop();
      await loopDone;
    },
    async stop() {
      running = false;
      await loopDone;
    },
    async drain() {
      let n = 0;
      while (await processOne()) n++;
      return n;
    },
  };
}
