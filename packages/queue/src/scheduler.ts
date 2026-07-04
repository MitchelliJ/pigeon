/**
 * Periodic task scheduler ("cron tick"). Every tick it runs each due task,
 * which — per the project's cross-cutting rules — must only ENQUEUE jobs,
 * never do real work. Idempotency keys derived from the time bucket make
 * ticks safe to repeat and safe across multiple workers.
 */
import type { Logger } from "@pigeon/config";
import type { Pool } from "@pigeon/db";

export interface PeriodicTask {
  name: string;
  /** How often the task wants to run. */
  everyMs: number;
  /** Enqueue work for the current moment. */
  run(pool: Pool, logger: Logger): Promise<void>;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** Force one pass over all due tasks — used by tests. */
  tick(): Promise<void>;
}

/** Stable idempotency key for "this work, this time window". */
export function timeBucket(everyMs: number, at = Date.now()): string {
  return String(Math.floor(at / everyMs) * everyMs);
}

export function createScheduler(
  pool: Pool,
  logger: Logger,
  tasks: PeriodicTask[],
  { tickEveryMs = 15_000 }: { tickEveryMs?: number } = {},
): Scheduler {
  const lastRun = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  async function tick() {
    if (ticking) return; // never overlap ticks
    ticking = true;
    try {
      for (const task of tasks) {
        const last = lastRun.get(task.name) ?? 0;
        if (Date.now() - last < task.everyMs) continue;
        lastRun.set(task.name, Date.now());
        try {
          await task.run(pool, logger);
        } catch (err) {
          logger.error("periodic task failed", {
            task: task.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      timer = setInterval(() => void tick(), tickEveryMs);
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
