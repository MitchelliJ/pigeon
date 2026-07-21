# PRD — Quiet Mode Triggered Digests

## 1. Problem statement

Quiet mode currently sends a separate Discord notification for each canonical
message classified as `requires_action`. That makes quiet mode deliver a
different unit of information than daily mode: quiet sends one email summary,
while daily sends one ranked digest snapshot.

Change quiet mode so daily and quiet modes deliver the same digest-shaped
message. Daily mode controls scheduled delivery time. Quiet mode controls trigger
time: it stays silent until a new `requires_action` canonical message appears,
then sends the same ranked, capped digest that daily mode would send for the
currently open window.

## 2. Known facts

- Pigeon now stores canonical emails in `messages`; a canonical message may be
  linked to multiple mailboxes through `mailbox_messages`.
- A delivered digest item contains only:
  - category label: `Requires action`, `Important`, or `Noise`;
  - the AI-generated one-sentence summary.
- Daily mode already sends the correct user-facing unit:
  - one provider-neutral `DeliveryMessage` with `type: "digest"`;
  - one Discord webhook POST;
  - one embed rendered by the existing digest renderer;
  - up to 25 digest fields;
  - an overflow notice when more messages are available;
  - ranking by `requires_action`, then `important`, then `noise`, then newest
    message first.
- Daily digest contents are snapshotted in `digest_items`, so retries resend the
  exact same category/summary list even if source message rows later change.
- Current quiet mode uses `scheduleImmediateDeliveries` to create one
  `delivery_attempts.kind = 'immediate'` row per `requires_action` canonical
  message. The delivery handler turns that attempt into `DeliveryMessage` with
  `type: "immediate"`.
- Delivery windows are controlled by `delivery_settings.delivery_baseline_at`
  and `delivery_settings.last_digest_cutoff_at`.
- Mode changes reset the delivery baseline, clear the digest cutoff, and fail
  pending attempts from the previous mode.
- Quiet heartbeats currently decide whether the user has heard from Pigeon by
  checking successful immediate deliveries.
- User decisions for this change:
  - Quiet-triggered delivery includes all classified canonical messages since
    the last successful digest cutoff, not only the action messages.
  - If multiple action messages are waiting before the worker runs, quiet mode
    sends one combined digest.
  - Quiet mode should inherit daily digest content, ordering, cap, overflow
    notice, and Discord presentation exactly.

## 3. Unknowns

No blocking product unknowns remain.

Implementation assumptions:

- The current digest title, including the words `Pigeon daily digest`, remains
  unchanged for quiet-triggered digests because quiet mode must inherit the
  daily presentation exactly.
- The existing `immediate` delivery type may remain in code or schema for legacy
  history, but no new quiet-mode scheduler path should produce immediate
  user-facing notifications after this change.

## 4. Proposed Solution

Replace quiet-mode per-message notifications with quiet-triggered digest
snapshots.

### Delivery semantics

For an active quiet-mode channel, on each scheduler tick:

1. Compute the open delivery window:
   - `window_start = last_digest_cutoff_at ?? delivery_baseline_at`
   - `window_end = scheduler now`
2. Check whether the open window contains at least one eligible trigger message:
   - canonical message belongs to the same user;
   - `category = 'requires_action'`;
   - `summary IS NOT NULL`;
   - `classified_at > window_start`;
   - `classified_at <= window_end`;
   - `received_at >= delivery_baseline_at`.
3. If no trigger message exists, do nothing. Important/noise messages alone do
   not wake quiet mode.
4. If at least one trigger message exists, create one digest attempt for the
   channel and snapshot all eligible messages in the open window:
   - any category: `requires_action`, `important`, or `noise`;
   - non-null summary and category;
   - `classified_at > window_start`;
   - `classified_at <= window_end`;
   - `received_at >= delivery_baseline_at`.
5. Rank and cap the snapshot exactly like daily mode:
   - `requires_action` first;
   - `important` second;
   - `noise` third;
   - then newest received email first, using the existing deterministic
     tie-breakers;
   - store at most 25 rows in `digest_items`;
   - store `omitted_count` as the count of eligible rows beyond those 25.
6. Enqueue exactly one `deliver_channel` job for the attempt in the same
   transaction.

The delivery worker should build quiet-triggered messages through the same digest
path as daily mode. The connector should receive:

```ts
{
  type: "digest",
  items: [...],
  omittedCount: number
}
```

It must not receive `type: "immediate"` for newly scheduled quiet-mode work.

On successful delivery, the existing digest success behavior should close the
window by setting `last_digest_cutoff_at = window_end`. This closes every message
in the window, including overflow messages not shown because of the 25-field
Discord cap. Important/noise messages that arrive after the cutoff do not send
quiet-mode delivery by themselves; they wait until a later action message or the
user switches to daily mode.

### Idempotency and overlapping work

Quiet mode must never create overlapping pending digest attempts for the same
channel.

- If multiple `requires_action` messages qualify before one scheduler tick runs,
  create one quiet-triggered digest containing the full ranked window.
- If the scheduler runs repeatedly before the worker sends the pending digest,
  keep the existing pending snapshot and do not create another attempt.
- If another action message is classified after a quiet-triggered snapshot is
  created but before that snapshot is successfully sent, it belongs to the next
  open window after the first snapshot succeeds.
- Retryable connector failures reuse the same attempt and `digest_items`
  snapshot.
- Permanent invalid-channel failures mark the channel `error`, so schedulers stop
  creating new delivery work until the user reconnects.
- Permanent payload failures must not create an infinite loop of replacement
  attempts for the same failed window.

A practical implementation is to treat quiet-triggered sends as
`delivery_attempts.kind = 'digest'` attempts that also store the triggering
`requires_action` message in `delivery_attempts.message_id`. Daily scheduled
digests keep `message_id = NULL`. The trigger message provides a stable
idempotency key while `digest_items` remains the source of delivered content.

### Naming

Rename quiet-mode scheduling code away from `immediate` terminology where it is
part of active behavior. Suggested names:

- `scheduleQuietTriggeredDigests`
- `quiet-triggered digest`
- `triggerMessageId`

Legacy database values or helper types may retain `immediate` only where removing
them would create unnecessary migration risk.

### Heartbeats

Quiet-mode heartbeats should consider a successful quiet-triggered digest as a
recent user-facing quiet-mode delivery. After this change, a successful
quiet-triggered digest should suppress the weekly reassurance heartbeat for the
same quiet window in the same way a successful immediate delivery did before.

## 5. Pitfalls

- **Accidentally sending both old and new quiet messages:** the worker currently
  calls the immediate scheduler. Replace that scheduler call rather than adding a
  second scheduler beside it.
- **Overlapping quiet digests:** using only `scheduled_for = now` as the unique
  key can create duplicate snapshots when scheduler ticks run with different
  timestamps before the worker sends. Add a pending-attempt guard and a stable
  trigger idempotency key.
- **Changed content across retries:** quiet-triggered delivery must read from
  `digest_items`, not mutable `messages`, just like daily mode.
- **Cutoff advancement before success:** do not advance `last_digest_cutoff_at`
  when scheduling. Advance it only after the connector reports success.
- **Closing only visible messages:** a successful digest closes the whole window,
  including omitted overflow rows. Otherwise overflow would repeat forever.
- **Heartbeat regression:** if heartbeat checks only `kind = 'immediate'`, users
  who already received a quiet-triggered digest may still get a reassurance
  heartbeat. Update the heartbeat query and freshness check.
- **Mode-change races:** pending quiet-triggered digest attempts are digest
  attempts. Existing mode-change cancellation must still fail them so stale
  windows do not send after the user switches modes.
- **Legacy pending immediate attempts:** old pending immediate attempts should
  not send the obsolete one-email format after deployment. Mark them failed in
  migration or ensure the handler no-ops them safely.
- **Renderer drift:** do not create separate quiet copy or quiet renderer logic.
  Quiet-triggered delivery should use the same `DeliveryMessage.type = "digest"`
  path as daily mode.

## 6. Related problems

- A future neutral digest title could rename `Pigeon daily digest` to something
  mode-agnostic. That is intentionally out of scope because quiet mode must
  inherit current daily presentation exactly.
- Additional channels such as WhatsApp or Signal benefit from this change because
  they only need to implement the existing digest delivery shape.
- A future delivery history page can distinguish scheduled daily digests from
  quiet-triggered digests by whether a digest attempt has a trigger message.

## 7. Alternatives considered

### Keep current immediate messages

This preserves existing code and sends the fastest/smallest notification, but it
violates the desired product model because quiet and daily modes deliver
different information units.

### Send only requires-action messages in quiet digest

This would reduce noise, but it would still make quiet mode's delivered unit
different from daily mode. The user explicitly chose all categories since the
last cutoff.

### Create separate quiet digest renderer/copy

This could produce clearer copy, but it risks drift between modes. The user
explicitly said quiet mode should inherit daily content, ordering, cap, overflow,
and Discord presentation exactly.

### Keep `kind = 'immediate'` and attach digest items

This could reuse some uniqueness behavior, but the name and shape would keep
misleading old semantics. Quiet-triggered delivery is a digest and should use the
digest send path wherever practical.

## 8. User Stories

- As a quiet-mode user, I want Pigeon to stay silent until an email requires my
  action so that I am interrupted only when there is something I need to do.
- As a quiet-mode user, when Pigeon interrupts me, I want the same ranked digest
  I would have received in daily mode so that I get the full context of what has
  happened since the last delivery.
- As a quiet-mode user, I want multiple action emails that arrive close together
  to produce one combined digest so that I am not spammed with overlapping
  Discord messages.
- As a Pigeon operator, I want quiet-triggered delivery to reuse digest snapshots
  and retry behavior so that failures and retries are idempotent.

## 9. Functional Requirements

1. Quiet mode must no longer schedule one Discord message per canonical
   `requires_action` message.
2. Quiet mode must create a digest delivery only when at least one new eligible
   `requires_action` canonical message exists in the open delivery window.
3. A quiet-triggered digest must include all eligible canonical messages in the
   open window, across all categories.
4. A quiet-triggered digest must use the same item ordering as daily digest.
5. A quiet-triggered digest must use the same 25-item cap as daily digest.
6. A quiet-triggered digest must use the same overflow notice as daily digest.
7. A quiet-triggered digest must use the same Discord renderer/presentation as
   daily digest.
8. A quiet-triggered digest must snapshot delivered item category and summary in
   `digest_items` before sending.
9. A quiet-triggered digest retry must resend the same snapshot.
10. A successful quiet-triggered digest must advance `last_digest_cutoff_at` to
    the attempt `window_end`.
11. Scheduling a quiet-triggered digest must not advance
    `last_digest_cutoff_at` before successful delivery.
12. Repeated scheduler ticks before worker success must not create overlapping
    quiet-triggered digest attempts for the same channel.
13. Multiple qualifying action messages present before scheduling must produce
    one combined digest attempt.
14. Daily mode behavior must remain unchanged except for shared refactors.
15. Important/noise messages alone must not trigger quiet-mode delivery.
16. Quiet heartbeats must treat successful quiet-triggered digests as recent
    quiet-mode activity.
17. The worker must not emit `DeliveryMessage.type = "immediate"` for newly
    scheduled quiet-mode work.
18. User-facing quiet-mode copy in the frontend must describe action-triggered
    digests, not per-email notifications.
19. Existing pending obsolete immediate attempts must not send one-email quiet
    notifications after this change is deployed.
20. Canonical-message deduplication must be preserved: if the same email is
    linked to multiple mailboxes, it appears once in a quiet-triggered digest.

## 10. Technical Requirements

- Add a forward-only SQL migration for any schema/index/constraint changes.
- Preserve existing hand-written SQL style and module boundaries.
- Continue using the durable queue; no work should be coupled directly to the
  classification handler.
- Use the existing embedded Postgres test fixture for scheduler, migration, and
  delivery-handler coverage.
- Keep connector adapters unaware of daily vs quiet scheduling policy; they
  should only receive provider-neutral delivery messages.
- Keep webhook URLs and other connector secrets encrypted and out of logs.
- Update names, tests, and comments that refer to active quiet delivery as
  `immediate` when those references would now be misleading.

## 11. Acceptance criteria

1. Given a quiet-mode user with one active Discord channel and one new
   `requires_action` canonical message, when the scheduler and worker run, then
   exactly one Discord message is sent and its provider-neutral payload is
   `type: "digest"`.
2. Given a quiet-mode user with `requires_action`, `important`, and `noise`
   messages in the open window, when the action message triggers delivery, then
   the sent digest includes all three categories using daily digest ordering.
3. Given only important/noise messages in quiet mode, when the scheduler runs,
   then no delivery attempt or job is created.
4. Given multiple action messages before the worker runs, when quiet scheduling
   happens, then one digest attempt is created for the channel, not one attempt
   per action message.
5. Given repeated scheduler ticks before a pending quiet-triggered digest is
   sent, then no overlapping quiet-triggered digest is created.
6. Given more than 25 eligible messages in the quiet-triggered window, then only
   the top 25 are snapshotted and `omitted_count` records the overflow.
7. Given a retryable connector failure, when the delivery job retries, then it
   sends the same `digest_items` snapshot.
8. Given a successful quiet-triggered digest, then `last_digest_cutoff_at` is set
   to the attempt `window_end`.
9. Given a quiet-triggered digest was sent during the heartbeat window, then the
   heartbeat scheduler does not send a reassurance heartbeat for that window.
10. Given daily mode users, daily digest scheduling and delivery continue to pass
    the existing digest tests.
11. Given normalized duplicate mailbox messages for the same canonical message,
    a quiet-triggered digest includes that canonical message once.
12. Given old pending immediate attempts at deployment, they do not result in the
    old one-email Discord format being sent after the new code is running.

## 12. Open Questions

None.

## 13. Non-Goals (Out of Scope)

- Renaming the digest title or changing Discord presentation copy.
- Adding sender, subject, body, mailbox labels, links, or email actions to
  Discord delivery.
- Sending more than one Discord message to bypass Discord's 25-field embed cap.
- Changing the daily digest schedule algorithm.
- Changing LLM classification or summary generation.
- Adding new channels or two-way channel interactions.
