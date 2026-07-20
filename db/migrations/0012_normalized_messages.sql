-- User-scoped canonical messages and their mailbox-specific occurrences.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_key  TEXT NOT NULL,
  from_name     TEXT NOT NULL,
  from_address  TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL,
  summary       TEXT NULL,
  category      TEXT NULL CHECK (category IN ('requires_action', 'important', 'noise')),
  classified_at TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, identity_key)
);

CREATE INDEX idx_messages_category_received_at
  ON messages(user_id, category, received_at DESC);

CREATE TABLE mailbox_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id    UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider_uid  TEXT NOT NULL,
  seen          BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, provider_uid),
  UNIQUE (mailbox_id, message_id)
);

CREATE INDEX idx_mailbox_messages_message_id ON mailbox_messages(message_id);

-- Existing rows predate RFC Message-ID storage. Use the same conservative
-- fallback identity as new syncs so duplicate dev data converges on upgrade.
CREATE TEMP TABLE email_message_map (
  email_id UUID PRIMARY KEY,
  message_id UUID NOT NULL,
  identity_key TEXT NOT NULL
) ON COMMIT DROP;

WITH identified AS (
  SELECT
    e.*,
    m.user_id,
    'fallback:' || encode(digest(
      lower(btrim(e.from_address)) || E'\n' ||
      lower(regexp_replace(btrim(e.subject), '\s+', ' ', 'g')) || E'\n' ||
      floor(extract(epoch FROM e.received_at))::bigint::text || E'\n' ||
      encode(digest(convert_to(e.body, 'UTF8'), 'sha256'), 'hex'),
      'sha256'
    ), 'hex') AS identity_key
  FROM emails e
  JOIN mailboxes m ON m.id = e.mailbox_id
), representatives AS (
  SELECT DISTINCT ON (user_id, identity_key)
    user_id,
    identity_key,
    from_name,
    from_address,
    subject,
    body,
    received_at,
    summary,
    category,
    classified_at,
    created_at
  FROM identified
  ORDER BY
    user_id,
    identity_key,
    (classified_at IS NOT NULL) DESC,
    classified_at ASC NULLS LAST,
    created_at ASC,
    id ASC
), inserted AS (
  INSERT INTO messages(
    user_id, identity_key, from_name, from_address, subject, body,
    received_at, summary, category, classified_at, created_at
  )
  SELECT
    user_id, identity_key, from_name, from_address, subject, body,
    received_at, summary, category, classified_at, created_at
  FROM representatives
  RETURNING id, user_id, identity_key
)
INSERT INTO email_message_map(email_id, message_id, identity_key)
SELECT identified.id, inserted.id, identified.identity_key
FROM identified
JOIN inserted USING (user_id, identity_key);

INSERT INTO mailbox_messages(
  mailbox_id, message_id, provider_uid, seen, created_at
)
SELECT e.mailbox_id, map.message_id, e.provider_uid, e.seen, e.created_at
FROM emails e
JOIN email_message_map map ON map.email_id = e.id
ON CONFLICT DO NOTHING;

-- Old classify payloads cannot safely express canonical ownership. Delivery
-- jobs are rebuilt below after legacy duplicate attempts have converged.
DELETE FROM jobs WHERE type IN ('summarize_classify', 'deliver_channel');
DROP INDEX idx_jobs_summarize_classify_inflight;
CREATE UNIQUE INDEX idx_jobs_summarize_classify_inflight
  ON jobs ((payload->>'messageId'))
  WHERE type = 'summarize_classify' AND status IN ('pending', 'running');

ALTER TABLE delivery_attempts ADD COLUMN message_id UUID NULL;
UPDATE delivery_attempts da
SET message_id = map.message_id
FROM email_message_map map
WHERE map.email_id = da.email_id;

-- Keep one deterministic logical send if legacy mailbox duplicates already
-- produced multiple immediate attempts for the same channel.
DELETE FROM delivery_attempts duplicate
USING delivery_attempts keeper
WHERE duplicate.kind = 'immediate'
  AND keeper.kind = 'immediate'
  AND duplicate.channel_id = keeper.channel_id
  AND duplicate.message_id = keeper.message_id
  AND (
    CASE duplicate.status WHEN 'sent' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
    duplicate.created_at,
    duplicate.id
  ) > (
    CASE keeper.status WHEN 'sent' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
    keeper.created_at,
    keeper.id
  );

DROP INDEX idx_delivery_attempts_immediate_unique;
ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_shape_check;
ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_email_id_fkey;
ALTER TABLE delivery_attempts DROP COLUMN email_id;
ALTER TABLE delivery_attempts
  ADD CONSTRAINT delivery_attempts_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_shape_check
  CHECK (
    (
      kind = 'immediate'
      AND message_id IS NOT NULL
      AND scheduled_for IS NULL
      AND window_start IS NULL
      AND window_end IS NULL
    )
    OR
    (
      kind = 'digest'
      AND message_id IS NULL
      AND scheduled_for IS NOT NULL
      AND window_start IS NOT NULL
      AND window_end IS NOT NULL
      AND window_start < window_end
    )
    OR
    (
      kind = 'heartbeat'
      AND message_id IS NULL
      AND scheduled_for IS NOT NULL
      AND window_start IS NOT NULL
      AND window_end IS NOT NULL
      AND window_end = scheduled_for
      AND window_start < window_end
    )
  );
CREATE UNIQUE INDEX idx_delivery_attempts_immediate_unique
  ON delivery_attempts(channel_id, message_id)
  WHERE kind = 'immediate';

ALTER TABLE digest_items ADD COLUMN message_id UUID NULL;
UPDATE digest_items di
SET message_id = map.message_id
FROM email_message_map map
WHERE map.email_id = di.email_id;

-- A legacy digest may contain the same physical message through two mailboxes.
DELETE FROM digest_items duplicate
USING digest_items keeper
WHERE duplicate.delivery_attempt_id = keeper.delivery_attempt_id
  AND duplicate.message_id = keeper.message_id
  AND duplicate.position > keeper.position;

ALTER TABLE digest_items DROP CONSTRAINT digest_items_delivery_attempt_id_email_id_key;
ALTER TABLE digest_items DROP CONSTRAINT digest_items_email_id_fkey;
ALTER TABLE digest_items DROP COLUMN email_id;
ALTER TABLE digest_items ALTER COLUMN message_id SET NOT NULL;
ALTER TABLE digest_items
  ADD CONSTRAINT digest_items_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE digest_items
  ADD CONSTRAINT digest_items_delivery_attempt_id_message_id_key
  UNIQUE (delivery_attempt_id, message_id);

INSERT INTO jobs(type, payload, status)
SELECT
  'deliver_channel',
  jsonb_build_object('deliveryAttemptId', id::text),
  'pending'
FROM delivery_attempts
WHERE status = 'pending'
ON CONFLICT DO NOTHING;

DROP TABLE emails;

CREATE FUNCTION delete_orphan_message() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mailbox_messages mm WHERE mm.message_id = OLD.message_id
  ) THEN
    DELETE FROM jobs j
    USING delivery_attempts da
    WHERE j.type = 'deliver_channel'
      AND j.payload->>'deliveryAttemptId' = da.id::text
      AND da.message_id = OLD.message_id;

    DELETE FROM messages WHERE id = OLD.message_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER mailbox_messages_delete_orphan
AFTER DELETE ON mailbox_messages
FOR EACH ROW EXECUTE FUNCTION delete_orphan_message();
