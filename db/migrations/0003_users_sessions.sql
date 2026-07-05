-- Identity layer: every later feature (inboxes, channels, billing, quotas)
-- keys off the `users` row and the session cookie introduced here. See the
-- Authentication & User Accounts PRD Sec. 3.1.1.

-- citext gives case-insensitive email comparison + uniqueness.
CREATE EXTENSION IF NOT EXISTS citext;

-- why: the account row every resource attaches to. Email is unique and
-- case-insensitive; `name` is required so `SessionUser.name` is always
-- populated; `pending_invite_code_hash` records the invite presented at
-- sign-up so verify-time can consume it (PRD FR-10).
CREATE TABLE users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  CITEXT UNIQUE NOT NULL,
  password_hash         TEXT NOT NULL,
  name                   TEXT NOT NULL,
  tier                   TEXT NOT NULL DEFAULT 'free',
  email_verified_at     TIMESTAMPTZ,
  pending_invite_code_hash TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- why: opaque, hashed-at-rest session tokens in an httpOnly cookie. The
-- `user_id` index backs "revoke all of this user's sessions" (logout-others on
-- password reset); `token_hash` is unique so a cookie maps to at most one row.
CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  UNIQUE (token_hash)
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);

-- why: a single table for both verify-email and reset-password tokens,
-- discriminated by `kind`. `token_hash` unique -> single-use lookup; the
-- `(user_id, kind)` index backs "void outstanding tokens of this kind for this
-- user" before minting a fresh one.
CREATE TABLE auth_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('verify_email','reset_password')),
  token_hash   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  UNIQUE (token_hash)
);

CREATE INDEX idx_auth_tokens_user_kind ON auth_tokens(user_id, kind);

-- why: invite-gated sign-up. Only the SHA-256 `code_hash` is stored (the
-- plaintext code is printed once by the CLI, never persisted). `created_by_user_id`
-- is NULL for CLI-minted invites (the operator isn't a user).
CREATE TABLE invites (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash           TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ,
  consumed_at         TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id),
  UNIQUE (code_hash)
);