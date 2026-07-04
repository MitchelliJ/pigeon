/** Append-only audit log (GDPR accountability). Failures never break flows. */
import type pg from "pg";

export interface AuditEntry {
  userId?: string | null;
  actor: "user" | "system" | "worker";
  action: string;
  detail?: Record<string, unknown>;
}

export async function audit(
  db: pg.Pool | pg.PoolClient,
  entry: AuditEntry,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, actor, action, detail) VALUES ($1,$2,$3,$4)`,
      [entry.userId ?? null, entry.actor, entry.action, JSON.stringify(entry.detail ?? {})],
    );
  } catch {
    // Auditing is best-effort; the primary operation must not fail with it.
  }
}
