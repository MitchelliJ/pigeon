-- 0008: Mollie billing — customers, subscriptions, webhook audit.

CREATE TABLE billing_customers (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mollie_customer_id text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier                   text NOT NULL,
  status                 text NOT NULL,
    -- pending (awaiting first payment) | active | canceled | past_due
  mollie_payment_id      text,
  mollie_subscription_id text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id, created_at DESC);
CREATE INDEX subscriptions_payment_idx ON subscriptions (mollie_payment_id);

-- Raw webhook payloads for audit/debugging; also the webhook dedupe anchor.
CREATE TABLE billing_events (
  id         bigserial PRIMARY KEY,
  mollie_id  text NOT NULL,
  kind       text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
