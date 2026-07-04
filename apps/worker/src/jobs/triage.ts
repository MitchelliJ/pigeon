/**
 * email.process: one LLM call per new email → summary, priority,
 * needs-attention; then hands off to delivery routing. Idempotent — a row
 * is only ever processed once (guarded by processed_at IS NULL).
 */
import type { Logger } from "@pigeon/config";
import { withTransaction, type Pool } from "@pigeon/db";
import { pickLlmProvider, type LlmProvider, type TriageResult } from "@pigeon/llm";
import { JOB_EMAIL_PROCESS } from "@pigeon/mail";
import { canProcessEmail, incrementEmailsProcessed } from "@pigeon/quota";
import { enqueue, type PeriodicTask, type Runner } from "@pigeon/queue";
import type { JobDeps } from "./index.js";

/** Registered by the channels feature; enqueued here after processing. */
export const JOB_DELIVERY_ROUTE = "delivery.route";

export type ProcessOutcome =
  | "processed"
  | "already-processed"
  | "missing"
  | "quota-exceeded";

export async function processEmail(
  pool: Pool,
  provider: LlmProvider,
  logger: Logger,
  emailId: string,
): Promise<ProcessOutcome> {
  const { rows } = await pool.query(
    `SELECT e.id, e.user_id, e.from_name, e.from_address, e.subject, e.body_text,
            e.processed_at, u.llm_instructions, u.tier
     FROM emails e JOIN users u ON u.id = e.user_id
     WHERE e.id = $1`,
    [emailId],
  );
  if (rows.length === 0) {
    logger.warn("email vanished before processing", { emailId });
    return "missing";
  }
  const email = rows[0];
  if (email.processed_at) return "already-processed";

  // Quota check BEFORE the LLM spend. Over budget → the email is filed
  // without a summary instead of burning tokens we can't bill for.
  const withinQuota = await canProcessEmail(pool, email.user_id, email.tier);
  let outcome: ProcessOutcome = "processed";
  let result: TriageResult;
  if (withinQuota) {
    result = await provider.triage({
      fromName: email.from_name,
      fromAddress: email.from_address,
      subject: email.subject,
      bodyText: email.body_text,
      instructions: email.llm_instructions || undefined,
    });
  } else {
    outcome = "quota-exceeded";
    result = {
      summary: `${email.subject || "(no subject)"} — monthly quota reached, not summarized`,
      priority: "everything",
      needsAttention: false,
    };
    logger.warn("monthly email quota exceeded, filing without LLM", {
      emailId,
      userId: email.user_id,
      tier: email.tier,
    });
  }

  await withTransaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE emails SET
         summary = $2,
         priority = $3,
         needs_attention = $4,
         suggested_action = $5,
         processed_at = now()
       WHERE id = $1 AND processed_at IS NULL`,
      [
        emailId,
        result.summary,
        result.priority,
        result.needsAttention,
        result.suggestedAction ?? null,
      ],
    );
    // Delivery routing rides the same transaction, exactly once per email.
    if ((updated.rowCount ?? 0) > 0) {
      await enqueue(client, JOB_DELIVERY_ROUTE, { emailId }, { idempotencyKey: emailId });
      // Usage counts only when the LLM actually ran.
      if (outcome === "processed") {
        await incrementEmailsProcessed(client, email.user_id);
      }
    }
  });

  logger.info("email triaged", {
    emailId,
    provider: outcome === "quota-exceeded" ? "none (quota)" : provider.name,
    priority: result.priority,
    needsAttention: result.needsAttention,
  });
  return outcome;
}

export function registerTriageJobs(runner: Runner, deps: JobDeps): PeriodicTask[] {
  const provider = pickLlmProvider(deps.config, deps.logger);

  runner.register<{ emailId: string }>(JOB_EMAIL_PROCESS, async (payload, _job, ctx) => {
    await processEmail(ctx.pool, provider, ctx.logger, payload.emailId);
  });

  return [];
}
