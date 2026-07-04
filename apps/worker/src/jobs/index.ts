/**
 * Central registration point: every feature adds its job handlers and
 * periodic (cron-tick) tasks here. Periodic tasks only enqueue; handlers do
 * the actual work — see the cross-cutting principles in the project spec.
 */
import type { Config, Logger } from "@pigeon/config";
import type { PeriodicTask, Runner } from "@pigeon/queue";
import type { Vault } from "@pigeon/vault";
import { registerDeliveryJobs } from "./deliver.js";
import { registerGdprJobs } from "./gdpr.js";
import { registerMailJobs } from "./mail.js";
import { registerTriageJobs } from "./triage.js";

export interface JobDeps {
  config: Config;
  logger: Logger;
  vault: Vault;
}

export function registerJobs(
  runner: Runner,
  deps: JobDeps,
): { periodicTasks: PeriodicTask[] } {
  const periodicTasks: PeriodicTask[] = [
    ...registerMailJobs(runner, deps),
    ...registerTriageJobs(runner, deps),
    ...registerDeliveryJobs(runner, deps),
    ...registerGdprJobs(runner, deps),
  ];
  return { periodicTasks };
}
