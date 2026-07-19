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

const ORIGIN = "http://localhost:4321";
const EMAIL = "profile-settings@example.com";

const fakeMail: MailSender = {
  name: "profile-test",
  send: async () => ({ ok: true }),
};

const fakeVault: Vault = {
  seal: (value) => value,
  open: (value) => value,
};

it("reads, validates, updates, and persists only the authenticated user's profile", async () => {
  const { db, close } = await withTestDb();
  try {
    await runMigrations(db);
    const users = await db.query`
      INSERT INTO users(email, name, password_hash, tier)
      VALUES (${EMAIL}, 'Original Name', 'not-a-real-hash', 'pro')
      RETURNING id
    `;
    const token = generateToken();
    await db.query`
      INSERT INTO sessions(user_id, token_hash, expires_at)
      VALUES (${String(users[0]?.id)}, ${hashToken(token)}, now() + interval '1 day')
    `;

    const app = createApp(db, fakeMail, fakeVault);
    const cookie = `pigeon_session=${token}`;
    const unauthenticated = await app.request("/api/settings/profile");
    const initial = await app.request("/api/settings/profile", {
      headers: { cookie },
    });
    const invalid = await app.request("/api/settings/profile", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie,
      },
      body: JSON.stringify({ name: "   " }),
    });
    const updated = await app.request("/api/settings/profile", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie,
      },
      body: JSON.stringify({ name: "  Updated Name  " }),
    });
    const persisted = await app.request("/api/settings/profile", {
      headers: { cookie },
    });

    expect([
      unauthenticated.status,
      initial.status,
      invalid.status,
      updated.status,
      persisted.status,
    ]).toEqual([401, 200, 400, 200, 200]);
    expect([
      await initial.json(),
      await updated.json(),
      await persisted.json(),
    ]).toEqual([
      {
        profile: { name: "Original Name", email: EMAIL, tier: "pro" },
      },
      {
        profile: { name: "Updated Name", email: EMAIL, tier: "pro" },
      },
      {
        profile: { name: "Updated Name", email: EMAIL, tier: "pro" },
      },
    ]);
  } finally {
    await close();
  }
});
