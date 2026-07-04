/**
 * Pigeon worker — minimal runtime scaffold.
 *
 * The worker will host the durable job queue + scheduler (feature 5) and run
 * sync/triage/delivery jobs. For now it just proves the runtime is alive with
 * a periodic heartbeat and shuts down cleanly.
 */
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? 30_000);

console.log("🕊️  Pigeon worker started");

const timer = setInterval(() => {
  console.log(`worker heartbeat @ ${new Date().toISOString()}`);
}, HEARTBEAT_MS);

function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down.`);
  clearInterval(timer);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
