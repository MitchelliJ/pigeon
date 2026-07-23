/*
 * Cross-feature integration coverage for the authenticated account lifecycle:
 * email change confirmation, login rollover, password change session revocation,
 * deletion pending, scheduler suppression, cancellation, and scheduler resume.
 */
import { expect, it } from "vitest";

import { withTestDb } from "../../../test/db";
import { runMigrations } from "../../migrate/runner";
import { createApp } from "../../server";
import { runSchedulerTick } from "../../queue/scheduler";
import { generateToken, hashToken } from "../tokens";
import { hashPassword } from "../password";
import type { MailSender, MailInput } from "../../mail/index";
import type { Vault } from "../../vault/index";

const ORIGIN = "http://localhost:4321";
const JSON_HEADERS = { "content-type": "application/json", origin: ORIGIN };

type CapturedMail = MailInput;

const fakeVault: Vault = {
  seal: (value) => value,
  open: (value) => value,
};

function extractSessionCookiePair(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("response has no set-cookie header");
  }

  const pair = setCookie.split(";")[0]?.trim();
  if (!pair || !pair.startsWith("pigeon_session=")) {
    throw new Error(`unexpected set-cookie shape: ${setCookie}`);
  }

  return pair;
}

function extractConfirmationToken(message: CapturedMail): string {
  const match = message.html.match(/confirm-email\?token=([^"<&\s]+)/);
  if (!match?.[1]) {
    throw new Error(
      `no confirmation token found in email html: ${message.html}`,
    );
  }

  return match[1];
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

it("completes the authenticated account lifecycle from email change through deletion cancellation and scheduler resume", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);

    const currentPassword = "correct-current-password";
    const newPassword = "a-totally-new-password";
    const oldEmail = "account-lifecycle-old@example.com";
    const newEmail = "account-lifecycle-new@example.com";

    const userRows = await db.query`
      INSERT INTO users(email, name, password_hash, email_verified_at, tier)
      VALUES (
        ${oldEmail},
        ${"Account Owner"},
        ${hashPassword(currentPassword)},
        now(),
        ${"free"}
      )
      RETURNING id
    `;
    const userId = String(userRows[0]?.id);

    const currentSessionToken = generateToken();
    const otherSessionToken = generateToken();
    await db.query`
      INSERT INTO sessions(user_id, token_hash, expires_at, revoked_at)
      VALUES
        (
          ${userId},
          ${hashToken(currentSessionToken)},
          now() + interval '1 day',
          ${null}
        ),
        (
          ${userId},
          ${hashToken(otherSessionToken)},
          now() + interval '1 day',
          ${null}
        )
    `;

    const mailboxRows = await db.query`
      INSERT INTO mailboxes(
        user_id,
        provider,
        protocol,
        label,
        address,
        host,
        port,
        tls,
        username,
        password_ciphertext,
        last_synced_at,
        status
      ) VALUES (
        ${userId},
        ${"imap"},
        ${"imap"},
        ${"Primary"},
        ${oldEmail},
        ${"imap.example.com"},
        ${993},
        ${true},
        ${oldEmail},
        ${"gcm:iv:tag:ct"},
        now() - interval '31 minutes',
        ${"connected"}
      )
      RETURNING id
    `;
    const mailboxId = String(mailboxRows[0]?.id);

    const sentMail: CapturedMail[] = [];
    const fakeMail: MailSender = {
      name: "account-lifecycle-test",
      send: async (message) => {
        sentMail.push(message);
        return { ok: true };
      },
    };

    const app = createApp(db, fakeMail, fakeVault);

    const requestEmailChangeResponse = await app.request(
      "/api/settings/email",
      {
        method: "POST",
        headers: {
          ...JSON_HEADERS,
          cookie: `pigeon_session=${currentSessionToken}`,
        },
        body: JSON.stringify({
          currentPassword,
          newEmail,
        }),
      },
    );

    const confirmationMail = sentMail.find(
      (message) => message.to === newEmail,
    );
    if (!confirmationMail) {
      throw new Error("expected confirmation mail to new email address");
    }
    const confirmationToken = extractConfirmationToken(confirmationMail);

    const confirmResponse = await app.request("/api/settings/email/confirm", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: confirmationToken }),
    });

    const oldEmailLoginResponse = await app.request("/api/auth/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: oldEmail, password: currentPassword }),
    });
    const newEmailLoginResponse = await app.request("/api/auth/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: newEmail, password: currentPassword }),
    });
    const newSessionCookie = extractSessionCookiePair(newEmailLoginResponse);

    const changePasswordResponse = await app.request("/api/settings/password", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        cookie: newSessionCookie,
      },
      body: JSON.stringify({
        currentPassword,
        newPassword,
      }),
    });

    const currentSessionProfileResponse = await app.request(
      "/api/settings/profile",
      {
        headers: { cookie: newSessionCookie },
      },
    );
    const otherSessionProfileResponse = await app.request(
      "/api/settings/profile",
      {
        headers: { cookie: `pigeon_session=${otherSessionToken}` },
      },
    );

    const requestDeletionResponse = await app.request("/api/privacy/erase", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        cookie: newSessionCookie,
      },
      body: JSON.stringify({
        password: newPassword,
        confirm: "delete my account",
      }),
    });

    await runSchedulerTick(db);
    const jobsWhilePendingDeletion = await db.query`
      SELECT type, status
      FROM jobs
      WHERE payload->>'mailboxId' = ${mailboxId}
      ORDER BY id
    `;

    const cancelDeletionResponse = await app.request(
      "/api/privacy/erase/cancel",
      {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie: newSessionCookie,
        },
      },
    );

    await runSchedulerTick(db);
    const jobsAfterCancellation = await db.query`
      SELECT type, status
      FROM jobs
      WHERE payload->>'mailboxId' = ${mailboxId}
      ORDER BY id
    `;
    const userStateRows = await db.query`
      SELECT email, pending_email, deletion_requested_at
      FROM users
      WHERE id = ${userId}
    `;

    expect({
      requestEmailChangeStatus: requestEmailChangeResponse.status,
      sentMailCount: sentMail.length,
      confirmStatus: confirmResponse.status,
      oldEmailLoginStatus: oldEmailLoginResponse.status,
      newEmailLoginStatus: newEmailLoginResponse.status,
      changePasswordStatus: changePasswordResponse.status,
      currentSessionProfileStatus: currentSessionProfileResponse.status,
      otherSessionProfileStatus: otherSessionProfileResponse.status,
      requestDeletionStatus: requestDeletionResponse.status,
      jobsWhilePendingDeletion,
      cancelDeletionStatus: cancelDeletionResponse.status,
      jobsAfterCancellation,
      userState: {
        email: userStateRows[0]?.email ?? null,
        pendingEmail: userStateRows[0]?.pending_email ?? null,
        deletionRequestedAt:
          userStateRows[0]?.deletion_requested_at instanceof Date
            ? userStateRows[0].deletion_requested_at.toISOString()
            : (userStateRows[0]?.deletion_requested_at ?? null),
      },
      confirmBody: parseJsonOrText(await confirmResponse.text()),
      cancelDeletionBody: parseJsonOrText(await cancelDeletionResponse.text()),
    }).toEqual({
      requestEmailChangeStatus: 200,
      sentMailCount: 2,
      confirmStatus: 200,
      oldEmailLoginStatus: 401,
      newEmailLoginStatus: 200,
      changePasswordStatus: 200,
      currentSessionProfileStatus: 200,
      otherSessionProfileStatus: 401,
      requestDeletionStatus: 200,
      jobsWhilePendingDeletion: [],
      cancelDeletionStatus: 200,
      jobsAfterCancellation: [{ type: "sync_mailbox", status: "pending" }],
      userState: {
        email: newEmail,
        pendingEmail: null,
        deletionRequestedAt: null,
      },
      confirmBody: {
        profile: {
          name: "Account Owner",
          email: newEmail,
          tier: "free",
        },
      },
      cancelDeletionBody: { ok: true },
    });
  } finally {
    await close();
  }
});
