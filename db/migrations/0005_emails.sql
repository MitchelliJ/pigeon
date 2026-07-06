-- Incremental Sync Engine & Watermarks: one row per synced message. See the
-- Incremental Sync Engine & Watermarks PRD Sec. 3.1. This file is
-- self-contained so it can be read on its own.

-- why: dedupe is a UNIQUE constraint, not a separate watermark cursor —
-- existence of a row with (mailbox_id, provider_uid) means "already synced",
-- so a re-run of a sync job can safely re-fetch and re-insert without
-- double-processing. `provider_uid` is the connector's own message
-- identifier (IMAP UID, Gmail id, etc.), opaque to us and only unique per
-- mailbox. `seen` mirrors the provider's read/unread flag at sync time.
-- `ON DELETE CASCADE` removes emails when their owning mailbox is deleted,
-- matching `mailboxes` in 0004.
CREATE TABLE emails (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id    UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  provider_uid  TEXT NOT NULL,
  seen          BOOLEAN NOT NULL DEFAULT false,
  from_name     TEXT NOT NULL,
  from_address  TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, provider_uid)
);

-- why: backs "list this mailbox's emails" and the cascade delete above.
CREATE INDEX idx_emails_mailbox_id ON emails(mailbox_id);

-- why: tracks the high-water mark for incremental sync — NULL means "never
-- synced" (a fresh mailbox), so the sync job knows to do a full initial pull
-- rather than an incremental one.
ALTER TABLE mailboxes ADD COLUMN last_synced_at TIMESTAMPTZ NULL;
