/*
 * Summarize-classify job handler (LLM Processing — Summarize + Classify PRD
 * §3.3, FR-10). `handleSummarizeClassifyJob` is the worker-side entry point a
 * "summarize + classify this email" job dispatches to: it loads one email
 * (joined to its mailbox's owning user for that user's optional
 * `classification_instructions`), hands it to an injected `LlmClassifier`, and
 * writes the summary + triage category back onto the email.
 *
 * The classifier is resolved lazily via a `getClassifierFn` param — the same
 * injectable-dependency pattern as `handleSyncMailboxJob`'s `getConnectorFn` —
 * so tests can feed a fake without a real Mistral call.
 *
 * Two invariants mirror the sibling handler:
 *   - the write is guarded by `WHERE ... summary IS NULL`, so a re-run never
 *     double-summarizes (jobs must be idempotent);
 *   - a classifier `{ ok: false, reason }` is re-thrown as an Error (like
 *     `handleSyncMailboxJob`'s "throw on ok:false" discipline) so a later
 *     dispatch layer can route to `failJob`.
 */
import type { Db } from "../../db/index";
import type { LlmClassifier } from "../../llm/index";

export async function handleSummarizeClassifyJob(
  db: Db,
  payload: { messageId: string },
  getClassifierFn: () => LlmClassifier,
): Promise<void> {
  const rows = await db.query`
    SELECT
      e.from_name AS from_name,
      e.from_address AS from_address,
      e.subject AS subject,
      e.body AS body,
      e.summary AS summary,
      u.classification_instructions AS classification_instructions
    FROM messages e
    JOIN users u ON u.id = e.user_id
    WHERE e.id = ${payload.messageId}`;
  const row = rows[0] as
    | {
        from_name: string;
        from_address: string;
        subject: string;
        body: string;
        summary: string | null;
        classification_instructions: string | null;
      }
    | undefined;
  if (!row) {
    // A job whose payload references an email that no longer exists is a
    // programming/data error, not a classifier-level failure — throw directly
    // instead of going through the { ok: false } path.
    throw new Error("email not found");
  }

  if (row.summary !== null) {
    return;
  }

  const result = await getClassifierFn().classify({
    fromName: row.from_name,
    fromAddress: row.from_address,
    subject: row.subject,
    body: row.body,
    classificationInstructions: row.classification_instructions ?? undefined,
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }

  await db.query`
    UPDATE messages
    SET summary = ${result.result.summary},
        category = ${result.result.category},
        classified_at = now()
    WHERE id = ${payload.messageId} AND summary IS NULL`;
}
