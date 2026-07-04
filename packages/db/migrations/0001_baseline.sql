-- 0001_baseline: infrastructure bookkeeping only, no domain tables yet.

-- Worker liveness: each worker process upserts its row on every heartbeat.
CREATE TABLE worker_heartbeats (
  worker_id  text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  seen_at    timestamptz NOT NULL
);
