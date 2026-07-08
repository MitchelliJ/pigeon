/*
 * Sign-up + verify-email + resend + login/session + password-reset service
 * (Authentication & User Accounts PRD FR-1..FR-23).
 *
 * What: validates a sign-up request, checks the invite code presented, and —
 * for a brand-new email address — creates an unverified `users` row plus a
 * single-use `verify_email` auth token, then emails the verify link. Also
 * verifies that token: marks the user verified, consumes the token and its
 * invite, and starts the user's first session (auto-login). Also lets an
 * unverified user request a fresh verify link (resend), subject to a
 * cooldown, without ever revealing account state to the caller. Beyond
 * sign-up, also owns logging an existing verified user in (starting a new
 * session the same way verify does) and revoking a session on logout. Also
 * owns the password-reset round trip: requesting a reset link (subject to
 * its own cooldown, same no-enumeration rule as resend) and confirming it
 * (setting a new password hash and revoking every session the account has).
 * Session *admission* (looking up a live session by cookie and sliding its
 * expiry forward) is `requireAuth`'s job in `./middleware`, not this file's —
 * this file only ever mints (`createSession`) or revokes (`revokeSession`/
 * `revokeAllSessions`) rows.
 * Why: the invite is only *checked* at sign-up, not consumed — consumption
 * happens at verify time (FR-10) so an abandoned sign-up doesn't burn the
 * invite.
 *
 * Re-signup with the same UNVERIFIED email rotates the password and
 * verify-email token (FR-4); re-signup with an already-VERIFIED email 409s as
 * `email_taken` (FR-5) without any DB writes or email.
 */
import { z } from "zod";
import { hashPassword, isAcceptablePassword, verifyPassword } from "./password";
import { generateToken, hashToken } from "./tokens";
import { resetEmail, verificationEmail } from "../mail/templates";
import type { Db, TxClient } from "../db/index";
import type { MailSender } from "../mail/index";
import type { SessionUser, SignupInput } from "@pigeon/shared";

/** How long a freshly-minted verify-email token stays valid. */
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Sign-up request shape. `password` strength is delegated to
 * `isAcceptablePassword` (length + denylist, §3.1.2); `name` must survive a
 * trim non-empty (FR-1); `inviteCode` is just "present" here — its validity
 * against the `invites` table is checked by the service, not the schema.
 */
export const signupSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().refine(isAcceptablePassword, {
    message: "password does not meet the strength requirements",
  }),
  name: z.string().trim().min(1).max(200),
  inviteCode: z.string().trim().min(1),
});

/** The slice of `Config` the signup service needs — just the mail link base. */
export interface SignupConfig {
  APP_BASE_URL: string;
}

export type SignupResult =
  | { kind: "verify_email_sent" }
  | { kind: "bad_invite" }
  | { kind: "email_taken" };

/**
 * The two token kinds this file mints, matching the `auth_tokens.kind` CHECK
 * constraint (`db/migrations/0003_users_sessions.sql`).
 */
type AuthTokenKind = "verify_email" | "reset_password";

/** Postgres SQLSTATE for a unique-constraint violation (e.g. `users.email`). */
const UNIQUE_VIOLATION_CODE = "23505";

/** Narrow an unknown thrown value to "was this a 23505 from postgres.js?" */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION_CODE
  );
}

/**
 * Internal sentinel used to roll a `withTx` block back to a *specific*
 * caller-visible outcome rather than a 500. Thrown inside verify/reset when a
 * compare-and-swap loses (token already consumed, or the invite was already
 * claimed by another account) so the whole transaction unwinds, then caught at
 * the call site and mapped to `invalid_or_expired_token`.
 */
class TokenRaceLost extends Error {
  constructor() {
    super("token or invite already consumed");
    this.name = "TokenRaceLost";
  }
}

/**
 * Mint a fresh `kind` token for `userId` via `tx`, valid for `ttlMs`. Returns
 * the plaintext token (only its hash is persisted). Used directly wherever
 * there's nothing to void yet (the brand-new-user sign-up path); every other
 * mint goes through `voidOutstandingAndMint` below instead, which voids any
 * outstanding token of the same kind first.
 */
async function mintToken(
  tx: TxClient,
  userId: unknown,
  kind: AuthTokenKind,
  ttlMs: number,
): Promise<string> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttlMs);
  await tx`
    INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at)
    VALUES (${userId}, ${kind}, ${tokenHash}, ${expiresAt})
  `;
  return token;
}

/**
 * Void any outstanding `kind` tokens for `userId`, then mint a fresh one via
 * `tx` (valid for `ttlMs`). Shared void-then-mint DB-write shape used by the
 * "re-signup while still unverified" path in `signup`, by `resendVerify`
 * (both rotating `verify_email`), and by `requestReset` (rotating
 * `reset_password`) — all three need the invariant "at most one live token of
 * a given kind per user."
 *
 * Only this DB-write shape is shared: `resendVerify` and `requestReset` each
 * decide WHETHER to call it from a different cooldown basis (voided-history
 * vs. outstanding-token-age — see their own doc comments for why), and that
 * decision logic is deliberately not unified here.
 */
async function voidOutstandingAndMint(
  tx: TxClient,
  userId: unknown,
  kind: AuthTokenKind,
  ttlMs: number,
): Promise<string> {
  await tx`
    UPDATE auth_tokens SET consumed_at = now()
    WHERE user_id = ${userId} AND kind = ${kind} AND consumed_at IS NULL
  `;
  return mintToken(tx, userId, kind, ttlMs);
}

/** Email the verify link. Errors are swallowed — see call sites for why. */
async function sendVerifyEmail(
  mail: MailSender,
  config: SignupConfig,
  email: string,
  verifyToken: string,
): Promise<void> {
  // Why swallow mail errors: a transport failure must not surface as a
  // request-path crash — the account already exists, verify-resend covers it.
  try {
    const template = verificationEmail({
      to: email,
      baseUrl: config.APP_BASE_URL,
      token: verifyToken,
    });
    await mail.send({
      to: email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  } catch (err) {
    console.error("signup: failed to send verification email", err);
  }
}

/**
 * Sign a new user up. Checks (but does not consume) the invite code, then
 * branches on whether a `users` row already exists for the email:
 *  - no row: insert the user and mint a verify-email token in one
 *    transaction, then email the link.
 *  - row exists but unverified (FR-4): rotate the password + invite hash,
 *    void old outstanding verify tokens, mint a fresh one, email it.
 *  - row exists and verified (FR-5): 409 `email_taken`, no writes, no email.
 */
export async function signup(
  db: Db,
  mail: MailSender,
  config: SignupConfig,
  input: SignupInput,
): Promise<SignupResult> {
  const inviteCodeHash = hashToken(input.inviteCode);
  const invites = await db.query`
    SELECT code_hash FROM invites
    WHERE code_hash = ${inviteCodeHash}
      AND consumed_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
  `;
  const invite = invites[0];
  if (!invite) {
    return { kind: "bad_invite" };
  }

  const existing =
    await db.query`SELECT id, email_verified_at FROM users WHERE email = ${input.email}`;
  const existingUser = existing[0];

  if (existingUser?.email_verified_at) {
    return { kind: "email_taken" };
  }

  const passwordHash = hashPassword(input.password);

  let verifyToken: string;
  if (existingUser) {
    verifyToken = await db.withTx(async (tx) => {
      await tx`
        UPDATE users
        SET password_hash = ${passwordHash}, name = ${input.name},
            pending_invite_code_hash = ${invite.code_hash}
        WHERE id = ${existingUser.id}
      `;
      return voidOutstandingAndMint(
        tx,
        existingUser.id,
        "verify_email",
        VERIFY_TOKEN_TTL_MS,
      );
    });
  } else {
    try {
      verifyToken = await db.withTx(async (tx) => {
        const inserted = await tx`
          INSERT INTO users (email, password_hash, name, pending_invite_code_hash)
          VALUES (${input.email}, ${passwordHash}, ${input.name}, ${invite.code_hash})
          RETURNING id
        `;
        const userId = inserted[0]?.id;
        return mintToken(tx, userId, "verify_email", VERIFY_TOKEN_TTL_MS);
      });
    } catch (err) {
      // Two signups racing the same brand-new email both pass the `existing`
      // check above, then race this INSERT; the loser hits the `users.email`
      // unique constraint. Map it to the same `email_taken` result an
      // already-verified email gets, instead of leaking a raw 500 (FR-5).
      if (isUniqueViolation(err)) {
        return { kind: "email_taken" };
      }
      throw err;
    }
  }

  await sendVerifyEmail(mail, config, input.email, verifyToken);
  return { kind: "verify_email_sent" };
}

/** A session's sliding idle window — 30 days of inactivity ends it (FR-16). */
const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A session's absolute cap regardless of activity — 90 days (FR-16). */
const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Mint a brand-new session row for `userId`, using the given query-capable
 * client — in practice always the `tx` of a `withTx` block, so the session
 * commits atomically with whatever else the caller just did (e.g. verify's
 * user/token/invite updates). Returns the plaintext token; only its sha256
 * hash is persisted (FR-16).
 *
 * `expires_at` is computed as `min(created_at + 90d, now() + 30d)` — for a
 * brand-new session the sliding 30-day window is always the smaller of the
 * two, but computing it via the same min() a later slice's renewal logic
 * uses means no special-casing is needed for freshly-created sessions.
 */
export async function createSession(
  tx: TxClient,
  userId: string,
): Promise<string> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const createdAt = new Date();
  const absoluteCap = new Date(createdAt.getTime() + SESSION_ABSOLUTE_TTL_MS);
  const slidingExpiry = new Date(createdAt.getTime() + SESSION_IDLE_TTL_MS);
  const expiresAt = slidingExpiry < absoluteCap ? slidingExpiry : absoluteCap;

  await tx`
    INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at)
    VALUES (${userId}, ${tokenHash}, ${createdAt}, ${createdAt}, ${expiresAt})
  `;
  return token;
}

export type VerifyResult =
  | { kind: "verified"; user: SessionUser; sessionToken: string }
  | { kind: "invalid_or_expired_token" };

/**
 * Verify an email address from a sign-up token (FR-9..FR-12). Looks up an
 * unconsumed, unexpired `verify_email` auth token; if found, marks the user
 * verified, consumes the token and its associated invite, and starts the
 * user's first session — all in one transaction so a partial verify never
 * happens. `mail` is accepted (unused today) to keep this function's
 * signature aligned with `signup`'s — no email is sent on verify per FR-11.
 */
export async function verify(
  db: Db,
  _mail: MailSender,
  token: string,
): Promise<VerifyResult> {
  const tokenHash = hashToken(token);
  const tokens = await db.query`
    SELECT id, user_id FROM auth_tokens
    WHERE token_hash = ${tokenHash}
      AND kind = 'verify_email'
      AND consumed_at IS NULL
      AND expires_at > now()
  `;
  const tokenRow = tokens[0];
  if (!tokenRow) {
    return { kind: "invalid_or_expired_token" };
  }

  let txResult: { user: Record<string, unknown>; sessionToken: string };
  try {
    txResult = await db.withTx(async (tx) => {
      // Consume the token as a compare-and-swap: only the caller that flips
      // `consumed_at` from NULL proceeds. A second concurrent request with the
      // same token (e.g. an email-security scanner prefetching the link, then
      // the real user clicking it) loses here and gets no session — the token
      // is genuinely single-use, not "single-use unless raced".
      const consumed = await tx`
        UPDATE auth_tokens SET consumed_at = now()
        WHERE id = ${tokenRow.id} AND consumed_at IS NULL
        RETURNING id
      `;
      if (consumed.length === 0) {
        throw new TokenRaceLost();
      }

      const users = await tx`
        UPDATE users SET email_verified_at = now()
        WHERE id = ${tokenRow.user_id}
        RETURNING id, email, name, tier, pending_invite_code_hash
      `;
      const updatedUser = users[0];
      if (!updatedUser) {
        throw new Error(`verify: no user for id ${String(tokenRow.user_id)}`);
      }

      // Consume the invite presented at sign-up (FR-10) — atomically, and only
      // if it hasn't already been claimed. The invite is checked (not consumed)
      // at signup, so N accounts can be signed up against one invite before any
      // verifies; whichever account verifies first claims it here, and every
      // later verify finds it already consumed and is rejected. Without this
      // compare-and-swap, one invite could mint unlimited verified accounts.
      if (updatedUser.pending_invite_code_hash) {
        const claimedInvite = await tx`
          UPDATE invites SET consumed_at = now()
          WHERE code_hash = ${updatedUser.pending_invite_code_hash}
            AND consumed_at IS NULL
          RETURNING id
        `;
        if (claimedInvite.length === 0) {
          throw new TokenRaceLost();
        }
      }

      const newSessionToken = await createSession(tx, String(updatedUser.id));
      return { user: updatedUser, sessionToken: newSessionToken };
    });
  } catch (err) {
    if (err instanceof TokenRaceLost) {
      return { kind: "invalid_or_expired_token" };
    }
    throw err;
  }

  const { user, sessionToken } = txResult;

  const sessionUser: SessionUser = {
    id: String(user.id),
    email: String(user.email),
    name: String(user.name),
    tier: String(user.tier),
  };

  return { kind: "verified", user: sessionUser, sessionToken };
}

/** Cooldown between resend requests, to stop an inbox from being spammed. */
const RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Values come back from `postgres.js` as `Date` instances already; the
 * `Date` fallback here just protects against a stringified column being
 * handed in.
 */
function toEpochMs(value: unknown): number {
  return value instanceof Date
    ? value.getTime()
    : new Date(String(value)).getTime();
}

/**
 * There is exactly one outcome shape here on purpose (FR-8/FR-9): resend
 * never tells the caller whether the email existed, was already verified, or
 * hit the cooldown — every case 202s identically.
 */
export type ResendVerifyResult = { kind: "handled" };

/**
 * Resend the verify-email link for `email` (FR-8). No-ops — but still
 * reports success — when: the address isn't registered, the account is
 * already verified, or a prior resend voided a token less than
 * `RESEND_COOLDOWN_MS` ago. Otherwise voids outstanding verify-email tokens,
 * mints a fresh one, and emails it, via the same `voidOutstandingAndMint`
 * helper as the re-signup-while-unverified path in `signup`.
 *
 * The cooldown is measured from the most recently-CONSUMED `verify_email`
 * token, not from the age of the currently-outstanding one: the outstanding
 * token could be the one signup just minted (arbitrarily fresh, but not a
 * prior resend), so its age says nothing about how long ago the account was
 * last resent-to. Only a resend voids a token by setting `consumed_at` — so
 * "no consumed row yet" means this is the first-ever resend for the account
 * and it must proceed unconditionally.
 */
export async function resendVerify(
  db: Db,
  mail: MailSender,
  config: SignupConfig,
  email: string,
): Promise<ResendVerifyResult> {
  const users =
    await db.query`SELECT id, email_verified_at FROM users WHERE email = ${email}`;
  const user = users[0];
  if (!user || user.email_verified_at) {
    return { kind: "handled" };
  }

  const lastVoided = await db.query`
    SELECT consumed_at FROM auth_tokens
    WHERE user_id = ${user.id} AND kind = 'verify_email' AND consumed_at IS NOT NULL
    ORDER BY consumed_at DESC
    LIMIT 1
  `;
  const mostRecentlyVoided = lastVoided[0];
  if (mostRecentlyVoided) {
    const voidedAtMs = toEpochMs(mostRecentlyVoided.consumed_at);
    if (Date.now() - voidedAtMs < RESEND_COOLDOWN_MS) {
      return { kind: "handled" };
    }
  }

  const verifyToken = await db.withTx((tx) =>
    voidOutstandingAndMint(tx, user.id, "verify_email", VERIFY_TOKEN_TTL_MS),
  );

  await sendVerifyEmail(mail, config, email, verifyToken);
  return { kind: "handled" };
}

/** How long a freshly-minted password-reset token stays valid (FR-21). */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Cooldown between reset-request requests, to stop an inbox from being spammed. */
const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;

/**
 * There is exactly one outcome shape here on purpose (FR-22): reset-request
 * never tells the caller whether the email existed or hit the cooldown —
 * every case 202s identically.
 */
export type RequestResetResult = { kind: "handled" };

/** Email the reset-password link. Errors are swallowed, same reasoning as `sendVerifyEmail`. */
async function sendResetEmail(
  mail: MailSender,
  config: SignupConfig,
  email: string,
  resetToken: string,
): Promise<void> {
  try {
    const template = resetEmail({
      to: email,
      baseUrl: config.APP_BASE_URL,
      token: resetToken,
    });
    await mail.send({
      to: email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  } catch (err) {
    console.error("requestReset: failed to send reset-password email", err);
  }
}

/**
 * Request a password-reset link for `email` (FR-21/FR-22; AC-6). No-ops —
 * but still reports success — when: the address isn't registered, or the
 * currently-outstanding reset_password token was minted less than
 * `RESET_REQUEST_COOLDOWN_MS` ago. Otherwise voids the outstanding
 * reset_password token (if any), mints a fresh one, and emails it, via the
 * same `voidOutstandingAndMint` helper `resendVerify` and `signup` use for
 * verify_email tokens.
 *
 * Unlike `resendVerify`, the cooldown here is measured from the
 * currently-OUTSTANDING token's own mint time (derived as
 * `expires_at - RESET_TOKEN_TTL_MS`), not from the most recently-voided
 * token's `consumed_at`. `resendVerify` can use voided-history because
 * signup always pre-seeds an outstanding verify_email token before the
 * first-ever resend call, so that first resend has something to void —
 * priming voided-history for the second resend to detect. Reset-request has
 * no equivalent priming event: the very first reset-request IS the first
 * mint, with nothing to void yet, so "no voided row" can't distinguish
 * "never requested" from "just requested once." Checking the outstanding
 * token's own derived age is the only way the first mint can start the
 * cooldown clock immediately.
 */
export async function requestReset(
  db: Db,
  mail: MailSender,
  config: SignupConfig,
  email: string,
): Promise<RequestResetResult> {
  const users = await db.query`SELECT id FROM users WHERE email = ${email}`;
  const user = users[0];
  if (!user) {
    return { kind: "handled" };
  }

  const outstanding = await db.query`
    SELECT expires_at FROM auth_tokens
    WHERE user_id = ${user.id} AND kind = 'reset_password' AND consumed_at IS NULL
    ORDER BY expires_at DESC
    LIMIT 1
  `;
  const outstandingToken = outstanding[0];
  if (outstandingToken) {
    const mintedAtMs =
      toEpochMs(outstandingToken.expires_at) - RESET_TOKEN_TTL_MS;
    if (Date.now() - mintedAtMs < RESET_REQUEST_COOLDOWN_MS) {
      return { kind: "handled" };
    }
  }

  const resetToken = await db.withTx((tx) =>
    voidOutstandingAndMint(tx, user.id, "reset_password", RESET_TOKEN_TTL_MS),
  );

  await sendResetEmail(mail, config, email, resetToken);
  return { kind: "handled" };
}

/**
 * A fixed, valid-shaped scrypt hash of a placeholder password, computed once
 * at module load. `login` runs `verifyPassword` against this decoy whenever
 * no matching user row exists, discarding the result — this keeps the
 * "no such user" path's scrypt-verify timing profile indistinguishable from
 * the "wrong password" path (PRD §3.1.2 FR-C; AC-2/AC-3).
 */
const DECOY_PASSWORD_HASH = hashPassword("decoy-password-for-timing-parity");

export type LoginResult =
  | { kind: "logged_in"; user: SessionUser; sessionToken: string }
  | { kind: "bad_credentials" };

/**
 * Log a user in with email + password (FR-13..FR-15; AC-2, AC-3). Every
 * failure case — unknown email, unverified account, or a verified account
 * with the wrong password — returns the exact same `bad_credentials` result,
 * so a caller can never tell which one happened. A real `verifyPassword`
 * call always runs before returning failure: against the user's actual
 * stored hash when a row exists (verified or not), or against the fixed
 * `DECOY_PASSWORD_HASH` when no row exists at all, so the "user doesn't
 * exist" path can't be timed apart from "wrong password" (FR-C).
 */
export async function login(
  db: Db,
  email: string,
  password: string,
): Promise<LoginResult> {
  const users = await db.query`
    SELECT id, email, name, tier, password_hash, email_verified_at
    FROM users WHERE email = ${email}
  `;
  const user = users[0];

  const passwordMatches = verifyPassword(
    password,
    user ? String(user.password_hash) : DECOY_PASSWORD_HASH,
  );

  if (!user || !user.email_verified_at || !passwordMatches) {
    return { kind: "bad_credentials" };
  }

  const sessionToken = await db.withTx((tx) =>
    createSession(tx, String(user.id)),
  );

  const sessionUser: SessionUser = {
    id: String(user.id),
    email: String(user.email),
    name: String(user.name),
    tier: String(user.tier),
  };

  return { kind: "logged_in", user: sessionUser, sessionToken };
}

/**
 * Revoke the session matching `tokenHash` (FR-19: logout). Setting
 * `revoked_at` rather than deleting the row keeps an audit trail and matches
 * `requireAuth`'s `revoked_at IS NULL` check — an already-revoked or
 * nonexistent hash is a harmless no-op.
 */
export async function revokeSession(db: Db, tokenHash: string): Promise<void> {
  await db.query`
    UPDATE sessions SET revoked_at = now()
    WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
  `;
}

/**
 * Revoke every live session belonging to `userId`, via `tx`. Broader than
 * `revokeSession` (which only ever targets the one session a logout call
 * came in on) — used by `resetPassword`, where a successful reset must end
 * every session the account has, not just the one (if any) making the
 * request (FR-23; AC-6).
 */
async function revokeAllSessions(tx: TxClient, userId: unknown): Promise<void> {
  await tx`
    UPDATE sessions SET revoked_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
}

/**
 * Reset-confirm request shape. `newPassword` strength is delegated to
 * `isAcceptablePassword`, same rule as sign-up (FR-23).
 */
export const resetSchema = z.object({
  token: z.string().trim().min(1),
  newPassword: z.string().refine(isAcceptablePassword, {
    message: "password does not meet the strength requirements",
  }),
});

export type ResetPasswordResult =
  { kind: "reset" } | { kind: "invalid_or_expired_token" };

/**
 * Confirm a password reset (FR-23; AC-6). Looks up an unconsumed, unexpired
 * `reset_password` auth token; if none matches (never existed, already
 * consumed, or expired), returns `invalid_or_expired_token` — the same
 * result for all three cases, so a caller can't distinguish "used twice"
 * from "just wrong". Otherwise, in one transaction: sets the token's user's
 * new password hash, consumes the token, and revokes ALL of that user's
 * sessions. No session is started here — unlike `verify`, reset does not
 * log the user in.
 */
export async function resetPassword(
  db: Db,
  token: string,
  newPassword: string,
): Promise<ResetPasswordResult> {
  const tokenHash = hashToken(token);
  const tokens = await db.query`
    SELECT id, user_id FROM auth_tokens
    WHERE token_hash = ${tokenHash}
      AND kind = 'reset_password'
      AND consumed_at IS NULL
      AND expires_at > now()
  `;
  const tokenRow = tokens[0];
  if (!tokenRow) {
    return { kind: "invalid_or_expired_token" };
  }

  const passwordHash = hashPassword(newPassword);
  try {
    await db.withTx(async (tx) => {
      // Consume the token as a compare-and-swap, same reasoning as `verify`:
      // two requests presenting the same reset token can both pass the SELECT
      // above, but only the one that flips `consumed_at` from NULL here may
      // proceed — so a single reset link can't set the password twice.
      const consumed = await tx`
        UPDATE auth_tokens SET consumed_at = now()
        WHERE id = ${tokenRow.id} AND consumed_at IS NULL
        RETURNING id
      `;
      if (consumed.length === 0) {
        throw new TokenRaceLost();
      }
      await tx`
        UPDATE users SET password_hash = ${passwordHash} WHERE id = ${tokenRow.user_id}
      `;
      await revokeAllSessions(tx, tokenRow.user_id);
    });
  } catch (err) {
    if (err instanceof TokenRaceLost) {
      return { kind: "invalid_or_expired_token" };
    }
    throw err;
  }

  return { kind: "reset" };
}
