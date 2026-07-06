-- LLM Processing (Summarize + Classify): per-email summary/category plus the
-- job type that produces them. See the LLM Processing (Summarize + Classify)
-- PRD Sec. 3.1 FR-1..FR-4. This file is self-contained so it can be read on
-- its own.

-- why: all three columns are nullable because an email exists (from sync)
-- long before it is ever classified — NULL `category`/`classified_at` means
-- "not yet processed by the LLM", so the summarize_classify job can backfill
-- them idempotently. `category` is a closed enum via CHECK, mirroring the
-- other closed enums (`jobs.type`, `mailboxes.provider`) rather than a lookup
-- table.
ALTER TABLE emails ADD COLUMN summary TEXT NULL;
ALTER TABLE emails ADD COLUMN category TEXT NULL
  CHECK (category IN ('requires_action', 'important', 'noise'));
ALTER TABLE emails ADD COLUMN classified_at TIMESTAMPTZ NULL;

-- why: backs the dashboard's "list emails in a category, newest first" query,
-- which filters on category and orders by received_at descending.
CREATE INDEX idx_emails_category_received_at
  ON emails(category, received_at DESC);

-- why: free-text user preference steering how the LLM classifies their mail
-- (e.g. "newsletters are noise"). Nullable — most users never set it, in
-- which case the classifier falls back to its default prompt.
ALTER TABLE users ADD COLUMN classification_instructions TEXT NULL;

-- why: extend the closed `jobs.type` enum to admit this feature's job type,
-- following 0006's note that later features grow this CHECK in their own
-- migration. Postgres named the inline CHECK `jobs_type_check` by default, so
-- we drop and re-add it with the widened value set.
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check
  CHECK (type IN ('sync_mailbox', 'summarize_classify'));

-- why: guarantees at most one in-flight (pending or running) summarize_classify
-- job per email, keyed on the email id embedded in the JSON payload — mirrors
-- 0006's sync_mailbox in-flight index so a duplicate enqueue is a safe no-op
-- (`ON CONFLICT DO NOTHING`) rather than double-processing an email.
CREATE UNIQUE INDEX idx_jobs_summarize_classify_inflight
  ON jobs ((payload->>'emailId'))
  WHERE type = 'summarize_classify' AND status IN ('pending', 'running');
