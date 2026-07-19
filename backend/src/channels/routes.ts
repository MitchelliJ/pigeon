/*
 * Authenticated HTTP routes for channel connection and UTC delivery settings.
 * Handlers validate bounded input, delegate lifecycle work to the channel
 * service/store, and expose only redacted channel metadata.
 */
import { Hono } from "hono";
import { z } from "zod";

import { csrfGuard, requireAuth } from "../auth/middleware";
import { bodyLimit } from "../http/limits";
import {
  ChannelServiceError,
  connectChannel,
  disconnectChannel,
  testChannel,
  updateDeliverySettings,
} from "./service";
import { getChannel, getDeliverySettings } from "./store";
import type { ChannelKind } from "@pigeon/shared";
import type { Context } from "hono";
import type { AuthVariables } from "../auth/middleware";
import type { Db } from "../db/index";
import type { DeliverySettings } from "./store";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_APP_BASE_URL = "http://localhost:4321";

interface ChannelRegistryLike {
  supportedKinds(): ChannelKind[];
  get(kind: string): unknown;
}

interface VaultLike {
  seal(plaintext: string): string | Promise<string>;
  open(sealed: string): string | Promise<string>;
}

const connectChannelSchema = z
  .object({
    kind: z.literal("discord"),
    config: z.unknown(),
  })
  .strict();

const deliverySettingsPatchSchema = z
  .object({
    mode: z.enum(["daily", "quiet"]).optional(),
    digestTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    digestDays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .refine((days) => new Set(days).size === days.length)
      .optional(),
  })
  .strict();

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function publicSettings(settings: DeliverySettings): {
  mode: DeliverySettings["mode"];
  digestTime: string;
  digestDays: number[];
  timezone: "UTC";
} {
  return {
    mode: settings.mode,
    digestTime: settings.digestTime,
    digestDays: settings.digestDays,
    timezone: settings.timezone,
  };
}

/** Build the Feature 7 channel/settings router with injectable connectors. */
export function channelRoutes(
  db: Db,
  registry: ChannelRegistryLike,
  vault: VaultLike,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const csrf = csrfGuard(process.env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL);
  const auth = requireAuth(db);

  app.use("*", bodyLimit(MAX_BODY_BYTES));

  app.onError((error, c) => {
    if (!(error instanceof ChannelServiceError)) {
      throw error;
    }

    switch (error.code) {
      case "channel_exists":
        return c.json(
          { error: "a channel is already connected", code: error.code },
          409,
        );
      case "invalid_channel_config":
        return c.json(
          { error: "invalid channel configuration", code: error.code },
          400,
        );
      case "channel_test_failed":
        return c.json({ error: "channel test failed", code: error.code }, 502);
      case "channel_not_found":
        return c.json({ error: "channel not found", code: error.code }, 404);
      case "invalid_delivery_settings":
        return c.json(
          { error: "invalid delivery settings", code: error.code },
          400,
        );
    }
  });

  app.get("/api/channels", auth, async (c) => {
    const userId = c.get("sessionUser").id;
    const channel = await getChannel(db, userId);
    return c.json({ channel, supportedKinds: registry.supportedKinds() }, 200);
  });

  app.post("/api/channels", auth, csrf, async (c) => {
    const body = await readJsonBody(c);
    if (body === undefined) {
      return c.json(
        { error: "request body must be JSON", code: "invalid_body" },
        400,
      );
    }

    const parsed = connectChannelSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid channel configuration",
          code: "invalid_channel_config",
        },
        400,
      );
    }

    const channel = await connectChannel(
      db,
      c.get("sessionUser").id,
      parsed.data.kind,
      parsed.data.config,
      registry,
      vault,
    );
    return c.json({ channel }, 201);
  });

  app.post("/api/channels/:id/test", auth, csrf, async (c) => {
    const channel = await testChannel(
      db,
      c.get("sessionUser").id,
      c.req.param("id"),
      registry,
      vault,
    );
    return c.json({ channel }, 200);
  });

  app.delete("/api/channels/:id", auth, csrf, async (c) => {
    await disconnectChannel(db, c.get("sessionUser").id, c.req.param("id"));
    return c.json({ ok: true }, 200);
  });

  app.get("/api/settings/delivery", auth, async (c) => {
    const settings = await getDeliverySettings(db, c.get("sessionUser").id);
    return c.json({ settings: publicSettings(settings) }, 200);
  });

  app.patch("/api/settings/delivery", auth, csrf, async (c) => {
    const body = await readJsonBody(c);
    if (body === undefined) {
      return c.json(
        { error: "request body must be JSON", code: "invalid_body" },
        400,
      );
    }

    const parsed = deliverySettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid delivery settings",
          code: "invalid_delivery_settings",
        },
        400,
      );
    }

    const settings = await updateDeliverySettings(
      db,
      c.get("sessionUser").id,
      parsed.data,
    );
    return c.json({ settings: publicSettings(settings) }, 200);
  });

  return app;
}
