-- 0007: monthly usage counters for quota enforcement.

CREATE TABLE usage_counters (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- calendar month, e.g. '2026-07'
  period           text NOT NULL,
  emails_processed int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);
