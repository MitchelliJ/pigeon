/*
 * Integration coverage for authenticated account-management auth routes.
 */
import { expect, it } from "vitest";

import { withTestDb } from "../../../test/db";
import { generateToken, hashToken } from "../tokens";
import { hashPassword, verifyPassword } from "../password";
import { runMigrations } from "../../migrate/runner";
import { createApp } from "../../server";
import type { MailSender } from "../../mail/index";
import type { Vault } from "../../vault/index";

const ORIGIN = "http://localhost:4321";

const fakeMail: MailSender = {
  name: "account-management-test",
  send: async () => ({ ok: true }),
};

const fakeVault: Vault = {
  seal: (value) => value,
  open: (value) => value,
};

function normalizeSessionRows(
  rows: Array<{
    token_hash?: unknown;
    revoked_at?: unknown;
  }>,
): Array<{ tokenHash: string; revokedAt: string | null }> {
  return rows.map((row) => ({
    tokenHash: String(row.token_hash),
    revokedAt:
      row.revoked_at instanceof Date
        ? row.revoked_at.toISOString()
        : row.revoked_at === null || row.revoked_at === undefined
          ? null
          : new Date(String(row.revoked_at)).toISOString(),
  }));
}

function parseJsonOrText(text: string): unknown {
  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

it("POST /api/settings/password rejects a wrong current password without changing the password hash or any session revocation state", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const passwordHash = hashPassword("correct-current-password");
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${"account-management@example.com"},
        ${"Account Owner"},
        ${passwordHash},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const currentSessionToken = generateToken();
    const otherSessionToken = generateToken();
    const revokedSessionToken = generateToken();
    const now = Date.now();
    const currentSessionCreatedAt = new Date(now - 60_000);
    const otherSessionCreatedAt = new Date(now - 120_000);
    const revokedSessionCreatedAt = new Date(now - 180_000);
    const liveSessionExpiresAt = new Date(now + 24 * 60 * 60 * 1000);
    const revokedSessionExpiresAt = new Date(now + 2 * 24 * 60 * 60 * 1000);
    const revokedAt = new Date(now - 30_000);

    await db.query`
      INSERT INTO sessions(
        user_id,
        token_hash,
        created_at,
        last_seen_at,
        expires_at,
        revoked_at
      )
      VALUES
        (
          ${userId},
          ${hashToken(currentSessionToken)},
          ${currentSessionCreatedAt},
          ${currentSessionCreatedAt},
          ${liveSessionExpiresAt},
          ${null}
        ),
        (
          ${userId},
          ${hashToken(otherSessionToken)},
          ${otherSessionCreatedAt},
          ${otherSessionCreatedAt},
          ${liveSessionExpiresAt},
          ${null}
        ),
        (
          ${userId},
          ${hashToken(revokedSessionToken)},
          ${revokedSessionCreatedAt},
          ${revokedSessionCreatedAt},
          ${revokedSessionExpiresAt},
          ${revokedAt}
        )
    `;

    const beforePasswordRows = await db.query`
      SELECT password_hash FROM users WHERE id = ${userId}
    `;
    const beforeSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const response = await app.request("/api/settings/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${currentSessionToken}`,
      },
      body: JSON.stringify({
        currentPassword: "wrong-current-password",
        newPassword: "a-totally-new-password",
      }),
    });

    const afterPasswordRows = await db.query`
      SELECT password_hash FROM users WHERE id = ${userId}
    `;
    const afterSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;
    const responseBody = parseJsonOrText(await response.text());

    expect({
      status: response.status,
      body: responseBody,
      passwordHash: String(afterPasswordRows[0]?.password_hash),
      sessions: normalizeSessionRows(afterSessionRows),
    }).toEqual({
      status: 401,
      body: {
        error: "email or password is incorrect",
        code: "bad_credentials",
      },
      passwordHash: String(beforePasswordRows[0]?.password_hash),
      sessions: normalizeSessionRows(beforeSessionRows),
    });
  } finally {
    await close();
  }
});

it("POST /api/settings/email rejects a wrong current password without setting pending_email, minting a change_email token, or sending mail", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const passwordHash = hashPassword("correct-current-password");
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${"account-management-email@example.com"},
        ${"Account Owner"},
        ${passwordHash},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const currentSessionToken = generateToken();
    await db.query`
      INSERT INTO sessions(
        user_id,
        token_hash,
        created_at,
        last_seen_at,
        expires_at,
        revoked_at
      )
      VALUES (
        ${userId},
        ${hashToken(currentSessionToken)},
        now(),
        now(),
        now() + interval '1 day',
        ${null}
      )
    `;

    const sentMail: Array<{ to: string; subject: string }> = [];
    const app = createApp(
      db,
      {
        name: "account-management-email-test",
        send: async (message) => {
          sentMail.push({ to: message.to, subject: message.subject });
          return { ok: true };
        },
      },
      fakeVault,
    );
    const response = await app.request("/api/settings/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${currentSessionToken}`,
      },
      body: JSON.stringify({
        currentPassword: "wrong-current-password",
        newEmail: "next-address@example.com",
      }),
    });

    const pendingEmailRows = await db.query`
      SELECT pending_email FROM users WHERE id = ${userId}
    `;
    const changeEmailTokenRows = await db.query`
      SELECT kind FROM auth_tokens
      WHERE user_id = ${userId} AND kind = 'change_email'
    `;
    const responseBody = parseJsonOrText(await response.text());

    expect({
      status: response.status,
      body: responseBody,
      pendingEmail: pendingEmailRows[0]?.pending_email ?? null,
      changeEmailTokenCount: changeEmailTokenRows.length,
      sentMail,
    }).toEqual({
      status: 401,
      body: {
        error: "email or password is incorrect",
        code: "bad_credentials",
      },
      pendingEmail: null,
      changeEmailTokenCount: 0,
      sentMail: [],
    });
  } finally {
    await close();
  }
});

it("POST /api/settings/email with the correct current password stores a normalized pending_email, mints one hashed change_email token with ~24h expiry, and sends confirmation and notice emails", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const currentPassword = "correct-current-password";
    const oldEmail = "account-management-email-success@example.com";
    const requestedNewEmail = "  Next.Address+Tag@Example.COM ";
    const normalizedNewEmail = "next.address+tag@example.com";
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${oldEmail},
        ${"Account Owner"},
        ${hashPassword(currentPassword)},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const currentSessionToken = generateToken();
    await db.query`
      INSERT INTO sessions(
        user_id,
        token_hash,
        created_at,
        last_seen_at,
        expires_at,
        revoked_at
      )
      VALUES (
        ${userId},
        ${hashToken(currentSessionToken)},
        now(),
        now(),
        now() + interval '1 day',
        ${null}
      )
    `;

    const sentMail: Array<{
      to: string;
      subject: string;
      html: string;
      text: string;
    }> = [];
    const app = createApp(
      db,
      {
        name: "account-management-email-test",
        send: async (message) => {
          sentMail.push(message);
          return { ok: true };
        },
      },
      fakeVault,
    );
    const requestStartedAt = new Date();
    const response = await app.request("/api/settings/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${currentSessionToken}`,
      },
      body: JSON.stringify({
        currentPassword,
        newEmail: requestedNewEmail,
      }),
    });

    const userStateRows = await db.query`
      SELECT email, pending_email FROM users WHERE id = ${userId}
    `;
    const changeEmailTokenRows = await db.query`
      SELECT token_hash, expires_at, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId} AND kind = 'change_email'
      ORDER BY expires_at ASC
    `;
    const confirmationMail = sentMail.find(
      (message) => message.to === normalizedNewEmail,
    );
    const noticeMail = sentMail.find((message) => message.to === oldEmail);
    const confirmationToken = confirmationMail?.html.match(
      /\/confirm-email\?token=([^"<\s]+)/,
    )?.[1];
    const tokenRow = changeEmailTokenRows[0];
    const expiryMinutesFromRequest = tokenRow
      ? (new Date(String(tokenRow.expires_at)).getTime() -
          requestStartedAt.getTime()) /
        60000
      : null;
    const responseBody = parseJsonOrText(await response.text());

    expect({
      status: response.status,
      body: responseBody,
      email: userStateRows[0]?.email ?? null,
      pendingEmail: userStateRows[0]?.pending_email ?? null,
      changeEmailTokenCount: changeEmailTokenRows.length,
      storedTokenHashMatchesRawToken:
        tokenRow !== undefined && confirmationToken !== undefined
          ? String(tokenRow.token_hash) === hashToken(confirmationToken)
          : false,
      storedTokenHashIsNotRawToken:
        tokenRow !== undefined && confirmationToken !== undefined
          ? String(tokenRow.token_hash) !== confirmationToken
          : false,
      expiryMinutesFromRequest,
      sentMailCount: sentMail.length,
      confirmationMail: confirmationMail
        ? {
            to: confirmationMail.to,
            subject: confirmationMail.subject,
            htmlHasConfirmLink: confirmationMail.html.includes(
              `/confirm-email?token=${confirmationToken}`,
            ),
            textHasConfirmLink: confirmationMail.text.includes(
              `/confirm-email?token=${confirmationToken}`,
            ),
          }
        : null,
      noticeMail: noticeMail
        ? {
            to: noticeMail.to,
            subject: noticeMail.subject,
            htmlHasConfirmLink: noticeMail.html.includes(
              "/confirm-email?token=",
            ),
            textHasConfirmLink: noticeMail.text.includes(
              "/confirm-email?token=",
            ),
            htmlIncludesRawToken:
              confirmationToken !== undefined &&
              confirmationToken.length > 0 &&
              noticeMail.html.includes(confirmationToken),
            textIncludesRawToken:
              confirmationToken !== undefined &&
              confirmationToken.length > 0 &&
              noticeMail.text.includes(confirmationToken),
          }
        : null,
    }).toEqual({
      status: 200,
      body: { ok: true },
      email: oldEmail,
      pendingEmail: normalizedNewEmail,
      changeEmailTokenCount: 1,
      storedTokenHashMatchesRawToken: true,
      storedTokenHashIsNotRawToken: true,
      expiryMinutesFromRequest: expect.toSatisfy(
        (value) => typeof value === "number" && value > 1435 && value < 1445,
      ),
      sentMailCount: 2,
      confirmationMail: {
        to: normalizedNewEmail,
        subject: "Confirm your new email",
        htmlHasConfirmLink: true,
        textHasConfirmLink: true,
      },
      noticeMail: {
        to: oldEmail,
        subject: "Request to change your email address",
        htmlHasConfirmLink: false,
        textHasConfirmLink: false,
        htmlIncludesRawToken: false,
        textIncludesRawToken: false,
      },
    });
  } finally {
    await close();
  }
});

it("POST /api/settings/email rotates a stale outstanding change_email token after cooldown, then treats an immediate third request as a success no-op", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const currentPassword = "correct-current-password";
    const oldEmail = "account-management-email-rotate@example.com";
    const firstRequestedEmail = "first-next@example.com";
    const secondRequestedEmail = "second-next@example.com";
    const thirdRequestedEmail = "third-next@example.com";
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${oldEmail},
        ${"Account Owner"},
        ${hashPassword(currentPassword)},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const currentSessionToken = generateToken();
    await db.query`
      INSERT INTO sessions(
        user_id,
        token_hash,
        created_at,
        last_seen_at,
        expires_at,
        revoked_at
      )
      VALUES (
        ${userId},
        ${hashToken(currentSessionToken)},
        now(),
        now(),
        now() + interval '1 day',
        ${null}
      )
    `;

    const sentMail: Array<{
      to: string;
      subject: string;
      html: string;
      text: string;
    }> = [];
    const app = createApp(
      db,
      {
        name: "account-management-email-rotate-test",
        send: async (message) => {
          sentMail.push(message);
          return { ok: true };
        },
      },
      fakeVault,
    );

    const firstResponse = await app.request("/api/settings/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${currentSessionToken}`,
      },
      body: JSON.stringify({
        currentPassword,
        newEmail: firstRequestedEmail,
      }),
    });

    const firstTokenRows = await db.query`
      SELECT id, token_hash, expires_at, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId} AND kind = 'change_email'
      ORDER BY expires_at ASC, id ASC
    `;
    const firstTokenId = String(firstTokenRows[0]?.id);

    await db.query`
      UPDATE auth_tokens
      SET expires_at = now() + interval '23 hours 58 minutes'
      WHERE id = ${firstTokenId}
    `;

    const secondResponse = await app.request("/api/settings/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${currentSessionToken}`,
      },
      body: JSON.stringify({
        currentPassword,
        newEmail: secondRequestedEmail,
      }),
    });

    const secondTokenRows = await db.query`
      SELECT id, token_hash, expires_at, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId} AND kind = 'change_email'
      ORDER BY expires_at ASC, id ASC
    `;
    const secondPendingEmailRows = await db.query`
      SELECT pending_email FROM users WHERE id = ${userId}
    `;

    const thirdResponse = await app.request("/api/settings/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${currentSessionToken}`,
      },
      body: JSON.stringify({
        currentPassword,
        newEmail: thirdRequestedEmail,
      }),
    });

    const thirdTokenRows = await db.query`
      SELECT id, token_hash, expires_at, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId} AND kind = 'change_email'
      ORDER BY expires_at ASC, id ASC
    `;
    const thirdPendingEmailRows = await db.query`
      SELECT pending_email FROM users WHERE id = ${userId}
    `;

    expect({
      firstStatus: firstResponse.status,
      secondStatus: secondResponse.status,
      thirdStatus: thirdResponse.status,
      firstTokenCount: firstTokenRows.length,
      firstTokenConsumedAt: firstTokenRows[0]?.consumed_at ?? null,
      secondTokenRows: secondTokenRows.map((row) => ({
        id: String(row.id),
        tokenHash: String(row.token_hash),
        expiresAt:
          row.expires_at instanceof Date
            ? row.expires_at.toISOString()
            : new Date(String(row.expires_at)).toISOString(),
        consumedAt:
          row.consumed_at instanceof Date
            ? row.consumed_at.toISOString()
            : row.consumed_at === null || row.consumed_at === undefined
              ? null
              : new Date(String(row.consumed_at)).toISOString(),
      })),
      secondPendingEmail: secondPendingEmailRows[0]?.pending_email ?? null,
      sentMailAfterSecond: sentMail.map((message) => ({
        to: message.to,
        subject: message.subject,
      })),
      thirdTokenRows: thirdTokenRows.map((row) => ({
        id: String(row.id),
        tokenHash: String(row.token_hash),
        expiresAt:
          row.expires_at instanceof Date
            ? row.expires_at.toISOString()
            : new Date(String(row.expires_at)).toISOString(),
        consumedAt:
          row.consumed_at instanceof Date
            ? row.consumed_at.toISOString()
            : row.consumed_at === null || row.consumed_at === undefined
              ? null
              : new Date(String(row.consumed_at)).toISOString(),
      })),
      thirdPendingEmail: thirdPendingEmailRows[0]?.pending_email ?? null,
      sentMailCountAfterThird: sentMail.length,
    }).toEqual({
      firstStatus: 200,
      secondStatus: 200,
      thirdStatus: 200,
      firstTokenCount: 1,
      firstTokenConsumedAt: null,
      secondTokenRows: [
        {
          id: firstTokenId,
          tokenHash: String(firstTokenRows[0]?.token_hash),
          expiresAt: expect.any(String),
          consumedAt: expect.any(String),
        },
        {
          id: expect.not.stringMatching(new RegExp(`^${firstTokenId}$`)),
          tokenHash: expect.not.stringMatching(
            new RegExp(`^${String(firstTokenRows[0]?.token_hash)}$`),
          ),
          expiresAt: expect.any(String),
          consumedAt: null,
        },
      ],
      secondPendingEmail: secondRequestedEmail,
      sentMailAfterSecond: [
        {
          to: firstRequestedEmail,
          subject: "Confirm your new email",
        },
        {
          to: oldEmail,
          subject: "Request to change your email address",
        },
        {
          to: secondRequestedEmail,
          subject: "Confirm your new email",
        },
        {
          to: oldEmail,
          subject: "Request to change your email address",
        },
      ],
      thirdTokenRows: secondTokenRows.map((row) => ({
        id: String(row.id),
        tokenHash: String(row.token_hash),
        expiresAt:
          row.expires_at instanceof Date
            ? row.expires_at.toISOString()
            : new Date(String(row.expires_at)).toISOString(),
        consumedAt:
          row.consumed_at instanceof Date
            ? row.consumed_at.toISOString()
            : row.consumed_at === null || row.consumed_at === undefined
              ? null
              : new Date(String(row.consumed_at)).toISOString(),
      })),
      thirdPendingEmail: secondRequestedEmail,
      sentMailCountAfterThird: 4,
    });
  } finally {
    await close();
  }
});

it("POST /api/settings/email/confirm with a valid raw change_email token works without a session cookie, consumes the token, swaps pending_email into email, preserves the live session, returns the updated profile, and only the new email can log in afterward", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const currentPassword = "correct-current-password";
    const oldEmail = "account-management-email-confirm-old@example.com";
    const newEmail = "account-management-email-confirm-new@example.com";
    const userRows = await db.query`
      INSERT INTO users(email, pending_email, name, password_hash, email_verified_at, tier)
      VALUES (
        ${oldEmail},
        ${newEmail},
        ${"Account Owner"},
        ${hashPassword(currentPassword)},
        now(),
        ${"pro"}
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const existingSessionToken = generateToken();
    const existingSessionHash = hashToken(existingSessionToken);
    await db.query`
      INSERT INTO sessions(user_id, token_hash, expires_at)
      VALUES (${userId}, ${existingSessionHash}, now() + interval '1 day')
    `;

    const rawConfirmToken = generateToken();
    const confirmTokenHash = hashToken(rawConfirmToken);
    await db.query`
      INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at)
      VALUES (
        ${userId},
        'change_email',
        ${confirmTokenHash},
        now() + interval '1 day'
      )
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const beforeSessionRows = normalizeSessionRows(
      await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `,
    );

    const confirmResponse = await app.request("/api/settings/email/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({ token: rawConfirmToken }),
    });
    const confirmResponseBody = parseJsonOrText(await confirmResponse.text());

    const userStateRows = await db.query`
      SELECT email, pending_email, name, tier
      FROM users
      WHERE id = ${userId}
    `;
    const tokenRows = await db.query`
      SELECT token_hash, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId} AND kind = 'change_email'
      ORDER BY token_hash
    `;
    const afterSessionRows = normalizeSessionRows(
      await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `,
    );
    const existingSessionProfile = await app.request("/api/settings/profile", {
      headers: { cookie: `pigeon_session=${existingSessionToken}` },
    });

    const secondConfirmResponse = await app.request(
      "/api/settings/email/confirm",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
        },
        body: JSON.stringify({ token: rawConfirmToken }),
      },
    );
    const secondConfirmResponseBody = parseJsonOrText(
      await secondConfirmResponse.text(),
    );

    const oldEmailLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({ email: oldEmail, password: currentPassword }),
    });
    const newEmailLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({ email: newEmail, password: currentPassword }),
    });

    expect({
      confirmStatus: confirmResponse.status,
      confirmBody: confirmResponseBody,
      email: userStateRows[0]?.email ?? null,
      pendingEmail: userStateRows[0]?.pending_email ?? null,
      tokenRows: tokenRows.map((row) => ({
        tokenHash: String(row.token_hash),
        consumedAt:
          row.consumed_at instanceof Date
            ? row.consumed_at.toISOString()
            : row.consumed_at === null || row.consumed_at === undefined
              ? null
              : new Date(String(row.consumed_at)).toISOString(),
      })),
      sessionsBeforeLogin: afterSessionRows,
      existingSessionProfileStatus: existingSessionProfile.status,
      secondConfirmStatus: secondConfirmResponse.status,
      secondConfirmBody: secondConfirmResponseBody,
      oldEmailLoginStatus: oldEmailLogin.status,
      newEmailLoginStatus: newEmailLogin.status,
    }).toEqual({
      confirmStatus: 200,
      confirmBody: {
        profile: {
          name: "Account Owner",
          email: newEmail,
          tier: "pro",
        },
      },
      email: newEmail,
      pendingEmail: null,
      tokenRows: [
        {
          tokenHash: confirmTokenHash,
          consumedAt: expect.any(String),
        },
      ],
      sessionsBeforeLogin: beforeSessionRows,
      existingSessionProfileStatus: 200,
      secondConfirmStatus: 400,
      secondConfirmBody: {
        error: "token is invalid or expired",
        code: "invalid_or_expired_token",
      },
      oldEmailLoginStatus: 401,
      newEmailLoginStatus: 200,
    });
  } finally {
    await close();
  }
});

it("POST /api/settings/email/confirm rejects invalid, expired, and consumed change_email tokens without changing email, pending_email, or token state", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const oldEmail = "account-management-unusable-token-old@example.com";
    const pendingEmail = "account-management-unusable-token-new@example.com";
    const userRows = await db.query`
      INSERT INTO users(email, pending_email, name, password_hash, email_verified_at)
      VALUES (
        ${oldEmail},
        ${pendingEmail},
        ${"Account Owner"},
        ${hashPassword("correct-current-password")},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const invalidRawToken = generateToken();
    const expiredRawToken = generateToken();
    const consumedRawToken = generateToken();
    await db.query`
      INSERT INTO auth_tokens(
        user_id,
        kind,
        token_hash,
        expires_at,
        consumed_at
      )
      VALUES
        (
          ${userId},
          'change_email',
          ${hashToken(expiredRawToken)},
          now() - interval '1 minute',
          ${null}
        ),
        (
          ${userId},
          'change_email',
          ${hashToken(consumedRawToken)},
          now() + interval '1 day',
          now() - interval '1 minute'
        )
    `;

    const beforeUserRows = await db.query`
      SELECT email, pending_email FROM users WHERE id = ${userId}
    `;
    const beforeTokenRows = await db.query`
      SELECT token_hash, expires_at, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId} AND kind = 'change_email'
      ORDER BY token_hash
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const responses = [];
    for (const token of [invalidRawToken, expiredRawToken, consumedRawToken]) {
      const response = await app.request("/api/settings/email/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
        },
        body: JSON.stringify({ token }),
      });
      responses.push({
        status: response.status,
        body: parseJsonOrText(await response.text()),
      });
    }

    const afterUserRows = await db.query`
      SELECT email, pending_email FROM users WHERE id = ${userId}
    `;
    const afterTokenRows = await db.query`
      SELECT token_hash, expires_at, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId} AND kind = 'change_email'
      ORDER BY token_hash
    `;

    expect({
      responses,
      user: afterUserRows[0],
      tokens: afterTokenRows,
    }).toEqual({
      responses: [invalidRawToken, expiredRawToken, consumedRawToken].map(
        () => ({
          status: 400,
          body: {
            error: "token is invalid or expired",
            code: "invalid_or_expired_token",
          },
        }),
      ),
      user: beforeUserRows[0],
      tokens: beforeTokenRows,
    });
  } finally {
    await close();
  }
});

it("POST /api/settings/email/confirm returns email_taken and rolls back when another user claimed the pending email", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const oldEmail = "account-management-claimed-old@example.com";
    const pendingEmail = "account-management-claimed-new@example.com";
    const originalUserRows = await db.query`
      INSERT INTO users(email, pending_email, name, password_hash, email_verified_at)
      VALUES (
        ${oldEmail},
        ${pendingEmail},
        ${"Original User"},
        ${hashPassword("original-users-password")},
        now()
      )
      RETURNING id
    `;
    const originalUserId = String(originalUserRows[0]?.id);

    const rawConfirmToken = generateToken();
    await db.query`
      INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at, consumed_at)
      VALUES (
        ${originalUserId},
        'change_email',
        ${hashToken(rawConfirmToken)},
        now() + interval '1 day',
        ${null}
      )
    `;

    await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${pendingEmail},
        ${"Claiming User"},
        ${hashPassword("claiming-users-password")},
        now()
      )
    `;

    const beforeUserRows = await db.query`
      SELECT email, pending_email FROM users WHERE id = ${originalUserId}
    `;
    const beforeTokenRows = await db.query`
      SELECT token_hash, expires_at, consumed_at
      FROM auth_tokens
      WHERE user_id = ${originalUserId} AND kind = 'change_email'
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const response = await app.request("/api/settings/email/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({ token: rawConfirmToken }),
    });
    const responseBody = parseJsonOrText(await response.text());

    const afterUserRows = await db.query`
      SELECT email, pending_email FROM users WHERE id = ${originalUserId}
    `;
    const afterTokenRows = await db.query`
      SELECT token_hash, expires_at, consumed_at
      FROM auth_tokens
      WHERE user_id = ${originalUserId} AND kind = 'change_email'
    `;

    expect({
      status: response.status,
      body: responseBody,
      user: afterUserRows[0],
      tokens: afterTokenRows,
    }).toEqual({
      status: 409,
      body: {
        error: "email is already in use",
        code: "email_taken",
      },
      user: beforeUserRows[0],
      tokens: beforeTokenRows,
    });
  } finally {
    await close();
  }
});

it("POST /api/settings/password rejects a weak new password without changing the password hash or any session revocation state", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const passwordHash = hashPassword("correct-current-password");
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${"account-management-weak-password@example.com"},
        ${"Account Owner"},
        ${passwordHash},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const currentSessionToken = generateToken();
    const otherSessionToken = generateToken();
    const revokedSessionToken = generateToken();
    const now = Date.now();
    const currentSessionCreatedAt = new Date(now - 60_000);
    const otherSessionCreatedAt = new Date(now - 120_000);
    const revokedSessionCreatedAt = new Date(now - 180_000);
    const liveSessionExpiresAt = new Date(now + 24 * 60 * 60 * 1000);
    const revokedSessionExpiresAt = new Date(now + 2 * 24 * 60 * 60 * 1000);
    const revokedAt = new Date(now - 30_000);

    await db.query`
      INSERT INTO sessions(
        user_id,
        token_hash,
        created_at,
        last_seen_at,
        expires_at,
        revoked_at
      )
      VALUES
        (
          ${userId},
          ${hashToken(currentSessionToken)},
          ${currentSessionCreatedAt},
          ${currentSessionCreatedAt},
          ${liveSessionExpiresAt},
          ${null}
        ),
        (
          ${userId},
          ${hashToken(otherSessionToken)},
          ${otherSessionCreatedAt},
          ${otherSessionCreatedAt},
          ${liveSessionExpiresAt},
          ${null}
        ),
        (
          ${userId},
          ${hashToken(revokedSessionToken)},
          ${revokedSessionCreatedAt},
          ${revokedSessionCreatedAt},
          ${revokedSessionExpiresAt},
          ${revokedAt}
        )
    `;

    const beforePasswordRows = await db.query`
      SELECT password_hash FROM users WHERE id = ${userId}
    `;
    const beforeSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const response = await app.request("/api/settings/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${currentSessionToken}`,
      },
      body: JSON.stringify({
        currentPassword: "correct-current-password",
        newPassword: "password",
      }),
    });

    const afterPasswordRows = await db.query`
      SELECT password_hash FROM users WHERE id = ${userId}
    `;
    const afterSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;
    const responseBody = parseJsonOrText(await response.text());
    const responseCode =
      responseBody !== null &&
      typeof responseBody === "object" &&
      "code" in responseBody
        ? responseBody.code
        : undefined;

    expect({
      status: response.status,
      code: responseCode,
      passwordHash: String(afterPasswordRows[0]?.password_hash),
      sessions: normalizeSessionRows(afterSessionRows),
    }).toEqual({
      status: 400,
      code: "invalid_input",
      passwordHash: String(beforePasswordRows[0]?.password_hash),
      sessions: normalizeSessionRows(beforeSessionRows),
    });
  } finally {
    await close();
  }
});

it("POST /api/settings/password without a session returns 401 unauthenticated and leaves the password unchanged", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const passwordHash = hashPassword("correct-current-password");
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${"account-management-no-session@example.com"},
        ${"Account Owner"},
        ${passwordHash},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const beforePasswordRows = await db.query`
      SELECT password_hash FROM users WHERE id = ${userId}
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const response = await app.request("/api/settings/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({
        currentPassword: "correct-current-password",
        newPassword: "a-totally-new-password",
      }),
    });

    const afterPasswordRows = await db.query`
      SELECT password_hash FROM users WHERE id = ${userId}
    `;
    const responseBody = parseJsonOrText(await response.text());

    expect({
      status: response.status,
      body: responseBody,
      passwordHash: String(afterPasswordRows[0]?.password_hash),
    }).toEqual({
      status: 401,
      body: {
        error: "authentication required",
        code: "unauthenticated",
      },
      passwordHash: String(beforePasswordRows[0]?.password_hash),
    });
  } finally {
    await close();
  }
});

it("POST /api/settings/password with an authenticated cross-origin Origin returns 403 cross_origin and leaves the password and session revocation state unchanged", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const passwordHash = hashPassword("correct-current-password");
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${"account-management-cross-origin@example.com"},
        ${"Account Owner"},
        ${passwordHash},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const currentSessionToken = generateToken();
    const otherSessionToken = generateToken();
    const revokedSessionToken = generateToken();
    const now = Date.now();
    const currentSessionCreatedAt = new Date(now - 60_000);
    const otherSessionCreatedAt = new Date(now - 120_000);
    const revokedSessionCreatedAt = new Date(now - 180_000);
    const liveSessionExpiresAt = new Date(now + 24 * 60 * 60 * 1000);
    const revokedSessionExpiresAt = new Date(now + 2 * 24 * 60 * 60 * 1000);
    const revokedAt = new Date(now - 30_000);

    await db.query`
      INSERT INTO sessions(
        user_id,
        token_hash,
        created_at,
        last_seen_at,
        expires_at,
        revoked_at
      )
      VALUES
        (
          ${userId},
          ${hashToken(currentSessionToken)},
          ${currentSessionCreatedAt},
          ${currentSessionCreatedAt},
          ${liveSessionExpiresAt},
          ${null}
        ),
        (
          ${userId},
          ${hashToken(otherSessionToken)},
          ${otherSessionCreatedAt},
          ${otherSessionCreatedAt},
          ${liveSessionExpiresAt},
          ${null}
        ),
        (
          ${userId},
          ${hashToken(revokedSessionToken)},
          ${revokedSessionCreatedAt},
          ${revokedSessionCreatedAt},
          ${revokedSessionExpiresAt},
          ${revokedAt}
        )
    `;

    const beforePasswordRows = await db.query`
      SELECT password_hash FROM users WHERE id = ${userId}
    `;
    const beforeSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const response = await app.request("/api/settings/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.test",
        cookie: `pigeon_session=${currentSessionToken}`,
      },
      body: JSON.stringify({
        currentPassword: "correct-current-password",
        newPassword: "a-totally-new-password",
      }),
    });

    const afterPasswordRows = await db.query`
      SELECT password_hash FROM users WHERE id = ${userId}
    `;
    const afterSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;
    const responseBody = parseJsonOrText(await response.text());

    expect({
      status: response.status,
      body: responseBody,
      passwordHash: String(afterPasswordRows[0]?.password_hash),
      sessions: normalizeSessionRows(afterSessionRows),
    }).toEqual({
      status: 403,
      body: {
        error: "cross-origin request rejected",
        code: "cross_origin",
      },
      passwordHash: String(beforePasswordRows[0]?.password_hash),
      sessions: normalizeSessionRows(beforeSessionRows),
    });
  } finally {
    await close();
  }
});

it("POST /api/settings/password with the correct current password changes the password, keeps the current session live, and revokes the user's other live sessions", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const email = "account-management-success@example.com";
    const otherUserEmail = "other-account-management@example.com";
    const currentPassword = "correct-current-password";
    const newPassword = "a-totally-new-password";
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES
        (
          ${email},
          ${"Account Owner"},
          ${hashPassword(currentPassword)},
          now()
        ),
        (
          ${otherUserEmail},
          ${"Other User"},
          ${hashPassword("other-users-password")},
          now()
        )
      RETURNING id, email
    `;
    const userId = String(userRows.find((row) => row.email === email)?.id);
    const otherUserId = String(
      userRows.find((row) => row.email === otherUserEmail)?.id,
    );

    const currentSessionToken = generateToken();
    const otherSessionToken = generateToken();
    const revokedSessionToken = generateToken();
    const otherUserSessionToken = generateToken();
    const currentSessionHash = hashToken(currentSessionToken);
    const otherSessionHash = hashToken(otherSessionToken);
    const revokedSessionHash = hashToken(revokedSessionToken);
    const otherUserSessionHash = hashToken(otherUserSessionToken);
    const now = Date.now();
    const currentSessionCreatedAt = new Date(now - 60_000);
    const otherSessionCreatedAt = new Date(now - 120_000);
    const revokedSessionCreatedAt = new Date(now - 180_000);
    const otherUserSessionCreatedAt = new Date(now - 240_000);
    const liveSessionExpiresAt = new Date(now + 24 * 60 * 60 * 1000);
    const revokedSessionExpiresAt = new Date(now + 2 * 24 * 60 * 60 * 1000);
    const revokedAt = new Date(now - 30_000);

    await db.query`
      INSERT INTO sessions(
        user_id,
        token_hash,
        created_at,
        last_seen_at,
        expires_at,
        revoked_at
      )
      VALUES
        (
          ${userId},
          ${currentSessionHash},
          ${currentSessionCreatedAt},
          ${currentSessionCreatedAt},
          ${liveSessionExpiresAt},
          ${null}
        ),
        (
          ${userId},
          ${otherSessionHash},
          ${otherSessionCreatedAt},
          ${otherSessionCreatedAt},
          ${liveSessionExpiresAt},
          ${null}
        ),
        (
          ${userId},
          ${revokedSessionHash},
          ${revokedSessionCreatedAt},
          ${revokedSessionCreatedAt},
          ${revokedSessionExpiresAt},
          ${revokedAt}
        ),
        (
          ${otherUserId},
          ${otherUserSessionHash},
          ${otherUserSessionCreatedAt},
          ${otherUserSessionCreatedAt},
          ${liveSessionExpiresAt},
          ${null}
        )
    `;

    const beforeTargetSessions = normalizeSessionRows(
      await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `,
    );
    const beforeRevokedSession = beforeTargetSessions.find(
      (row) => row.tokenHash === revokedSessionHash,
    );

    const app = createApp(db, fakeMail, fakeVault);
    const response = await app.request("/api/settings/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${currentSessionToken}`,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    const responseBody = parseJsonOrText(await response.text());
    const passwordRows = await db.query`
      SELECT password_hash FROM users WHERE id = ${userId}
    `;
    const updatedPasswordHash = String(passwordRows[0]?.password_hash);
    const afterTargetSessions = normalizeSessionRows(
      await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `,
    );
    const afterOtherUserSessions = normalizeSessionRows(
      await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${otherUserId}
      ORDER BY token_hash
    `,
    );
    const currentSessionProfile = await app.request("/api/settings/profile", {
      headers: { cookie: `pigeon_session=${currentSessionToken}` },
    });
    const otherSessionProfile = await app.request("/api/settings/profile", {
      headers: { cookie: `pigeon_session=${otherSessionToken}` },
    });
    const otherUserSessionProfile = await app.request("/api/settings/profile", {
      headers: { cookie: `pigeon_session=${otherUserSessionToken}` },
    });
    const oldPasswordLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({ email, password: currentPassword }),
    });
    const newPasswordLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({ email, password: newPassword }),
    });

    expect({
      status: response.status,
      body: responseBody,
      hashAcceptsOldPassword: verifyPassword(
        currentPassword,
        updatedPasswordHash,
      ),
      hashAcceptsNewPassword: verifyPassword(newPassword, updatedPasswordHash),
      currentSessionRevokedAt:
        afterTargetSessions.find((row) => row.tokenHash === currentSessionHash)
          ?.revokedAt ?? null,
      otherSessionRevokedAt:
        afterTargetSessions.find((row) => row.tokenHash === otherSessionHash)
          ?.revokedAt ?? null,
      previouslyRevokedSessionRevokedAt:
        afterTargetSessions.find((row) => row.tokenHash === revokedSessionHash)
          ?.revokedAt ?? null,
      otherUserSessionRevokedAt: afterOtherUserSessions[0]?.revokedAt ?? null,
      currentSessionProfileStatus: currentSessionProfile.status,
      otherSessionProfileStatus: otherSessionProfile.status,
      otherUserSessionProfileStatus: otherUserSessionProfile.status,
      oldPasswordLoginStatus: oldPasswordLogin.status,
      newPasswordLoginStatus: newPasswordLogin.status,
    }).toEqual({
      status: 200,
      body: { ok: true },
      hashAcceptsOldPassword: false,
      hashAcceptsNewPassword: true,
      currentSessionRevokedAt: null,
      otherSessionRevokedAt: expect.any(String),
      previouslyRevokedSessionRevokedAt:
        beforeRevokedSession?.revokedAt ?? null,
      otherUserSessionRevokedAt: null,
      currentSessionProfileStatus: 200,
      otherSessionProfileStatus: 401,
      otherUserSessionProfileStatus: 200,
      oldPasswordLoginStatus: 401,
      newPasswordLoginStatus: 200,
    });
  } finally {
    await close();
  }
});

it("POST /api/privacy/erase rejects a wrong current password without setting deletion_requested_at, deleting the user, or revoking the authenticating session", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const email = "account-erase-bad-password@example.com";
    const currentPassword = "correct-current-password";
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${email},
        ${"Account Owner"},
        ${hashPassword(currentPassword)},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const sessionToken = generateToken();
    const sessionHash = hashToken(sessionToken);
    await db.query`
      INSERT INTO sessions(user_id, token_hash, expires_at)
      VALUES (${userId}, ${sessionHash}, now() + interval '1 day')
    `;

    const beforeUserRows = await db.query`
      SELECT id, email, deletion_requested_at
      FROM users
      WHERE id = ${userId}
    `;
    const beforeSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const response = await app.request("/api/privacy/erase", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${sessionToken}`,
      },
      body: JSON.stringify({
        password: "wrong-current-password",
        confirm: "delete my account",
      }),
    });
    const responseBody = parseJsonOrText(await response.text());

    const afterUserRows = await db.query`
      SELECT id, email, deletion_requested_at
      FROM users
      WHERE id = ${userId}
    `;
    const afterSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;
    const profileResponse = await app.request("/api/settings/profile", {
      headers: { cookie: `pigeon_session=${sessionToken}` },
    });

    expect({
      status: response.status,
      body: responseBody,
      userRows: afterUserRows.map((row) => ({
        id: String(row.id),
        email: String(row.email),
        deletionRequestedAt:
          row.deletion_requested_at instanceof Date
            ? row.deletion_requested_at.toISOString()
            : row.deletion_requested_at === null ||
                row.deletion_requested_at === undefined
              ? null
              : new Date(String(row.deletion_requested_at)).toISOString(),
      })),
      sessions: normalizeSessionRows(afterSessionRows),
      profileStatus: profileResponse.status,
    }).toEqual({
      status: 401,
      body: {
        error: "email or password is incorrect",
        code: "bad_credentials",
      },
      userRows: beforeUserRows.map((row) => ({
        id: String(row.id),
        email: String(row.email),
        deletionRequestedAt:
          row.deletion_requested_at instanceof Date
            ? row.deletion_requested_at.toISOString()
            : row.deletion_requested_at === null ||
                row.deletion_requested_at === undefined
              ? null
              : new Date(String(row.deletion_requested_at)).toISOString(),
      })),
      sessions: normalizeSessionRows(beforeSessionRows),
      profileStatus: 200,
    });
  } finally {
    await close();
  }
});

it("POST /api/privacy/erase with the correct current password but a near-miss confirmation returns invalid_input and preserves deletion/session state", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const email = "account-erase-near-miss-confirmation@example.com";
    const currentPassword = "correct-current-password";
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${email},
        ${"Account Owner"},
        ${hashPassword(currentPassword)},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const sessionToken = generateToken();
    const sessionHash = hashToken(sessionToken);
    await db.query`
      INSERT INTO sessions(user_id, token_hash, expires_at)
      VALUES (${userId}, ${sessionHash}, now() + interval '1 day')
    `;

    const beforeUserRows = await db.query`
      SELECT id, email, deletion_requested_at
      FROM users
      WHERE id = ${userId}
    `;
    const beforeSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const response = await app.request("/api/privacy/erase", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${sessionToken}`,
      },
      body: JSON.stringify({
        password: currentPassword,
        confirm: "Delete my account",
      }),
    });
    const responseBody = parseJsonOrText(await response.text());

    const afterUserRows = await db.query`
      SELECT id, email, deletion_requested_at
      FROM users
      WHERE id = ${userId}
    `;
    const afterSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;
    const profileResponse = await app.request("/api/settings/profile", {
      headers: { cookie: `pigeon_session=${sessionToken}` },
    });

    expect({
      status: response.status,
      body: responseBody,
      userRows: afterUserRows.map((row) => ({
        id: String(row.id),
        email: String(row.email),
        deletionRequestedAt:
          row.deletion_requested_at instanceof Date
            ? row.deletion_requested_at.toISOString()
            : row.deletion_requested_at === null ||
                row.deletion_requested_at === undefined
              ? null
              : new Date(String(row.deletion_requested_at)).toISOString(),
      })),
      sessions: normalizeSessionRows(afterSessionRows),
      profileStatus: profileResponse.status,
    }).toEqual({
      status: 400,
      body: {
        error: "confirmation must exactly match delete my account",
        code: "invalid_input",
      },
      userRows: beforeUserRows.map((row) => ({
        id: String(row.id),
        email: String(row.email),
        deletionRequestedAt:
          row.deletion_requested_at instanceof Date
            ? row.deletion_requested_at.toISOString()
            : row.deletion_requested_at === null ||
                row.deletion_requested_at === undefined
              ? null
              : new Date(String(row.deletion_requested_at)).toISOString(),
      })),
      sessions: normalizeSessionRows(beforeSessionRows),
      profileStatus: 200,
    });
  } finally {
    await close();
  }
});

it("POST /api/privacy/erase with valid credentials stamps deletion_requested_at once, returns stable 24h deletion timestamps, and leaves the account, session, and existing data intact", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const email = "account-erase-valid@example.com";
    const currentPassword = "correct-current-password";
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at)
      VALUES (
        ${email},
        ${"Account Owner"},
        ${hashPassword(currentPassword)},
        now()
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const sessionToken = generateToken();
    const sessionHash = hashToken(sessionToken);
    const existingTokenHash = hashToken(generateToken());
    await db.query`
      INSERT INTO sessions(user_id, token_hash, expires_at)
      VALUES (${userId}, ${sessionHash}, now() + interval '1 day')
    `;
    await db.query`
      INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at)
      VALUES (
        ${userId},
        'change_email',
        ${existingTokenHash},
        now() + interval '1 day'
      )
    `;

    const beforeSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;
    const beforeAuthTokenRows = await db.query`
      SELECT kind, token_hash, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId}
      ORDER BY kind, token_hash
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const firstResponse = await app.request("/api/privacy/erase", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${sessionToken}`,
      },
      body: JSON.stringify({
        password: currentPassword,
        confirm: "delete my account",
      }),
    });
    const firstBody = parseJsonOrText(await firstResponse.text()) as {
      ok: boolean;
      requestedAt: string;
      deletesAt: string;
    };

    const firstUserRows = await db.query`
      SELECT email, deletion_requested_at
      FROM users
      WHERE id = ${userId}
    `;

    const secondResponse = await app.request("/api/privacy/erase", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `pigeon_session=${sessionToken}`,
      },
      body: JSON.stringify({
        password: currentPassword,
        confirm: "delete my account",
      }),
    });
    const secondBody = parseJsonOrText(await secondResponse.text()) as {
      ok: boolean;
      requestedAt: string;
      deletesAt: string;
    };

    const secondUserRows = await db.query`
      SELECT email, deletion_requested_at
      FROM users
      WHERE id = ${userId}
    `;
    const afterSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;
    const afterAuthTokenRows = await db.query`
      SELECT kind, token_hash, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId}
      ORDER BY kind, token_hash
    `;
    const profileResponse = await app.request("/api/settings/profile", {
      headers: { cookie: `pigeon_session=${sessionToken}` },
    });

    const requestedAt = new Date(firstBody.requestedAt);
    const deletesAt = new Date(firstBody.deletesAt);
    const firstStoredRequestedAt = firstUserRows[0]?.deletion_requested_at;
    const secondStoredRequestedAt = secondUserRows[0]?.deletion_requested_at;
    const toIsoOrNull = (value: unknown): string | null =>
      value instanceof Date
        ? value.toISOString()
        : value === null || value === undefined
          ? null
          : new Date(String(value)).toISOString();
    const firstStoredRequestedAtIso = toIsoOrNull(firstStoredRequestedAt);
    const secondStoredRequestedAtIso = toIsoOrNull(secondStoredRequestedAt);

    expect(firstResponse.status).toBe(200);
    expect(firstBody.ok).toBe(true);
    expect(firstBody.requestedAt).toBe(firstStoredRequestedAtIso);
    expect(deletesAt.getTime() - requestedAt.getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(secondResponse.status).toBe(200);
    expect(secondBody).toEqual(firstBody);
    expect(secondStoredRequestedAtIso).toBe(firstStoredRequestedAtIso);
    expect(firstUserRows[0]?.email).toBe(email);
    expect(normalizeSessionRows(afterSessionRows)).toEqual(
      normalizeSessionRows(beforeSessionRows),
    );
    expect(afterAuthTokenRows).toEqual(beforeAuthTokenRows);
    expect(profileResponse.status).toBe(200);
  } finally {
    await close();
  }
});

it("POST /api/privacy/erase/cancel before the 24-hour deadline clears deletion_requested_at, preserves the account/session/data, and is idempotent", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const email = "account-erase-cancel@example.com";
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at, tier)
      VALUES (
        ${email},
        ${"Account Owner"},
        ${hashPassword("correct-current-password")},
        now(),
        ${"pro"}
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const sessionToken = generateToken();
    const sessionHash = hashToken(sessionToken);
    const existingTokenHash = hashToken(generateToken());
    await db.query`
      INSERT INTO sessions(user_id, token_hash, expires_at)
      VALUES (${userId}, ${sessionHash}, now() + interval '1 day')
    `;
    await db.query`
      INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at)
      VALUES (
        ${userId},
        'change_email',
        ${existingTokenHash},
        now() + interval '1 day'
      )
    `;

    const deletionRequestedAt = new Date(Date.now() - 60 * 60 * 1000);
    await db.query`
      UPDATE users
      SET deletion_requested_at = ${deletionRequestedAt}
      WHERE id = ${userId}
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const beforeTokenRows = await db.query`
      SELECT kind, token_hash, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId}
      ORDER BY kind, token_hash
    `;

    const firstResponse = await app.request("/api/privacy/erase/cancel", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: `pigeon_session=${sessionToken}`,
      },
    });
    const firstBody = parseJsonOrText(await firstResponse.text());

    const secondResponse = await app.request("/api/privacy/erase/cancel", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: `pigeon_session=${sessionToken}`,
      },
    });
    const secondBody = parseJsonOrText(await secondResponse.text());

    const userStateRows = await db.query`
      SELECT email, deletion_requested_at
      FROM users
      WHERE id = ${userId}
    `;
    const sessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;
    const afterTokenRows = await db.query`
      SELECT kind, token_hash, consumed_at
      FROM auth_tokens
      WHERE user_id = ${userId}
      ORDER BY kind, token_hash
    `;
    const profileResponse = await app.request("/api/settings/profile", {
      headers: { cookie: `pigeon_session=${sessionToken}` },
    });
    const profileBody = parseJsonOrText(await profileResponse.text());

    expect({
      firstStatus: firstResponse.status,
      firstBody,
      secondStatus: secondResponse.status,
      secondBody,
      userRows: userStateRows.map((row) => ({
        email: String(row.email),
        deletionRequestedAt:
          row.deletion_requested_at instanceof Date
            ? row.deletion_requested_at.toISOString()
            : row.deletion_requested_at === null ||
                row.deletion_requested_at === undefined
              ? null
              : new Date(String(row.deletion_requested_at)).toISOString(),
      })),
      sessions: normalizeSessionRows(sessionRows),
      authTokens: afterTokenRows,
      profileStatus: profileResponse.status,
      profileBody,
    }).toEqual({
      firstStatus: 200,
      firstBody: { ok: true },
      secondStatus: 200,
      secondBody: { ok: true },
      userRows: [
        {
          email,
          deletionRequestedAt: null,
        },
      ],
      sessions: [
        {
          tokenHash: sessionHash,
          revokedAt: null,
        },
      ],
      authTokens: beforeTokenRows,
      profileStatus: 200,
      profileBody: {
        profile: {
          name: "Account Owner",
          email,
          tier: "pro",
          deletionRequestedAt: null,
          deletesAt: null,
        },
      },
    });
  } finally {
    await close();
  }
});

it("POST /api/privacy/erase/cancel when deletion is already due returns deletion_due and keeps deletion_requested_at and the live session unchanged", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const email = "account-erase-cancel-due@example.com";
    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at, tier)
      VALUES (
        ${email},
        ${"Account Owner"},
        ${hashPassword("correct-current-password")},
        now(),
        ${"pro"}
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const sessionToken = generateToken();
    const sessionHash = hashToken(sessionToken);
    await db.query`
      INSERT INTO sessions(user_id, token_hash, expires_at)
      VALUES (${userId}, ${sessionHash}, now() + interval '1 day')
    `;

    const deletionRequestedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const deletesAt = new Date(
      deletionRequestedAt.getTime() + 24 * 60 * 60 * 1000,
    );
    await db.query`
      UPDATE users
      SET deletion_requested_at = ${deletionRequestedAt}
      WHERE id = ${userId}
    `;

    const beforeSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const response = await app.request("/api/privacy/erase/cancel", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: `pigeon_session=${sessionToken}`,
      },
    });
    const responseBody = parseJsonOrText(await response.text());

    const userStateRows = await db.query`
      SELECT email, deletion_requested_at
      FROM users
      WHERE id = ${userId}
    `;
    const afterSessionRows = await db.query`
      SELECT token_hash, revoked_at
      FROM sessions
      WHERE user_id = ${userId}
      ORDER BY token_hash
    `;
    const profileResponse = await app.request("/api/settings/profile", {
      headers: { cookie: `pigeon_session=${sessionToken}` },
    });
    const profileBody = parseJsonOrText(await profileResponse.text());

    expect({
      status: response.status,
      body: responseBody,
      userRows: userStateRows.map((row) => ({
        email: String(row.email),
        deletionRequestedAt:
          row.deletion_requested_at instanceof Date
            ? row.deletion_requested_at.toISOString()
            : row.deletion_requested_at === null ||
                row.deletion_requested_at === undefined
              ? null
              : new Date(String(row.deletion_requested_at)).toISOString(),
      })),
      sessions: normalizeSessionRows(afterSessionRows),
      profileStatus: profileResponse.status,
      profileBody,
    }).toEqual({
      status: 409,
      body: {
        error: "account deletion is already due",
        code: "deletion_due",
      },
      userRows: [
        {
          email,
          deletionRequestedAt: deletionRequestedAt.toISOString(),
        },
      ],
      sessions: normalizeSessionRows(beforeSessionRows),
      profileStatus: 200,
      profileBody: {
        profile: {
          name: "Account Owner",
          email,
          tier: "pro",
          deletionRequestedAt: deletionRequestedAt.toISOString(),
          deletesAt: deletesAt.toISOString(),
        },
      },
    });
  } finally {
    await close();
  }
});
