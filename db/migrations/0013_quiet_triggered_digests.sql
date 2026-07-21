-- Obsolete immediate attempts must not send the legacy one-message format after
-- quiet delivery switches to digest snapshots. Preserve completed history.
UPDATE delivery_attempts
SET
  status = 'failed',
  last_error = 'Immediate quiet delivery superseded by digest delivery',
  updated_at = now()
WHERE kind = 'immediate' AND status = 'pending';

-- Quiet-triggered digests reuse digest attempts but may store the triggering
-- canonical message for idempotency. Scheduled daily digests keep message_id
-- NULL; immediate and heartbeat attempt shapes stay unchanged.
ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_shape_check;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_shape_check
  CHECK (
    (
      kind = 'immediate'
      AND message_id IS NOT NULL
      AND scheduled_for IS NULL
      AND window_start IS NULL
      AND window_end IS NULL
    )
    OR
    (
      kind = 'digest'
      AND scheduled_for IS NOT NULL
      AND window_start IS NOT NULL
      AND window_end IS NOT NULL
      AND window_start < window_end
    )
    OR
    (
      kind = 'heartbeat'
      AND message_id IS NULL
      AND scheduled_for IS NOT NULL
      AND window_start IS NOT NULL
      AND window_end IS NOT NULL
      AND window_end = scheduled_for
      AND window_start < window_end
    )
  );

CREATE UNIQUE INDEX idx_delivery_attempts_digest_message_unique
  ON delivery_attempts(channel_id, message_id)
  WHERE kind = 'digest' AND message_id IS NOT NULL;

-- A quiet channel cannot open another triggered digest while its current one
-- is pending. This also elects one winner across concurrent scheduler scans.
CREATE UNIQUE INDEX idx_delivery_attempts_pending_triggered_digest_unique
  ON delivery_attempts(channel_id)
  WHERE kind = 'digest' AND message_id IS NOT NULL AND status = 'pending';
