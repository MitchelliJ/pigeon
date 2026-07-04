-- 0004: connected mailboxes and triaged emails.

CREATE TABLE mailboxes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- badge/UX hint: gmail | outlook | icloud | fastmail | imap | mock
  provider           text NOT NULL,
  -- wire protocol: imap | pop3 | mock (oauth protocols land later)
  protocol           text NOT NULL,
  label              text NOT NULL DEFAULT '',
  address            text NOT NULL,
  host               text NOT NULL,
  port               int  NOT NULL,
  tls                boolean NOT NULL DEFAULT true,
  username           text NOT NULL,
  -- vault-sealed secret bundle (password or oauth tokens); never plaintext
  credentials_sealed text NOT NULL,
  status             text NOT NULL DEFAULT 'connected',
    -- connected | syncing | error | disconnected
  status_detail      text,
  -- protocol-specific watermark state (imap: uidValidity/lastUid,
  -- pop3: seen UIDL ring). Advanced only after messages are persisted.
  sync_state         jsonb NOT NULL DEFAULT '{}',
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mailboxes_user_idx ON mailboxes (user_id);

CREATE TABLE emails (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id             uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- rfc822 Message-ID when present, else a content hash; dedupe anchor
  dedupe_key             text NOT NULL,
  from_name              text NOT NULL DEFAULT '',
  from_address           text NOT NULL DEFAULT '',
  subject                text NOT NULL DEFAULT '',
  -- plain text, truncated at ingest (data minimization)
  body_text              text NOT NULL DEFAULT '',
  received_at            timestamptz NOT NULL,

  -- triage outcome (LLM job fills these; null = not yet processed)
  summary                text,
  priority               text,          -- urgent | important | everything
  needs_attention        boolean,
  suggested_action       text,
  processed_at           timestamptz,

  -- delivery bookkeeping (dedupe before send)
  delivered_immediate_at timestamptz,
  digested_at            timestamptz,

  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX emails_dedupe_unique ON emails (mailbox_id, dedupe_key);
CREATE INDEX emails_user_received_idx ON emails (user_id, received_at DESC);
CREATE INDEX emails_unprocessed_idx ON emails (created_at) WHERE processed_at IS NULL;
CREATE INDEX emails_digest_idx ON emails (user_id, processed_at)
  WHERE digested_at IS NULL AND processed_at IS NOT NULL;
