CREATE TABLE IF NOT EXISTS schema_migrations (
  id         BIGINT PRIMARY KEY,
  filename   TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);