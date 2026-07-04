-- 0006: notification channels, per-user delivery settings, send audit/dedupe.

CREATE TABLE channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL,                     -- discord | whatsapp | signal
  label         text NOT NULL DEFAULT '',
  -- vault-sealed JSON config ({ webhookUrl } for discord, ...)
  config_sealed text NOT NULL,
  -- immediate sends only for emails at/above this priority
  min_priority  text NOT NULL DEFAULT 'urgent',    -- urgent | important | everything
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channels_user_idx ON channels (user_id);

CREATE TABLE delivery_settings (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  digest_enabled    boolean NOT NULL DEFAULT true,
  digest_time       text NOT NULL DEFAULT '08:00',  -- HH:MM, user's timezone
  digest_days       text[] NOT NULL DEFAULT '{Mon,Tue,Wed,Thu,Fri,Sat,Sun}',
  digest_channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  timezone          text NOT NULL DEFAULT 'Europe/Amsterdam',
  -- "we're still here, it's just been quiet" message when a digest is empty
  quiet_reassurance boolean NOT NULL DEFAULT true,
  last_digest_at    timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Every outbound message, for auditing and (via dedupe_key) exactly-once sends.
CREATE TABLE deliveries (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  kind       text NOT NULL,          -- immediate | digest | reassurance | test
  email_id   uuid REFERENCES emails(id) ON DELETE SET NULL,
  dedupe_key text NOT NULL,
  status     text NOT NULL DEFAULT 'sent',   -- sent | failed
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deliveries_dedupe_unique ON deliveries (dedupe_key);
CREATE INDEX deliveries_user_idx ON deliveries (user_id, created_at DESC);
