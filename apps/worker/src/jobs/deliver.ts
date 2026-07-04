/** Delivery jobs: immediate routing, daily digests (+ quiet reassurance). */
import {
  isDigestDue,
  listDigestCandidates,
  routeEmail,
  sendDigest,
  userClock,
} from "@pigeon/deliver";
import { enqueue, type PeriodicTask, type Runner } from "@pigeon/queue";
import type { JobDeps } from "./index.js";
import { JOB_DELIVERY_ROUTE } from "./triage.js";

export const JOB_DIGEST_SEND = "digest.send";

export function registerDeliveryJobs(runner: Runner, deps: JobDeps): PeriodicTask[] {
  runner.register<{ emailId: string }>(JOB_DELIVERY_ROUTE, async (payload, _job, ctx) => {
    await routeEmail(ctx.pool, deps.vault, ctx.logger, payload.emailId);
  });

  runner.register<{ userId: string }>(JOB_DIGEST_SEND, async (payload, _job, ctx) => {
    await sendDigest(ctx.pool, deps.vault, ctx.logger, payload.userId);
  });

  return [
    {
      name: "digest-due",
      everyMs: 60_000,
      async run(pool) {
        const candidates = await listDigestCandidates(pool);
        const now = new Date();
        for (const settings of candidates) {
          if (
            !isDigestDue(
              {
                digestTime: settings.digestTime,
                digestDays: settings.digestDays,
                timezone: settings.timezone,
                lastDigestAt: settings.lastDigestAt,
              },
              now,
            )
          ) {
            continue;
          }
          const dateKey = userClock(settings.timezone, now).dateKey;
          await enqueue(pool, JOB_DIGEST_SEND, { userId: settings.userId }, {
            idempotencyKey: `digest:${settings.userId}:${dateKey}`,
          });
        }
      },
    },
  ];
}
