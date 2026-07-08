-- Fix a latent foreign-key hazard on `invites.created_by_user_id`.
--
-- 0003 created this column as `REFERENCES users(id)` with no ON DELETE action,
-- defaulting to NO ACTION — unlike every other FK to `users` in the schema,
-- which cascades. No code populates the column yet, so the FK is currently
-- dormant; but the moment a "user invites another user" flow sets it, deleting
-- any user who has minted an invite would throw a foreign-key violation and
-- abort the delete — breaking account erasure. SET NULL keeps the invite row
-- (its `code_hash`/`consumed_at` history stays intact) while dropping the tie
-- to the deleted account, matching the column's own "NULL = no owning user"
-- semantics.

ALTER TABLE invites
  DROP CONSTRAINT invites_created_by_user_id_fkey;

ALTER TABLE invites
  ADD CONSTRAINT invites_created_by_user_id_fkey
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
