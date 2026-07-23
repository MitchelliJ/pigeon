/*
 * Pure account-deletion scheduling helpers shared by profile flows and workers.
 */

export const ACCOUNT_DELETION_GRACE_DURATION_MS = 24 * 60 * 60 * 1000;

export interface DeletionSchedule {
  requestedAt: string | null;
  deletesAt: string | null;
}

export function getDeletionSchedule(
  deletionRequestedAt: unknown,
): DeletionSchedule {
  if (deletionRequestedAt === null || deletionRequestedAt === undefined) {
    return {
      requestedAt: null,
      deletesAt: null,
    };
  }

  const requestedAt =
    deletionRequestedAt instanceof Date
      ? deletionRequestedAt.toISOString()
      : new Date(String(deletionRequestedAt)).toISOString();

  return {
    requestedAt,
    deletesAt: new Date(
      new Date(requestedAt).getTime() + ACCOUNT_DELETION_GRACE_DURATION_MS,
    ).toISOString(),
  };
}
