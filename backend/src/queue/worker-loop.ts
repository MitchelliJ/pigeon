/*
 * Worker tick (Job Queue, Workers & Scheduler PRD §3.2, FR-11): claims up to
 * `concurrency` jobs, dispatches each by `type` to its handler, and runs all
 * claimed jobs concurrently so one slow job never blocks the others. Each
 * job is completed (`completeJob`) or failed (`failJob`) based on whether
 * its handler call resolved or rejected.
 */
import type { Db } from "../db/index";
import type { Vault } from "../vault/index";
import type { MailboxConnector } from "../mailboxes/connectors/types";
import { getConnector } from "../mailboxes/connectors/index";
import { mockLlmClassifier } from "../llm/index";
import type { LlmClassifier } from "../llm/index";
import { createChannelRegistry } from "../channels/registry";
import type { ChannelRegistry } from "../channels/registry";
import { claimJobs, completeJob, failJob } from "./store";
import { handleDeliverChannelJob } from "./handlers/deliver-channel";
import { handleSyncMailboxJob } from "./handlers/sync-mailbox";
import { handleSummarizeClassifyJob } from "./handlers/summarize-classify";
import type { Job } from "./types";

/** Run a single worker tick: claim, dispatch, and settle up to `concurrency` jobs. */
export async function runWorkerTick(
  db: Db,
  vault: Vault,
  concurrency: number,
  getConnectorFn: (
    protocol: "imap" | "pop3",
  ) => MailboxConnector = getConnector,
  classifier: LlmClassifier = mockLlmClassifier,
  connectTimeoutMs?: number,
  channelRegistry: ChannelRegistry = createChannelRegistry({ fetch }),
): Promise<void> {
  const jobs = await claimJobs(db, concurrency);

  function dispatch(job: Job): Promise<void> {
    switch (job.type) {
      case "sync_mailbox":
        return handleSyncMailboxJob(
          db,
          vault,
          job.payload as { mailboxId: string },
          getConnectorFn,
          connectTimeoutMs,
        );
      case "summarize_classify":
        return handleSummarizeClassifyJob(
          db,
          job.payload as { emailId: string },
          () => classifier,
        );
      case "deliver_channel":
        return handleDeliverChannelJob(
          db,
          vault,
          job.payload as { deliveryAttemptId: string },
          channelRegistry,
        );
      default: {
        // JobType is a closed set — any addition here must add a matching
        // case above, or this throws loudly instead of silently no-op-ing.
        const unreachable: never = job.type;
        throw new Error(
          `runWorkerTick: no handler for job type "${unreachable}"`,
        );
      }
    }
  }

  await Promise.allSettled(
    jobs.map(async (job) => {
      try {
        await dispatch(job);
        await completeJob(db, job.id, job.attempts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await failJob(db, job.id, message, job.attempts, job.maxAttempts);
      }
    }),
  );
}
