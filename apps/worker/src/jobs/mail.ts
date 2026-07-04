/** Mail feature jobs: per-mailbox sync + the periodic due-mailbox tick. */
import { JOB_MAILBOX_SYNC, listDueMailboxes, syncMailbox } from "@pigeon/mail";
import { tierLimits } from "@pigeon/quota";
import { enqueue, timeBucket, type PeriodicTask, type Runner } from "@pigeon/queue";
import type { JobDeps } from "./index.js";

export function registerMailJobs(runner: Runner, deps: JobDeps): PeriodicTask[] {
  runner.register<{ mailboxId: string }>(JOB_MAILBOX_SYNC, async (payload, _job, ctx) => {
    await syncMailbox(ctx.pool, deps.vault, ctx.logger, payload.mailboxId);
  });

  return [
    {
      name: "sync-due-mailboxes",
      everyMs: 60_000,
      async run(pool) {
        // Sync frequency is a tier limit — enforced here, at enqueue time.
        const due = await listDueMailboxes(pool, (tier) => tierLimits(tier).syncIntervalMs);
        for (const mailbox of due) {
          await enqueue(pool, JOB_MAILBOX_SYNC, { mailboxId: mailbox.id }, {
            idempotencyKey: `${mailbox.id}:${timeBucket(mailbox.intervalMs)}`,
          });
        }
      },
    },
  ];
}
