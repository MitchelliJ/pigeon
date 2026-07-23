/*
 * Account-erasure job handler. It locks the target user row and, within one
 * transaction, either scrubs stale queued work or deletes the user once the
 * erasure window is genuinely due.
 */
import type { Db } from "../../db/index";

interface EraseAccountRow {
  deletion_requested_at: Date | string | null;
  deletion_due: boolean;
}

export async function handleEraseAccountJob(
  db: Db,
  jobId: string,
  payload: { userId: string },
): Promise<void> {
  await db.withTx(async (tx) => {
    const rows = (await tx`
      SELECT
        deletion_requested_at,
        deletion_requested_at + interval '24 hours' <= now() AS deletion_due
      FROM users
      WHERE id = ${payload.userId}
      FOR UPDATE
    `) as unknown as EraseAccountRow[];

    const user = rows[0];
    if (
      user === undefined ||
      user.deletion_requested_at === null ||
      user.deletion_due !== true
    ) {
      await tx`
        UPDATE jobs
        SET payload = '{}'::jsonb, updated_at = now()
        WHERE id = ${jobId}
      `;
      return;
    }

    await tx`
      UPDATE jobs
      SET payload = '{}'::jsonb
      WHERE id = ${jobId}
    `;

    await tx`
      DELETE FROM users
      WHERE id = ${payload.userId}
    `;
    return;
  });
}
