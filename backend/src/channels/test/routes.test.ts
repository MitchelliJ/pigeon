/*
 * Route-level integration coverage for Feature 7 channel and delivery settings
 * APIs. External channel delivery and secret storage use deterministic fakes.
 * RED: `../routes` is intentionally absent until the GREEN implementation.
 */
import { describe, expect, it } from "vitest";

import { withTestDb } from "../../../test/db";
import { generateToken, hashToken } from "../../auth/tokens";
import type { Db } from "../../db/index";
import { runMigrations } from "../../migrate/runner";
import { channelRoutes } from "../routes";

const ORIGIN = "http://localhost:4321";
const WEBHOOK = "https://discord.com/api/webhooks/123/secret";
const JSON_HEADERS = { "content-type": "application/json", origin: ORIGIN };

function fakeConnector(ok = true) {
  return {
    kind: "discord" as const,
    validateConfig(input: unknown) {
      const webhookUrl = (input as { webhookUrl?: unknown } | null)?.webhookUrl;
      if (typeof webhookUrl !== "string") throw new Error("invalid config");
      return { webhookUrl };
    },
    sendTest: async () =>
      ok
        ? ({ ok: true } as const)
        : ({ ok: false, retryable: true, reason: "unavailable" } as const),
    send: async () => ({ ok: true }) as const,
  };
}

function fakeRegistry(ok = true) {
  const connector = fakeConnector(ok);
  return {
    supportedKinds: () => ["discord" as const],
    get: (kind: string) => (kind === "discord" ? connector : undefined),
  };
}

const fakeVault = {
  seal: async (value: string) =>
    `sealed:${Buffer.from(value, "utf8").toString("base64")}`,
  open: async (value: string) =>
    Buffer.from(value.replace(/^sealed:/, ""), "base64").toString("utf8"),
};

async function createSession(
  db: Db,
  email: string,
): Promise<{ userId: string; cookie: string }> {
  const users = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, 'Route Test', 'not-a-real-hash') RETURNING id
  `;
  const userId = String(users[0]?.id);
  const token = generateToken();
  await db.query`
    INSERT INTO sessions(user_id, token_hash, expires_at)
    VALUES (${userId}, ${hashToken(token)}, now() + interval '1 day')
  `;
  return { userId, cookie: `pigeon_session=${token}` };
}

async function harness(ok = true) {
  const testDb = await withTestDb();
  await runMigrations(testDb.db);
  return {
    ...testDb,
    app: channelRoutes(testDb.db, fakeRegistry(ok), fakeVault),
  };
}

function connectInit(cookie: string, body: unknown = validChannelBody()) {
  return {
    method: "POST",
    headers: { ...JSON_HEADERS, cookie },
    body: JSON.stringify(body),
  };
}

function validChannelBody() {
  return { kind: "discord", config: { webhookUrl: WEBHOOK } };
}

async function connect(app: ReturnType<typeof channelRoutes>, cookie: string) {
  const response = await app.request("/api/channels", connectInit(cookie));
  return (await response.json()) as { channel: { id: string } };
}

describe("channel routes", () => {
  it("requires authentication for GET /api/channels", async () => {
    const { app, close } = await harness();
    try {
      expect((await app.request("/api/channels")).status).toBe(401);
    } finally {
      await close();
    }
  });

  it("returns no channel and the supported Discord kind for a new user", async () => {
    const { db, app, close } = await harness();
    try {
      const { cookie } = await createSession(db, "empty@example.com");
      const response = await app.request("/api/channels", {
        headers: { cookie },
      });
      expect(await response.json()).toEqual({
        channel: null,
        supportedKinds: ["discord"],
      });
    } finally {
      await close();
    }
  });

  it("connects with the fake connector and returns only redacted channel metadata", async () => {
    const { db, app, close } = await harness();
    try {
      const { cookie } = await createSession(db, "connect@example.com");
      const response = await app.request("/api/channels", connectInit(cookie));
      const body = (await response.json()) as Record<string, unknown>;
      expect({
        status: response.status,
        body,
        serialized: JSON.stringify(body),
      }).toMatchObject({
        status: 201,
        body: {
          channel: { kind: "discord", status: "active", lastError: null },
        },
        serialized: expect.not.stringContaining(WEBHOOK),
      });
      expect(JSON.stringify(body)).not.toContain("config");
    } finally {
      await close();
    }
  });

  it("requires auth and same-origin CSRF for POST /api/channels", async () => {
    const { db, app, close } = await harness();
    try {
      const { cookie } = await createSession(db, "csrf-connect@example.com");
      const unauthenticated = await app.request(
        "/api/channels",
        connectInit(""),
      );
      const crossOrigin = await app.request("/api/channels", {
        ...connectInit(cookie),
        headers: {
          "content-type": "application/json",
          cookie,
          origin: "https://evil.test",
        },
      });
      expect([unauthenticated.status, crossOrigin.status]).toEqual([401, 403]);
    } finally {
      await close();
    }
  });

  it("validates channel bodies and rejects oversized declared bodies", async () => {
    const { db, app, close } = await harness();
    try {
      const { cookie } = await createSession(db, "body@example.com");
      const invalid = await app.request(
        "/api/channels",
        connectInit(cookie, { kind: "discord", config: {} }),
      );
      const oversized = await app.request("/api/channels", {
        ...connectInit(cookie),
        headers: { ...JSON_HEADERS, cookie, "content-length": "65537" },
      });
      expect([
        invalid.status,
        ((await invalid.json()) as { code: string }).code,
        oversized.status,
      ]).toEqual([400, "invalid_channel_config", 413]);
    } finally {
      await close();
    }
  });

  it("maps a second channel to 409 channel_exists", async () => {
    const { db, app, close } = await harness();
    try {
      const { cookie } = await createSession(db, "duplicate@example.com");
      await app.request("/api/channels", connectInit(cookie));
      const response = await app.request("/api/channels", connectInit(cookie));
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 409,
        body: expect.objectContaining({ code: "channel_exists" }),
      });
    } finally {
      await close();
    }
  });

  it("maps a failed connector test to 502 channel_test_failed", async () => {
    const { db, app, close } = await harness(false);
    try {
      const { cookie } = await createSession(db, "failure@example.com");
      const response = await app.request("/api/channels", connectInit(cookie));
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 502,
        body: expect.objectContaining({ code: "channel_test_failed" }),
      });
    } finally {
      await close();
    }
  });

  it("retests an owned channel with auth and CSRF, but hides it from another user", async () => {
    const { db, app, close } = await harness();
    try {
      const owner = await createSession(db, "test-owner@example.com");
      const other = await createSession(db, "test-other@example.com");
      const { channel } = await connect(app, owner.cookie);
      const unauth = await app.request(`/api/channels/${channel.id}/test`, {
        method: "POST",
      });
      const crossOrigin = await app.request(
        `/api/channels/${channel.id}/test`,
        {
          method: "POST",
          headers: { cookie: owner.cookie, origin: "https://evil.test" },
        },
      );
      const foreign = await app.request(`/api/channels/${channel.id}/test`, {
        method: "POST",
        headers: { cookie: other.cookie, origin: ORIGIN },
      });
      const success = await app.request(`/api/channels/${channel.id}/test`, {
        method: "POST",
        headers: { cookie: owner.cookie, origin: ORIGIN },
      });
      expect([
        unauth.status,
        crossOrigin.status,
        foreign.status,
        success.status,
      ]).toEqual([401, 403, 404, 200]);
    } finally {
      await close();
    }
  });

  it("deletes only an owned channel with authenticated same-origin CSRF", async () => {
    const { db, app, close } = await harness();
    try {
      const owner = await createSession(db, "delete-owner@example.com");
      const other = await createSession(db, "delete-other@example.com");
      const { channel } = await connect(app, owner.cookie);
      const foreign = await app.request(`/api/channels/${channel.id}`, {
        method: "DELETE",
        headers: { cookie: other.cookie, origin: ORIGIN },
      });
      const crossOrigin = await app.request(`/api/channels/${channel.id}`, {
        method: "DELETE",
        headers: { cookie: owner.cookie, origin: "https://evil.test" },
      });
      const success = await app.request(`/api/channels/${channel.id}`, {
        method: "DELETE",
        headers: { cookie: owner.cookie, origin: ORIGIN },
      });
      expect([
        foreign.status,
        crossOrigin.status,
        success.status,
        await success.json(),
      ]).toEqual([404, 403, 200, { ok: true }]);
    } finally {
      await close();
    }
  });
});

describe("delivery settings routes", () => {
  it("requires auth and returns UTC defaults", async () => {
    const { db, app, close } = await harness();
    try {
      const { cookie } = await createSession(db, "settings@example.com");
      const unauthenticated = await app.request("/api/settings/delivery");
      const response = await app.request("/api/settings/delivery", {
        headers: { cookie },
      });
      expect({
        unauthenticated: unauthenticated.status,
        status: response.status,
        body: await response.json(),
      }).toEqual({
        unauthenticated: 401,
        status: 200,
        body: {
          settings: expect.objectContaining({
            mode: "daily",
            digestTime: "08:00",
            timezone: "UTC",
          }),
        },
      });
    } finally {
      await close();
    }
  });

  it("requires auth and same-origin CSRF for delivery settings updates", async () => {
    const { db, app, close } = await harness();
    try {
      const { cookie } = await createSession(db, "settings-csrf@example.com");
      const init = {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ mode: "quiet" }),
      };
      const unauthenticated = await app.request("/api/settings/delivery", init);
      const crossOrigin = await app.request("/api/settings/delivery", {
        ...init,
        headers: { ...JSON_HEADERS, cookie, origin: "https://evil.test" },
      });
      expect([unauthenticated.status, crossOrigin.status]).toEqual([401, 403]);
    } finally {
      await close();
    }
  });

  it("validates delivery patches and returns a successful UTC update", async () => {
    const { db, app, close } = await harness();
    try {
      const { cookie } = await createSession(db, "settings-update@example.com");
      const invalid = await app.request("/api/settings/delivery", {
        method: "PATCH",
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ mode: "weekly", digestDays: [] }),
      });
      const success = await app.request("/api/settings/delivery", {
        method: "PATCH",
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({
          mode: "quiet",
          digestTime: "09:30",
          digestDays: [1, 3, 5],
        }),
      });
      expect({
        invalid: [
          invalid.status,
          ((await invalid.json()) as { code: string }).code,
        ],
        success: [success.status, await success.json()],
      }).toEqual({
        invalid: [400, "invalid_delivery_settings"],
        success: [
          200,
          {
            settings: expect.objectContaining({
              mode: "quiet",
              digestTime: "09:30",
              digestDays: [1, 3, 5],
              timezone: "UTC",
            }),
          },
        ],
      });
    } finally {
      await close();
    }
  });
});
