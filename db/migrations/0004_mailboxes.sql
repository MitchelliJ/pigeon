-- Inbox connectors: the mailbox a user connects (IMAP/POP3/OAuth or the
-- `mock` provider used in dev/demo). See the Inbox Connectors & Provider
-- Abstraction PRD Sec. 3.2.1. `citext` was already enabled by
-- 0003_users_sessions.sql, but this file is self-contained so it can be
-- read on its own.
CREATE EXTENSION IF NOT EXISTS citext;

-- why: one row per connected mailbox. `provider` distinguishes the concrete
-- integration (gmail/outlook/icloud/fastmail/imap/mock) while `protocol` is
-- the transport it actually speaks (imap/pop3/mock/gmail-oauth/
-- microsoft-oauth) — a Gmail mailbox may speak either imap or gmail-oauth,
-- so the two are tracked separately rather than derived from one another.
-- `address` is CITEXT so lookups/uniqueness are case-insensitive, matching
-- `users.email`. `password_ciphertext` holds the vault-sealed credential —
-- never a plaintext secret (see coding guidelines Sec. "Secrets & config").
-- `status` mirrors the connector's last known health and defaults to
-- 'connected' on insert (the happy path for a freshly verified mailbox).
-- The `(user_id, address)` uniqueness stops a user from connecting the same
-- mailbox twice; `ON DELETE CASCADE` removes mailboxes when their owning
-- user is deleted, matching `sessions`/`auth_tokens` in 0003.
CREATE TABLE mailboxes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('gmail','outlook','icloud','fastmail','imap','mock')),
  protocol             TEXT NOT NULL CHECK (protocol IN ('imap','pop3','mock','gmail-oauth','microsoft-oauth')),
  label                TEXT NOT NULL,
  address              CITEXT NOT NULL,
  host                 TEXT NOT NULL,
  port                 INTEGER NOT NULL,
  tls                  BOOLEAN NOT NULL DEFAULT true,
  username             TEXT NOT NULL,
  password_ciphertext  TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','syncing','disconnected','error')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, address)
);

-- why: backs "list this user's mailboxes" and the cascade delete above.
CREATE INDEX idx_mailboxes_user_id ON mailboxes(user_id);
