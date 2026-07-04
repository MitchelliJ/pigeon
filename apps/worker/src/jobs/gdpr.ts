/**
 * GDPR jobs: account erasure and retention cleanup.
 * Erasure: the users row cascades through every feature table; job payloads
 * that reference the user are scrubbed best-effort. Retention: old emails,
 * deliveries, finished jobs and stale audit entries are pruned daily.
 */
import { createHash } from "node:crypto";
import { audit } from "@pigeon/db";
import type { PeriodicTask, Runner } from "@pigeon/queue";
import type { JobDeps } from "./index.js";

export const JOB_GDPR_ERASE = "gdpr.erase";

export const RETENTION = {
  emailsDays: 90,
  deliveriesDays: 90,
  doneJobsDays: 7,
  auditDays: 365,
};

export function registerGdprJobs(runner: Runner, _deps: JobDeps): PeriodicTask[] {
  runner.register<{ userId: string; requestId: string }>(
    JOB_GDPR_ERASE,
    async (payload, _job, ctx) => {
      const { rows } = await ctx.pool.query("SELECT email FROM users WHERE id = $1", [
        payload.userId,
      ]);
      if (rows.length === 0) {
        // Already erased (job retry) — just close the request.
        await ctx.pool.query(
          "UPDATE erasure_requests SET status = 'done', completed_at = now() WHERE id = $1",
          [payload.requestId],
        );
        return;
      }
      const emailHash = createHash("sha256").update(rows[0].email.toLowerCase()).digest("hex");

      // The cascade wipes mailboxes, emails, sessions, channels, settings,
      // deliveries, usage, billing rows, consents.
      await ctx.pool.query("DELETE FROM users WHERE id = $1", [payload.userId]);
      // Scrub queued jobs that reference the user or their (now gone) data.
      await ctx.pool.query(
        `DELETE FROM jobs
         WHERE status IN ('pending', 'failed')
           AND payload::text LIKE '%' || $1 || '%'`,
        [payload.userId],
      );
      await ctx.pool.query(
        "UPDATE erasure_requests SET status = 'done', completed_at = now() WHERE id = $1",
        [payload.requestId],
      );
      await audit(ctx.pool, {
        actor: "worker",
        action: "gdpr.erase.completed",
        detail: { emailHash }, // no readable identity remains
      });
      ctx.logger.info("account erased", { requestId: payload.requestId });
    },
  );

  return [
    {
      name: "retention-cleanup",
      everyMs: 6 * 60 * 60 * 1000, // 4x/day is plenty
      async run(pool, logger) {
        const emails = await pool.query(
          `DELETE FROM emails WHERE created_at < now() - interval '${RETENTION.emailsDays} days'`,
        );
        const deliveries = await pool.query(
          `DELETE FROM deliveries WHERE created_at < now() - interval '${RETENTION.deliveriesDays} days'`,
        );
        const jobs = await pool.query(
          `DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '${RETENTION.doneJobsDays} days'`,
        );
        const auditRows = await pool.query(
          `DELETE FROM audit_log WHERE created_at < now() - interval '${RETENTION.auditDays} days'`,
        );
        const sessions = await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
        const total =
          (emails.rowCount ?? 0) +
          (deliveries.rowCount ?? 0) +
          (jobs.rowCount ?? 0) +
          (auditRows.rowCount ?? 0) +
          (sessions.rowCount ?? 0);
        if (total > 0) {
          logger.info("retention cleanup", {
            emails: emails.rowCount,
            deliveries: deliveries.rowCount,
            jobs: jobs.rowCount,
            audit: auditRows.rowCount,
            sessions: sessions.rowCount,
          });
        }
      },
    },
  ];
}
