-- Discord delivery schema: provider-neutral channel rows, delivery policy
-- settings, durable logical-send attempts, digest snapshots, and the queue job
-- type used by workers to perform external sends. See the Channel Connectors &
-- Delivery Modes (Discord) PRD Sec. 4.1.

-- why: PostgreSQL CHECK constraints cannot contain subqueries, so digest day
-- uniqueness lives in one immutable helper while the table constraint stays
-- readable. Days use ISO weekday numbering: 1 = Monday, 7 = Sunday.
CREATE FUNCTION delivery_digest_days_are_valid(days SMALLINT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(days) > 0
    AND days <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[]
    AND (
      SELECT COUNT(DISTINCT day)::INTEGER
      FROM unnest(days) AS day
    ) = cardinality(days);
$$;

-- why: one configured destination per user. `config_encrypted` is an opaque
-- vault-sealed connector config; delivery policy must never inspect plaintext
-- Discord webhook details.
CREATE TABLE channels (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('discord')),
  config_encrypted  TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active', 'error')),
  last_error        TEXT NULL,
  last_tested_at    TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- why: settings are user-owned rather than channel-owned so users can edit
-- delivery policy before connecting a channel; UTC is implicit by design.
CREATE TABLE delivery_settings (
  user_id                  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode                     TEXT NOT NULL DEFAULT 'daily' CHECK (mode IN ('daily', 'quiet')),
  digest_time              TIME NOT NULL DEFAULT '08:00',
  digest_days              SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::SMALLINT[],
  delivery_baseline_at     TIMESTAMPTZ NOT NULL,
  last_digest_cutoff_at    TIMESTAMPTZ NULL,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_settings_digest_days_check
    CHECK (delivery_digest_days_are_valid(digest_days))
);

-- why: logical-send attempts are inserted before external side effects so
-- schedulers and workers can dedupe retries without relying on Discord.
CREATE TABLE delivery_attempts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id           UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('immediate', 'digest')),
  email_id             UUID NULL REFERENCES emails(id) ON DELETE CASCADE,
  scheduled_for        TIMESTAMPTZ NULL,
  window_start         TIMESTAMPTZ NULL,
  window_end           TIMESTAMPTZ NULL,
  status               TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  omitted_count        INTEGER NOT NULL DEFAULT 0,
  provider_message_id  TEXT NULL,
  last_error           TEXT NULL,
  sent_at              TIMESTAMPTZ NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_attempts_omitted_count_check
    CHECK (omitted_count >= 0),
  CONSTRAINT delivery_attempts_shape_check
    CHECK (
      (
        kind = 'immediate'
        AND email_id IS NOT NULL
        AND scheduled_for IS NULL
        AND window_start IS NULL
        AND window_end IS NULL
      )
      OR
      (
        kind = 'digest'
        AND email_id IS NULL
        AND scheduled_for IS NOT NULL
        AND window_start IS NOT NULL
        AND window_end IS NOT NULL
        AND window_start < window_end
      )
    )
);

-- why: repeated scheduler ticks or concurrent workers must not create duplicate
-- logical sends for the same channel/email or scheduled digest window.
CREATE UNIQUE INDEX idx_delivery_attempts_immediate_unique
  ON delivery_attempts(channel_id, email_id)
  WHERE kind = 'immediate';

CREATE UNIQUE INDEX idx_delivery_attempts_digest_unique
  ON delivery_attempts(channel_id, scheduled_for)
  WHERE kind = 'digest';

CREATE INDEX idx_delivery_attempts_user_id
  ON delivery_attempts(user_id);

-- why: digest contents are snapshotted so retrying the same attempt sends the
-- same ordered summaries even if email classification data later changes.
CREATE TABLE digest_items (
  delivery_attempt_id  UUID NOT NULL REFERENCES delivery_attempts(id) ON DELETE CASCADE,
  email_id             UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  position             SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 25),
  category             TEXT NOT NULL CHECK (category IN ('requires_action', 'important', 'noise')),
  summary              TEXT NOT NULL,
  PRIMARY KEY (delivery_attempt_id, position),
  UNIQUE (delivery_attempt_id, email_id)
);

-- why: extend the closed queue job type enum for channel delivery while
-- preserving all previously shipped job types.
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check
  CHECK (type IN ('sync_mailbox', 'summarize_classify', 'deliver_channel'));

-- why: guarantees at most one in-flight delivery worker job per logical
-- attempt, keyed by the attempt id embedded in the JSON payload.
CREATE UNIQUE INDEX idx_jobs_deliver_channel_inflight
  ON jobs ((payload->>'deliveryAttemptId'))
  WHERE type = 'deliver_channel' AND status IN ('pending', 'running');
