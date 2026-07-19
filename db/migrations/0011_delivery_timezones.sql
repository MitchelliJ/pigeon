-- Interpret digest times and weekdays in each user's configured IANA timezone.
CREATE FUNCTION delivery_timezone_is_valid(timezone_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
STRICT
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_timezone_names
    WHERE name = timezone_name
      AND name !~ '^(posix|right)/'
  );
$$;

ALTER TABLE delivery_settings
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  ADD CONSTRAINT delivery_settings_timezone_check
    CHECK (delivery_timezone_is_valid(timezone));

COMMENT ON COLUMN delivery_settings.timezone IS
  'IANA timezone used to interpret digest_time and digest_days as local wall-clock values.';
