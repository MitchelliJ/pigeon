-- Job Queue, Workers & Scheduler: a single generic `jobs` table backing all
-- background work. See the Job Queue, Workers & Scheduler PRD Sec. 3.1
-- FR-1. This file is self-contained so it can be read on its own.

-- why: `type` is a closed enum via CHECK rather than a lookup table since the
-- set of job types is small and code-defined; later features add their own
-- job types by extending this CHECK in their own migration, mirroring how
-- `mailboxes.provider`/`protocol` grow across migrations.
-- why: `status` is likewise a closed enum covering the full lifecycle of a
-- job: queued (`pending`), claimed by a worker (`running`), and its two
-- terminal states (`succeeded`, `failed`).
-- why: `locked_at`/`last_error` are nullable because most jobs complete on
-- their first attempt without ever being retried or erroring — they only
-- get populated once a worker claims a job or it fails.
CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL CHECK (type IN ('sync_mailbox')),
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at     TIMESTAMPTZ NULL,
  last_error    TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- why: backs the scheduler's poll query — "give me pending jobs whose
-- run_at has passed" — which filters on status and orders by run_at.
CREATE INDEX idx_jobs_status_run_at ON jobs(status, run_at);

-- why: guarantees at most one in-flight (pending or running) sync_mailbox
-- job per mailbox, keyed on the mailbox id embedded in the JSON payload.
-- An enqueue attempt while one already exists is meant to be a no-op at the
-- application layer (`ON CONFLICT DO NOTHING`), not a hard error — this
-- index only exists to make that no-op safe under concurrent enqueues.
CREATE UNIQUE INDEX idx_jobs_sync_mailbox_inflight
  ON jobs ((payload->>'mailboxId'))
  WHERE type = 'sync_mailbox' AND status IN ('pending', 'running');
