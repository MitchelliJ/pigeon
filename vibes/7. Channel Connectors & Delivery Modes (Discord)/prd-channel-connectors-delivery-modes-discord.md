# PRD — 7. Channel Connectors & Delivery Modes (Discord)

> Deliver Pigeon's triage to one user-configured Discord webhook. Users choose
> either a ranked daily digest or quiet mode, which sends only newly classified
> `requires_action` emails immediately. The first connector is Discord, but the
> delivery domain is provider-neutral so Signal, WhatsApp, and other connectors
> can be added without changing scheduling or delivery policy.

---

## 1. Problem statement

Pigeon can sync, summarize, and classify email, but users must still open the
web app to see the result. This breaks the product promise of turning multiple
inboxes into a trustworthy signal in a channel the user already watches.

This feature adds one-way Discord webhook delivery and two mutually exclusive
modes:

- **Daily digest:** once at the configured UTC time on configured weekdays,
  send up to 25 newly classified emails, ranked by relevance.
- **Quiet mode:** send no digest and immediately notify only for newly
  classified `requires_action` emails.

Users may configure only one delivery channel at a time. The implementation
must make Discord the first adapter, not a Discord-specific delivery system.

---

## 2. Known facts

- Discord uses an outgoing webhook URL supplied by the user. No Discord bot,
  OAuth flow, inbound events, or Discord account linking is required.
- Only one delivery channel may be configured per user at a time.
- A user must disconnect the current channel before connecting another one.
- Connecting a channel sends a visible test message first. The channel is saved
  only after Discord accepts that message.
- Webhook credentials are secrets and must be encrypted with the existing
  vault module. They must never be returned by an API or written to logs.
- Delivery modes are mutually exclusive:
  - Daily mode sends no immediate alerts. All categories are considered only
    at the scheduled digest.
  - Quiet mode sends each new `requires_action` classification immediately and
    never sends a daily digest.
- There is no user-configurable category threshold.
- A delivery contains only the category and one-sentence summary for each
  email. It does not include sender, subject, mailbox, body, or an email link.
- Digests rank `requires_action` first, then `important`, then `noise`; within
  each category, newest emails come first.
- A digest contains at most 25 emails. Additional eligible emails are counted
  and reported as available in the dashboard, but are considered handled for
  delivery and are not rolled into a later digest.
- The digest period starts after the last successful digest. When delivery is
  first configured or its mode changes, the baseline resets to that moment so
  old emails do not produce notifications.
- An empty scheduled digest sends a short reassurance message.
- Scheduling uses UTC only. The default is 08:00 UTC on every day of the week.
  No browser timezone detection or manual timezone selection is included.
- A permanently invalid/deleted webhook disables the channel, records an error
  state, and shows that reconnection is required.
- Basic Discord copy ships with this feature, and message rendering must
  centralize this copy so it is easy to replace later:
  - Test: `Pigeon test message — Discord delivery is connected.`
  - Immediate alert heading: `Requires action`
  - Digest heading: `Pigeon daily digest`
  - Empty digest: `No new emails since your last digest.`
  - Overflow notice: `+{count} more email(s) are available in Pigeon.`
- The existing PostgreSQL queue, worker, scheduler, vault, authentication, and
  dashboard are reused. The next migration is `0009`.

---

## 3. Unknowns

- The final user-facing Discord message copy and tone are not yet supplied.
- Discord webhooks cannot accept a caller-provided idempotency key. A process
  crash after Discord accepts a message but before PostgreSQL records success
  creates an unavoidable ambiguous outcome: retrying may duplicate the message,
  while not retrying may lose it. This PRD requires durable best-effort dedupe
  for all non-ambiguous cases and documents this external-system limitation.
- Signal and WhatsApp authentication/configuration shapes are intentionally
  unknown. The connector interface must not assume every future channel uses a
  URL or Discord's payload structure.

---

## 4. Proposed Solution

### 4.1 Data model (`db/migrations/0009_discord_delivery.sql`)

Add the following forward-only schema in one transaction.

#### `channels`

One configured destination per user:

- `id UUID PRIMARY KEY`
- `user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE`
- `kind TEXT NOT NULL CHECK (kind IN ('discord'))`
- `config_encrypted TEXT NOT NULL`
- `status TEXT NOT NULL CHECK (status IN ('active', 'error'))`
- `last_error TEXT NULL` — sanitized, user-safe reason only
- `last_tested_at TIMESTAMPTZ NOT NULL`
- `created_at`, `updated_at TIMESTAMPTZ NOT NULL`

The `UNIQUE (user_id)` constraint is the concurrency backstop for the one-channel
rule. The encrypted config is an opaque connector-owned object. For Discord it
contains `{ webhookUrl }`; delivery policy must never inspect it.

#### `delivery_settings`

One settings row per user, created lazily on first read/update or channel
connection:

- `user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE`
- `mode TEXT NOT NULL CHECK (mode IN ('daily', 'quiet')) DEFAULT 'daily'`
- `digest_time TIME NOT NULL DEFAULT '08:00'`
- `digest_days SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]`
  (`1 = Monday`, `7 = Sunday`), constrained to unique values in that range and
  at least one selected day
- `delivery_baseline_at TIMESTAMPTZ NOT NULL`
- `last_digest_cutoff_at TIMESTAMPTZ NULL`
- `updated_at TIMESTAMPTZ NOT NULL`

All schedule calculations interpret `digest_time` and weekdays as UTC. There is
no timezone column.

Changing `mode`, connecting a channel, or disconnecting a channel resets
`delivery_baseline_at` to `now()` and clears `last_digest_cutoff_at`. Editing
only the time/weekdays does not reset the baseline.

#### `delivery_attempts`

A durable logical-send record used before queueing any external side effect:

- `id UUID PRIMARY KEY`
- `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE`
- `kind TEXT NOT NULL CHECK (kind IN ('immediate', 'digest'))`
- `email_id UUID NULL REFERENCES emails(id) ON DELETE CASCADE`
- `scheduled_for TIMESTAMPTZ NULL`
- `window_start TIMESTAMPTZ NULL`
- `window_end TIMESTAMPTZ NULL`
- `status TEXT NOT NULL CHECK (status IN ('pending','sent','failed'))`
- `omitted_count INTEGER NOT NULL DEFAULT 0`
- `provider_message_id TEXT NULL`
- `last_error TEXT NULL`
- `sent_at`, `created_at`, `updated_at TIMESTAMPTZ NULL/NOT NULL as appropriate`

Constraints enforce the valid shape: immediate attempts have `email_id` and no
window; digest attempts have a schedule/window and no `email_id`.

Unique indexes enforce one immediate logical send per `(channel_id, email_id)`
and one digest logical send per `(channel_id, scheduled_for)`. Queue jobs carry
only `deliveryAttemptId`.

#### `digest_items`

Snapshot the selected digest contents so retries send the same ordered data:

- `delivery_attempt_id UUID NOT NULL REFERENCES delivery_attempts(id) ON DELETE CASCADE`
- `email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE`
- `position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 25)`
- `category TEXT NOT NULL`
- `summary TEXT NOT NULL`
- primary/unique constraints on `(delivery_attempt_id, position)` and
  `(delivery_attempt_id, email_id)`

Snapshotting category/summary prevents retries from changing content. Empty
runs have no `digest_items` rows.

#### Queue extension

Extend `jobs_type_check` with `deliver_channel`. Add a partial unique index on
`payload->>'deliveryAttemptId'` for pending/running `deliver_channel` jobs.

### 4.2 Provider-neutral channel module (`backend/src/channels/`)

Define a stable outbound connector boundary. Delivery policy produces a
provider-neutral message; adapters translate it to provider payloads.

```ts
type DeliveryMessage =
  | { type: "test" }
  | { type: "immediate"; category: Category; summary: string }
  | {
      type: "digest";
      items: Array<{ category: Category; summary: string }>;
      omittedCount: number;
    }
  | { type: "empty_digest" };

interface ChannelConnector<TConfig = unknown> {
  readonly kind: ChannelKind;
  validateConfig(input: unknown): TConfig;
  sendTest(config: TConfig): Promise<SendResult>;
  send(config: TConfig, message: DeliveryMessage): Promise<SendResult>;
}

type SendResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; retryable: boolean; reason: string };
```

`createChannelRegistry(config)` exposes only installed connector kinds. Feature
7 registers `discord`; Signal/WhatsApp later register adapters without changes
to routes, scheduling, attempt storage, or worker policy.

User-facing copy must live in one obvious renderer/template module rather than
being spread across handlers. Initial neutral placeholder copy is acceptable
until manually replaced.

### 4.3 Discord connector

Implement Discord with direct `fetch`; add no SDK dependency.

- Accept only HTTPS Discord webhook URLs on an explicit Discord hostname
  allowlist and with the expected `/api/webhooks/{id}/{token}` path shape.
- Reject credentials/userinfo, fragments, unexpected ports, and redirects.
  This protects the server from SSRF through user-provided URLs.
- Use `wait=true` so a successful response can provide the Discord message ID.
- Render one embed per delivery. A digest uses at most 25 embed fields (Discord's
  field limit), one per selected email, grouped/ordered by the stored position.
- Keep within Discord payload limits. Truncate individual displayed summaries
  safely if required; never split a selected digest into multiple messages.
- Treat network errors, `429`, and `5xx` as retryable. Honor Discord's retry
  delay when available without blocking the worker; reschedule through the
  queue.
- Treat invalid authentication/webhook responses (`401`, `403`, `404`) as
  permanent and disable the matching channel. Other non-rate-limit `4xx`
  responses are permanent for that attempt and return a sanitized reason.
- Never log request bodies, webhook URLs/tokens, decrypted configuration, or
  Discord response bodies that may contain sensitive content.

### 4.4 Channel API (`backend/src/channels/routes.ts`)

All routes require the authenticated owner. Mutating routes also use the
existing same-origin CSRF guard and bounded JSON bodies.

- `GET /api/channels`
  - Returns `{ channel: Channel | null, supportedKinds: ["discord"] }`.
  - The shared `Channel` includes `id`, `kind`, `status`, `lastError`, and
    timestamps only. It never exposes `webhookUrl` or encrypted config.
- `POST /api/channels`
  - Input: `{ kind: "discord", config: { webhookUrl: string } }`.
  - Return `409 { code: "channel_exists" }` if the user already has a row.
  - Validate the URL, send the visible test message, and save only on success.
  - Seal the connector config with the vault before insertion.
  - Create/reset delivery settings baseline only after successful testing.
  - Map retryable test failures to `502 channel_test_failed`; map invalid config
    to `400 invalid_channel_config`. Never echo the URL.
- `POST /api/channels/:id/test`
  - Decrypts the owned channel config and sends another visible test.
  - A successful test sets status to `active` and clears `last_error`.
- `DELETE /api/channels/:id`
  - Deletes only the caller's channel and resets the delivery baseline.
  - The user must use this before connecting another provider/webhook.

There is no generic channel PATCH, enable toggle, label, category threshold, or
replace-channel flow in this feature. An errored channel must be disconnected
and connected again with a valid webhook (or successfully retested if the same
webhook was restored).

### 4.5 Delivery settings API

- `GET /api/settings/delivery` returns the real settings.
- `PATCH /api/settings/delivery` accepts any subset of:
  - `mode: "daily" | "quiet"`
  - `digestTime: "HH:mm"`
  - `digestDays: Weekday[]` (at least one, no duplicates)
- Responses explicitly identify the schedule as UTC.
- Changing mode resets the baseline and pending unsent attempts from the old
  mode. Existing emails are never retroactively alerted or digested after a
  mode change.
- Settings may be edited without a channel, but no delivery work is enqueued
  until an active channel exists.

### 4.6 Immediate-delivery discovery

Add a bounded scheduler scan on the existing scheduler cadence. It finds emails
that:

- belong to a user whose mode is `quiet` and whose channel is `active`;
- have `category = 'requires_action'` and non-null `summary`/`classified_at`;
- were received on/after `delivery_baseline_at`;
- were classified on/after `delivery_baseline_at`; and
- do not already have an immediate `delivery_attempts` row for that channel and
  email.

For each result, transactionally insert the unique attempt and enqueue one
`deliver_channel` job. A bounded scan plus unique constraint makes repeated or
concurrent scheduler ticks safe. This independent scan avoids a crash gap and
does not couple Feature 6's classification handler to Discord delivery.

Daily-mode users never qualify for this scan. Switching to quiet mode does not
alert for earlier emails because the baseline resets.

### 4.7 Digest scheduling and snapshot

On each scheduler tick, calculate the most recent enabled UTC schedule instant
at or before `now()` for every active daily-mode user. If no run exists for that
instant:

1. Set `window_start` to `last_digest_cutoff_at`, or to
   `delivery_baseline_at` for the first digest.
2. Set `window_end` to the selected schedule instant.
3. Select emails received on/after the baseline and classified in
   `(window_start, window_end]`.
4. Rank with an explicit SQL `CASE`:
   `requires_action`, `important`, `noise`; then `received_at DESC, id DESC`.
5. Count all eligible rows, snapshot the first 25 into `digest_items`, and set
   `omitted_count = total - selected`.
6. Insert the digest attempt and enqueue its delivery job in the same database
   transaction.

If several scheduled instants were missed while Pigeon was offline, create only
one catch-up run for the most recent due instant, not one message per missed
schedule. Its window still starts at the last successful cutoff, so no period
is silently skipped.

The digest handler sends one message, including an empty reassurance when the
snapshot has no items. On successful send, mark the attempt `sent` and advance
`last_digest_cutoff_at` to its `window_end`. The cutoff closes the entire
window, including omitted rows, so overflow never rolls forward.

A retry uses the same attempt and snapshot. A permanently failed run does not
advance the cutoff. Once an invalid webhook disables the channel, schedulers
stop creating work until the user reconnects; reconnection establishes a new
baseline rather than sending the stale backlog.

### 4.8 Delivery worker

Add `deliver_channel` to `JobType` and the exhaustive dispatch in
`worker-loop.ts`.

The handler:

1. Loads the pending attempt and its currently active owned channel.
2. No-ops if the attempt is already `sent` (idempotent job replay).
3. Opens connector config through the vault only immediately before use.
4. Builds `DeliveryMessage` from the stored attempt/snapshot.
5. Calls the connector selected by `channel.kind`.
6. On success, records provider ID/sent time and completes the queue job.
7. On retryable failure, throws/returns into the existing queue retry path.
8. On permanent invalid-webhook failure, transactionally marks the attempt
   failed and channel `error`, stores only a sanitized reason, and completes the
   queue job without retry.
9. On another permanent payload failure, marks the attempt failed and
   dead-letters/completes consistently without an infinite scheduler loop.

Reuse generic queue attempts/backoff. Discord's `Retry-After` may move the job's
`run_at` later, but no worker sleeps while waiting.

### 4.9 Shared contract, dashboard, and frontend

Replace the mock-era multi-channel contract:

- `ChannelKind` initially exposes only `"discord"` to the shipped UI while the
  backend registry remains extensible.
- `Channel` contains no webhook URL, label, enabled flag, or `minCategory`.
- `DashboardData.channels: Channel[]` becomes `channel: Channel | null`.
- Replace `Digest.enabled` with explicit `DeliveryMode = "daily" | "quiet"`.
- Delivery settings expose `digestTime`, `digestDays`, `timezone: "UTC"`, and
  a formatted/null last successful digest timestamp.

Wire `GET /api/dashboard` to real channel/settings data.

Update the frontend:

- Show only Discord in the add-channel flow for Feature 7.
- Remove Signal/WhatsApp tiles and the category-threshold control.
- Hide/disable “Add channel” while one exists; provide Disconnect and Send test.
- Never display even a redacted webhook value.
- Show active/error status and a reconnect-required message for invalid
  webhooks.
- Connection submission remains busy while the visible test is sent; success
  means both test and encrypted save succeeded.
- Daily mode copy must no longer claim action emails are sent immediately.
- Quiet mode explains that only new `requires_action` email is sent and there
  is no digest.
- The schedule dialog displays `UTC`, defaults to 08:00 and all seven weekdays,
  and continues to require at least one day.
- Display the real last successful digest state.

---

## 5. Pitfalls

- **Duplicate send after an ambiguous crash:** database idempotency cannot make
  a Discord webhook transactional. Persist the logical attempt before sending,
  request Discord's message ID, minimize code between response and commit, and
  document that ambiguous network/process failures can rarely duplicate.
- **Missed send from enqueue gaps:** discover work from durable email/settings
  state and create attempt + queue job transactionally. Do not rely solely on a
  call from the classification handler.
- **Historical notification flood:** require both received/classified timestamps
  to be on/after the baseline and reset that baseline on mode/channel changes.
- **Repeated digest content:** snapshot a closed window and advance its cutoff
  only after success. Omitted rows close with that successful window.
- **Changed content across retries:** store digest summaries/categories in
  `digest_items` rather than rebuilding from mutable email rows.
- **SSRF/secret leakage:** strict Discord URL validation, no redirects, vault
  encryption, redacted errors, and no webhook/config logging.
- **Discord limits:** one embed, at most 25 fields, payload-size accounting, and
  safe truncation. Never respond by sending an unbounded series of messages.
- **Scheduler downtime:** enqueue one catch-up digest for the latest due instant,
  not one digest per missed day.
- **Mode-change races:** reset baseline and cancel/mark failed pending attempts
  from the previous mode in one transaction with the settings update. The
  handler rechecks attempt/channel state before sending.
- **Connector abstraction leakage:** routes and schedulers handle opaque config
  and provider-neutral messages only; Discord payload/HTTP rules stay in the
  adapter.

---

## 6. Related problems

- Feature 8 can use the same connector, attempt storage, scheduler, and message
  renderer for quiet-mode heartbeat messages by adding another attempt/message
  kind.
- Signal and WhatsApp can register new connectors and config validators without
  changing delivery policy.
- Future two-way channels can add inbound identities/events alongside this
  outbound boundary without changing email classification.
- Future quota enforcement can reject delivery attempt creation at the queue
  edge if plans eventually limit notifications.
- A future delivery-history/admin surface can read `delivery_attempts` without
  exposing connector secrets.

---

## 7. Alternatives considered

- **Discord bot/OAuth:** better long-term interaction support, but requires bot
  hosting, permissions, and a larger onboarding surface. A webhook is enough
  for one-way MVP delivery.
- **Multiple channels per user:** more flexible, but creates duplicate/privacy
  ambiguity. The database enforces one configured destination.
- **Per-channel category threshold:** rejected because modes already define
  behavior and Pigeon should not become a rule-building tool.
- **Immediate action alerts in daily mode:** rejected to keep the two modes
  distinct and avoid duplicate notifications.
- **Including sender/subject/body:** rejected in favor of a calm, minimal message
  containing only category and summary.
- **Unlimited or multi-message digests:** rejected to avoid notification spam.
  One digest contains the top 25; overflow stays on the dashboard.
- **Rolling overflow into the next digest:** rejected because stale backlog can
  crowd out current mail indefinitely.
- **Local/browser timezone scheduling:** rejected; all schedules are UTC.
- **Saving before testing:** rejected because it permits a broken initial
  channel. A visible test must succeed first.
- **Automatically replacing/falling back to another channel:** rejected because
  destination changes must be explicit.
- **Direct enqueue from classification only:** rejected because a crash between
  classification commit and enqueue can permanently miss a notification.

---

## 8. User Stories

- **As a user**, I want to connect one Discord webhook and see a test message so
  I know Pigeon can reach me.
- **As a user**, I want a daily ranked digest so I can review the most relevant
  email without opening each inbox.
- **As a user**, I want quiet mode to interrupt me only when an email requires my
  action.
- **As a user**, I want old emails excluded when I enable or change delivery so I
  am not flooded by stale notifications.
- **As a user**, I want an empty daily digest to confirm that Pigeon is still
  working.
- **As a user**, I want a broken/revoked Discord webhook shown clearly so I can
  reconnect it.
- **As a privacy-conscious user**, I want webhook credentials encrypted and
  absent from API responses/logs.
- **As a developer**, I want provider-neutral scheduling and delivery so future
  Signal/WhatsApp adapters are additive.

---

## 9. Functional Requirements

1. **FR-1:** A user can have zero or one channel; concurrent attempts to create
   two are rejected by a database uniqueness constraint.
2. **FR-2:** Discord is the only supported connector kind exposed in Feature 7.
3. **FR-3:** Channel creation validates the webhook, sends a visible test, then
   encrypts and saves it only if the test succeeds.
4. **FR-4:** APIs and logs never expose webhook/config secrets.
5. **FR-5:** Users must disconnect an existing channel before adding another.
6. **FR-6:** Users can resend a test and disconnect their owned channel.
7. **FR-7:** Settings support exactly `daily` and `quiet` modes.
8. **FR-8:** Daily defaults to 08:00 UTC on all weekdays and supports a custom
   UTC time and non-empty weekday subset.
9. **FR-9:** Daily mode sends no immediate messages.
10. **FR-10:** Quiet mode sends no digest and sends only new
    `requires_action` classifications immediately.
11. **FR-11:** Mode/channel changes reset the baseline and never retroactively
    notify for existing emails.
12. **FR-12:** Each delivered email shows only category and summary.
13. **FR-13:** Digests rank category first and newest first within a category.
14. **FR-14:** A digest sends at most 25 selected emails in one Discord message.
15. **FR-15:** Overflow is counted/reported but never rolled into a later digest.
16. **FR-16:** A due digest with no items sends an empty reassurance message.
17. **FR-17:** Failed jobs retry durably; repeated scheduler ticks do not create
    duplicate logical attempts.
18. **FR-18:** A permanently invalid webhook disables the channel and surfaces a
    sanitized reconnection-required state.
19. **FR-19:** Scheduler recovery creates at most one catch-up digest covering
    the unsent period.
20. **FR-20:** The dashboard and sidebar use real channel/settings/last-sent data.
21. **FR-21:** No category threshold, multi-channel toggle, timezone selector,
    or Signal/WhatsApp setup is shown.
22. **FR-22:** Message copy is centralized and can be manually replaced later.

---

## 10. Technical Requirements

- TypeScript, ESM, Node 22, strict mode, hand-written PostgreSQL, migration
  `0009_discord_delivery.sql`.
- New self-contained `backend/src/channels/` module for connector registry,
  Discord adapter, renderer, service, routes, and tests.
- Reuse `backend/src/vault/`; no new encryption implementation.
- Use direct `fetch` for Discord; no Discord SDK or new stateful service.
- Reuse the existing PostgreSQL queue and worker. Add only the
  `deliver_channel` job type and required scheduling/handler integration.
- Integration tests use real embedded PostgreSQL. Discord is faked through the
  connector interface or injected `fetch`, never contacted by tests.
- Route mutations use authentication, ownership checks, body limits, Zod input
  validation, structured error codes, and same-origin CSRF protection.
- Delivery discovery and digest creation are bounded and safe under concurrent
  scheduler/worker processes.
- External messages use best-effort idempotency with documented webhook
  ambiguity; all database-controlled replays are idempotent.

### Required test coverage

- Migration constraints, cascades, defaults, encrypted config storage, singleton
  channel, attempt uniqueness, and valid digest item positions.
- Discord URL allowlist/path/redirect rejection and no secret-bearing errors.
- Discord success, rate limit, network/5xx retry, permanent 4xx, payload limits,
  truncation, and provider message ID parsing using fake `fetch`.
- Test-before-save, failed-test no-save, concurrent singleton enforcement,
  vault round trip, ownership isolation, test-again, and disconnect routes.
- Settings defaults/validation, UTC behavior, baseline reset on mode change, and
  no reset for schedule-only edits.
- Quiet discovery filters by mode/category/baseline and remains idempotent under
  repeated/concurrent ticks.
- Daily ranking, 25 cap, omitted count, empty digest, weekday/time due checks,
  one catch-up run, fixed retry snapshot, and cutoff advancement only on success.
- Worker success/retry/permanent failure/already-sent no-op and invalid-webhook
  channel disabling.
- No cross-user data or delivery leakage.
- Dashboard returns real redacted channel/settings values.
- Frontend build verifies one-channel UI, Discord-only setup, removed threshold,
  corrected mode copy, UTC schedule, error state, and no webhook display.

---

## 11. Acceptance criteria

1. **AC-1:** With no channel, the user can submit a valid Discord webhook; a
   visible test arrives, the API saves one encrypted channel, and neither the
   response nor database contains the plaintext URL.
2. **AC-2:** An invalid/unreachable webhook fails connection without creating a
   channel. A second channel cannot be configured until the first is deleted.
3. **AC-3:** In quiet mode, classifying a new post-baseline email as
   `requires_action` produces exactly one logical delivery attempt and a
   Discord message containing only its category and summary.
4. **AC-4:** Quiet mode does not send `important`/`noise`, and daily mode sends no
   immediate alerts of any category.
5. **AC-5:** At 08:00 UTC by default (or the saved enabled UTC schedule), daily
   mode sends one digest covering classifications since the prior successful
   cutoff.
6. **AC-6:** Digest order is `requires_action` → `important` → `noise`, then
   newest first; at most 25 appear, and overflow is reported and does not appear
   in the next digest.
7. **AC-7:** A scheduled period with no eligible mail sends one empty
   reassurance message.
8. **AC-8:** Repeated scheduler ticks, worker retries, and an already-sent job do
   not create a second database logical send; retries reuse the same digest
   snapshot.
9. **AC-9:** Changing modes or reconnecting establishes a new baseline and does
   not notify for earlier emails.
10. **AC-10:** `401`/`403`/`404` from Discord marks the channel errored, stops new
    delivery scheduling, and shows a reconnect-required state without secrets.
11. **AC-11:** After scheduler downtime, at most one catch-up digest is produced,
    covering the period since the last successful cutoff.
12. **AC-12:** The frontend exposes Discord only, one channel only, no category
    threshold, UTC schedule controls, and accurate mode descriptions.
13. **AC-13:** A new connector can implement `ChannelConnector` without changing
    delivery scheduling, attempt persistence, or worker policy.
14. **AC-14:** Relevant tests, `pnpm check:all`, and `pnpm build` pass.

---

## 12. Open Questions

- **OQ1 resolved:** Ship the basic Discord copy listed in Known Facts. Keep it
  centralized so the owner can manually replace it later without changing
  delivery logic.
- **OQ2:** Product decision for the rare ambiguous webhook outcome (Discord may
  have accepted a message but the worker lost the response/crashed before the
  DB commit). Default implementation favors retryable at-least-once delivery,
  accepting a rare duplicate rather than silently losing an action alert.

---

## 13. Non-Goals (Out of Scope)

- Signal, WhatsApp, or any connector other than Discord.
- More than one configured or active channel per user.
- Discord bot installation, OAuth, slash commands, inbound events, replies, or
  any two-way interaction.
- Per-channel labels, thresholds, schedules, rules, or fallback routing.
- Immediate `requires_action` alerts while daily mode is active.
- Sender, subject, mailbox, body, attachment, or provider-deep-link content in
  Discord messages.
- More than 25 digest entries or carrying overflow into later digests.
- Browser/local timezone detection, timezone selection, or daylight-saving
  conversion; scheduling is UTC.
- Feature 8's periodic quiet-mode reassurance/heartbeat.
- Editing a configured webhook in place or atomic channel replacement.
- Delivery history UI, manual resend of an email/digest, or operator replay UI.
- Guaranteeing mathematically exact-once delivery across PostgreSQL and an
  external Discord webhook, which provides no idempotency-key transaction.
