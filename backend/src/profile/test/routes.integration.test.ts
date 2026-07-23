/*
 * Integration coverage for the authenticated profile settings API through the
 * real application router and database.
 */
import { expect, it } from "vitest";

import { withTestDb } from "../../../test/db";
import { generateToken, hashToken } from "../../auth/tokens";
import { runMigrations } from "../../migrate/runner";
import { createApp } from "../../server";
import type { MailSender } from "../../mail/index";
import type { Vault } from "../../vault/index";

const EMAIL = "profile-settings@example.com";
const PENDING_EMAIL = "pending-profile-settings@example.com";

const fakeMail: MailSender = {
  name: "profile-test",
  send: async () => ({ ok: true }),
};

const fakeVault: Vault = {
  seal: (value) => value,
  open: (value) => value,
};

it("GET /api/settings/profile exposes only the public profile fields plus deletion status for the authenticated user", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);
    const users = await db.query`
      INSERT INTO users(email, pending_email, name, password_hash, tier)
      VALUES (${EMAIL}, ${PENDING_EMAIL}, 'Original Name', 'not-a-real-hash', 'pro')
      RETURNING id
    `;
    const userId = String(users[0]?.id);
    const token = generateToken();
    await db.query`
      INSERT INTO sessions(user_id, token_hash, expires_at)
      VALUES (${userId}, ${hashToken(token)}, now() + interval '1 day')
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const cookie = `pigeon_session=${token}`;
    const beforeDeletion = await app.request("/api/settings/profile", {
      headers: { cookie },
    });

    const deletionRequestedAt = new Date("2026-07-01T12:34:56.789Z");
    const deletesAt = new Date(
      deletionRequestedAt.getTime() + 24 * 60 * 60 * 1000,
    );
    await db.query`
      UPDATE users
      SET deletion_requested_at = ${deletionRequestedAt}
      WHERE id = ${userId}
    `;

    const afterDeletion = await app.request("/api/settings/profile", {
      headers: { cookie },
    });

    expect({
      beforeDeletion: {
        status: beforeDeletion.status,
        body: await beforeDeletion.json(),
      },
      afterDeletion: {
        status: afterDeletion.status,
        body: await afterDeletion.json(),
      },
    }).toEqual({
      beforeDeletion: {
        status: 200,
        body: {
          profile: {
            name: "Original Name",
            email: EMAIL,
            tier: "pro",
            deletionRequestedAt: null,
            deletesAt: null,
          },
        },
      },
      afterDeletion: {
        status: 200,
        body: {
          profile: {
            name: "Original Name",
            email: EMAIL,
            tier: "pro",
            deletionRequestedAt: deletionRequestedAt.toISOString(),
            deletesAt: deletesAt.toISOString(),
          },
        },
      },
    });
  } finally {
    await close();
  }
});
