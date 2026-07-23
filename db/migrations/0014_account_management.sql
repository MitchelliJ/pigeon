-- Account-management schema constraints: users can hold a pending replacement
-- email address, scheduled deletion timestamps remain optional until set,
-- auth tokens admit change-email confirmation, and jobs can dedupe in-flight
-- account erasure work per user.

-- why: `pending_email` holds an unconfirmed replacement login address and must
-- compare case-insensitively like `users.email`; `deletion_requested_at` marks
-- accounts paused for later erasure, so both are nullable state flags.
ALTER TABLE users ADD COLUMN pending_email CITEXT NULL;
ALTER TABLE users ADD COLUMN deletion_requested_at TIMESTAMPTZ NULL;

-- why: backs scheduler/sweep queries that only care about accounts currently
-- pending deletion without bloating the index with the common NULL case.
CREATE INDEX idx_users_deletion_requested_at_pending
  ON users (deletion_requested_at)
  WHERE deletion_requested_at IS NOT NULL;

-- why: widen the closed auth-token kind enum for change-email confirmation
-- while preserving the existing verify-email and reset-password flows.
ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_kind_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_kind_check
  CHECK (kind IN ('verify_email', 'reset_password', 'change_email'));

-- why: extend the closed queue job type enum for account erasure while
-- preserving every previously shipped job type.
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check
  CHECK (
    type IN (
      'sync_mailbox',
      'summarize_classify',
      'deliver_channel',
      'erase_account'
    )
  );

-- why: guarantees at most one in-flight account erasure job per user while
-- allowing retries or future erasures after the current job finishes.
CREATE UNIQUE INDEX idx_jobs_erase_account_inflight
  ON jobs ((payload->>'userId'))
  WHERE type = 'erase_account' AND status IN ('pending', 'running');
