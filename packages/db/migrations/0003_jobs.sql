-- 0003: durable background job queue (rides the main database, no extra infra).

CREATE TABLE jobs (
  id              bigserial PRIMARY KEY,
  type            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending',
    -- pending | running | done | failed(dead)
  run_at          timestamptz NOT NULL DEFAULT now(),
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 5,
  locked_until    timestamptz,
  last_error      text,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Same logical work enqueued twice = one job.
CREATE UNIQUE INDEX jobs_idempotency_unique
  ON jobs (type, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Fast claiming of due work.
CREATE INDEX jobs_claim_idx ON jobs (run_at, id) WHERE status = 'pending';
-- Reaper scan.
CREATE INDEX jobs_running_idx ON jobs (locked_until) WHERE status = 'running';
