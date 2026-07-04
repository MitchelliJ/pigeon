/** /api/channels + /api/settings/delivery — notification channel management. */
import { Hono } from "hono";
import { z } from "zod";
import {
  createChannel,
  deleteChannel,
  getChannel,
  getDeliverySettings,
  listChannels,
  openChannelConfig,
  sendToChannel,
  supportedChannelKinds,
  updateChannel,
  updateDeliverySettings,
  type Channel,
} from "@pigeon/deliver";
import type { AppEnv } from "../app.js";
import { requireAuth } from "../auth/middleware.js";

const prioritySchema = z.enum(["urgent", "important", "everything"]);

const createSchema = z.object({
  kind: z.enum(["discord", "whatsapp", "signal"]),
  label: z.string().max(100).default(""),
  config: z.record(z.string(), z.unknown()).default({}),
  minPriority: prioritySchema.default("urgent"),
});

const patchSchema = z.object({
  label: z.string().max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  minPriority: prioritySchema.optional(),
  enabled: z.boolean().optional(),
});

const settingsPatchSchema = z.object({
  digestEnabled: z.boolean().optional(),
  digestTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM").optional(),
  digestDays: z.array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])).min(1).optional(),
  digestChannelId: z.string().uuid().optional(),
  timezone: z.string().max(64).optional(),
  quietReassurance: z.boolean().optional(),
});

/** Public channel shape: sealed config reduced to a masked hint. */
function sanitizeChannel(channel: Channel, configHint: string) {
  return {
    id: channel.id,
    kind: channel.kind,
    label: channel.label,
    minPriority: channel.minPriority,
    enabled: channel.enabled,
    configHint,
  };
}

function maskConfig(config: Record<string, unknown>): string {
  const url = typeof config.webhookUrl === "string" ? config.webhookUrl : "";
  if (url) return `…${url.slice(-8)}`;
  const phone = typeof config.phoneNumber === "string" ? config.phoneNumber : "";
  if (phone) return `…${phone.slice(-4)}`;
  return "configured";
}

export const channelRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/", async (c) => {
    const { pool, vault } = c.get("deps");
    const channels = await listChannels(pool, c.get("user").id);
    return c.json({
      channels: channels.map((ch) => {
        let hint = "configured";
        try {
          hint = maskConfig(openChannelConfig(vault, ch));
        } catch {
          // unreadable config (rotated key) — still listable
        }
        return sanitizeChannel(ch, hint);
      }),
      supportedKinds: supportedChannelKinds(),
    });
  })

  .post("/", async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: body.error.issues[0]?.message ?? "invalid input" }, 400);
    }
    const { pool, vault } = c.get("deps");
    if (!supportedChannelKinds().includes(body.data.kind)) {
      return c.json({ error: `channel kind "${body.data.kind}" is not enabled on this server` }, 400);
    }
    try {
      const channel = await createChannel(pool, vault, {
        userId: c.get("user").id,
        kind: body.data.kind,
        label: body.data.label,
        config: body.data.config,
        minPriority: body.data.minPriority,
      });
      return c.json({ channel: sanitizeChannel(channel, maskConfig(body.data.config)) }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid config" }, 422);
    }
  })

  .patch("/:id", async (c) => {
    const body = patchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: body.error.issues[0]?.message ?? "invalid input" }, 400);
    }
    const { pool, vault } = c.get("deps");
    try {
      const channel = await updateChannel(pool, vault, c.get("user").id, c.req.param("id"), body.data);
      if (!channel) return c.json({ error: "not found" }, 404);
      const hint = maskConfig(openChannelConfig(vault, channel));
      return c.json({ channel: sanitizeChannel(channel, hint) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid config" }, 422);
    }
  })

  .delete("/:id", async (c) => {
    const { pool } = c.get("deps");
    const deleted = await deleteChannel(pool, c.get("user").id, c.req.param("id"));
    return deleted ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  })

  // "Send test message" button — synchronous so the user sees the result.
  .post("/:id/test", async (c) => {
    const { pool, vault } = c.get("deps");
    const user = c.get("user");
    const channel = await getChannel(pool, user.id, c.req.param("id"));
    if (!channel) return c.json({ error: "not found" }, 404);
    try {
      await sendToChannel(
        pool,
        vault,
        channel,
        {
          kind: "test",
          title: "Test flight",
          lines: [],
          footer: "This is Pigeon's test message — your channel is wired up correctly.",
        },
        `test:${channel.id}:${Date.now()}`,
      );
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "send failed" }, 502);
    }
  });

export const deliverySettingsRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/", async (c) => {
    const { pool } = c.get("deps");
    const settings = await getDeliverySettings(pool, c.get("user").id);
    return c.json({ settings });
  })

  .patch("/", async (c) => {
    const body = settingsPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: body.error.issues[0]?.message ?? "invalid input" }, 400);
    }
    const { pool } = c.get("deps");
    const user = c.get("user");
    if (body.data.digestChannelId) {
      const channel = await getChannel(pool, user.id, body.data.digestChannelId);
      if (!channel) return c.json({ error: "digest channel not found" }, 404);
    }
    const settings = await updateDeliverySettings(pool, user.id, body.data);
    return c.json({ settings });
  });
