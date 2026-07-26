-- OAuth connectors: lets a mailbox authenticate via OAuth (Gmail/Microsoft)
-- instead of a stored password, and adds the transient state needed to
-- complete an OAuth authorize -> callback round-trip. See the OAuth Provider
-- Connectors PRD.

-- why: OAuth-based mailboxes carry a vault-sealed refresh token instead of a
-- password (never a plaintext secret, see coding guidelines Sec. "Secrets &
-- config"); `oauth_scope` records the space-delimited scopes actually
-- granted, for auditing/re-consent decisions. Both are nullable because only
-- OAuth protocols populate them.
ALTER TABLE mailboxes ADD COLUMN oauth_refresh_ciphertext TEXT NULL;
ALTER TABLE mailboxes ADD COLUMN oauth_scope TEXT NULL;

-- why: password is no longer the only supported credential shape now that
-- OAuth protocols exist.
ALTER TABLE mailboxes ALTER COLUMN password_ciphertext DROP NOT NULL;

-- why: a mailbox must carry exactly the credential its protocol needs —
-- password-based protocols never hold an OAuth token and vice versa, so the
-- two credential shapes are mutually exclusive rather than both-optional.
ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_credential_by_protocol_check
  CHECK (
    (protocol IN ('imap', 'pop3', 'mock') AND password_ciphertext IS NOT NULL AND oauth_refresh_ciphertext IS NULL)
    OR
    (protocol IN ('gmail-oauth', 'microsoft-oauth') AND oauth_refresh_ciphertext IS NOT NULL AND password_ciphertext IS NULL)
  );

-- why: short-lived, one-time-consumed state for the OAuth authorize ->
-- callback round-trip (PKCE code_verifier + CSRF state); rows are deleted
-- once the callback consumes them or once `expires_at` passes.
CREATE TABLE oauth_states (
  state         TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
