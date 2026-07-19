import { describe, expect, it } from "vitest";

import { withTestDb } from "../../../test/db";
import type { Db } from "../../db/index";
import { runMigrations } from "../../migrate/runner";
import { connectChannel, disconnectChannel, testChannel } from "../service";

async function insertUser(db: Db, email: string): Promise<string> {
  const rows = await db.query`
    INSERT INTO users(email, name, password_hash)
    VALUES (${email}, ${email}, 'not-a-real-hash')
    RETURNING id
  `;

  return String(rows[0]?.id);
}

function createFakeConnector(
  overrides: Partial<{
    validateConfig: (input: unknown) => unknown;
    sendTest: (config: unknown) => Promise<unknown>;
  }> = {},
) {
  return {
    kind: "discord" as const,
    validateConfig:
      overrides.validateConfig ??
      ((input: unknown) => {
        if (
          typeof input !== "object" ||
          input === null ||
          typeof (input as { webhookUrl?: unknown }).webhookUrl !== "string"
        ) {
          throw Object.assign(new Error("invalid config"), {
            code: "invalid_channel_config",
          });
        }
        return input;
      }),
    sendTest: overrides.sendTest ?? (async () => ({ ok: true as const })),
    send: async () => ({ ok: true as const }),
  };
}

function createFakeRegistry(connector = createFakeConnector()) {
  return {
    get: (kind: string) => (kind === connector.kind ? connector : undefined),
    supportedKinds: () => [connector.kind],
  };
}

const fakeVault = {
  seal: async (plaintext: string) =>
    `sealed:${Buffer.from(plaintext, "utf8").toString("base64")}`,
  open: async (ciphertext: string) =>
    Buffer.from(ciphertext.replace(/^sealed:/, ""), "base64").toString("utf8"),
};

async function channelCount(db: Db, userId: string): Promise<number> {
  const rows =
    await db.query`SELECT COUNT(*)::int AS count FROM channels WHERE user_id = ${userId}`;
  return Number(rows[0]?.count ?? 0);
}

describe("channel service", () => {
  it("creates no channel when the connection test fails", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "failed-connect@example.com");
      const registry = createFakeRegistry(
        createFakeConnector({
          sendTest: async () => ({
            ok: false,
            retryable: false,
            reason: "bad webhook",
          }),
        }),
      );

      await expect(
        connectChannel(
          db,
          userId,
          "discord",
          { webhookUrl: "https://discord.example/webhook" },
          registry,
          fakeVault,
        ),
      ).rejects.toMatchObject({ code: "channel_test_failed" });

      expect(await channelCount(db, userId)).toBe(0);
    } finally {
      await close();
    }
  });

  it("sends the connection test before save, seals config, and returns a redacted channel", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "connect-success@example.com");
      const events: string[] = [];
      const webhookUrl = "https://discord.example/plain-secret";
      const registry = createFakeRegistry(
        createFakeConnector({
          sendTest: async () => {
            expect(await channelCount(db, userId)).toBe(0);
            events.push("sendTest");
            return { ok: true };
          },
        }),
      );

      const channel = await connectChannel(
        db,
        userId,
        "discord",
        { webhookUrl },
        registry,
        fakeVault,
      );
      const rows =
        await db.query`SELECT config_encrypted FROM channels WHERE user_id = ${userId}`;

      expect(events).toContain("sendTest");
      expect(String(rows[0]?.config_encrypted)).not.toContain(webhookUrl);
      expect("webhookUrl" in channel).toBe(false);
      expect("config" in channel).toBe(false);
    } finally {
      await close();
    }
  });

  it("rejects a second connection for the same user", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "second-connect@example.com");
      const registry = createFakeRegistry();
      await connectChannel(
        db,
        userId,
        "discord",
        { webhookUrl: "https://discord.example/one" },
        registry,
        fakeVault,
      );

      await expect(
        connectChannel(
          db,
          userId,
          "discord",
          { webhookUrl: "https://discord.example/two" },
          registry,
          fakeVault,
        ),
      ).rejects.toMatchObject({ code: "channel_exists" });
    } finally {
      await close();
    }
  });

  it("disconnect deletes an owned channel and updates the delivery baseline", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "disconnect@example.com");
      const channel = await connectChannel(
        db,
        userId,
        "discord",
        { webhookUrl: "https://discord.example/delete" },
        createFakeRegistry(),
        fakeVault,
      );
      await db.query`INSERT INTO delivery_settings(user_id, delivery_baseline_at) VALUES (${userId}, ${new Date("2026-01-01T00:00:00Z")})`;

      await disconnectChannel(db, userId, channel.id);
      const rows =
        await db.query`SELECT delivery_baseline_at FROM delivery_settings WHERE user_id = ${userId}`;

      expect({
        count: await channelCount(db, userId),
        baseline: rows[0]?.delivery_baseline_at,
      }).toMatchObject({
        count: 0,
        baseline: expect.any(Date),
      });
    } finally {
      await close();
    }
  });

  it("test-again on an errored channel marks it active and clears last_error", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "test-again@example.com");
      const channel = await connectChannel(
        db,
        userId,
        "discord",
        { webhookUrl: "https://discord.example/retest" },
        createFakeRegistry(),
        fakeVault,
      );
      await db.query`UPDATE channels SET status = 'error', last_error = 'previous failure' WHERE id = ${channel.id}`;

      await testChannel(
        db,
        userId,
        channel.id,
        createFakeRegistry(),
        fakeVault,
      );
      const rows =
        await db.query`SELECT status, last_error FROM channels WHERE id = ${channel.id}`;

      expect(rows[0]).toMatchObject({ status: "active", last_error: null });
    } finally {
      await close();
    }
  });

  it("does not let another user test or disconnect an owned channel", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const ownerId = await insertUser(db, "owner@example.com");
      const otherId = await insertUser(db, "intruder@example.com");
      const channel = await connectChannel(
        db,
        ownerId,
        "discord",
        { webhookUrl: "https://discord.example/owned" },
        createFakeRegistry(),
        fakeVault,
      );

      await expect(
        testChannel(db, otherId, channel.id, createFakeRegistry(), fakeVault),
      ).rejects.toMatchObject({ code: "channel_not_found" });
      await expect(
        disconnectChannel(db, otherId, channel.id),
      ).rejects.toMatchObject({ code: "channel_not_found" });
      expect(await channelCount(db, ownerId)).toBe(1);
    } finally {
      await close();
    }
  });

  it("rejects invalid config and creates no channel", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "invalid-config@example.com");

      await expect(
        connectChannel(
          db,
          userId,
          "discord",
          { webhookUrl: 42 },
          createFakeRegistry(),
          fakeVault,
        ),
      ).rejects.toMatchObject({ code: "invalid_channel_config" });

      expect(await channelCount(db, userId)).toBe(0);
    } finally {
      await close();
    }
  });
});
