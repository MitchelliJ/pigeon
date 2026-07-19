-- Quiet-mode heartbeats are scheduled deliveries without an email payload.
ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_kind_check;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_kind_check
  CHECK (kind IN ('immediate', 'digest', 'heartbeat'));

ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_shape_check;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_shape_check
  CHECK (
    (
      kind = 'immediate'
      AND email_id IS NOT NULL
      AND scheduled_for IS NULL
      AND window_start IS NULL
      AND window_end IS NULL
    )
    OR
    (
      kind = 'digest'
      AND email_id IS NULL
      AND scheduled_for IS NOT NULL
      AND window_start IS NOT NULL
      AND window_end IS NOT NULL
      AND window_start < window_end
    )
    OR
    (
      kind = 'heartbeat'
      AND email_id IS NULL
      AND scheduled_for IS NOT NULL
      AND window_start IS NOT NULL
      AND window_end IS NOT NULL
      AND window_end = scheduled_for
      AND window_start < window_end
    )
  );

CREATE UNIQUE INDEX idx_delivery_attempts_heartbeat_unique
  ON delivery_attempts(channel_id, scheduled_for)
  WHERE kind = 'heartbeat';
