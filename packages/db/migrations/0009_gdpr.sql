-- 0009: GDPR — consent records, audit log, erasure request tracking.

CREATE TABLE consents (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,      -- terms | privacy | marketing
  version    text NOT NULL DEFAULT 'v1',
  granted    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_user_idx ON consents (user_id, kind, created_at DESC);

-- No FK on user_id: the log must survive account erasure (with the id as
-- the only remaining, meaningless reference).
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid,
  actor      text NOT NULL,      -- user | system | worker
  action     text NOT NULL,      -- e.g. auth.login, mailbox.create, gdpr.erase
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, created_at DESC);

CREATE TABLE erasure_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  status       text NOT NULL DEFAULT 'pending',   -- pending | done
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
