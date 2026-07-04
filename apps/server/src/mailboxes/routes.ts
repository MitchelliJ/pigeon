/** /api/mailboxes — connect-mailbox flow, listing, manual sync, disconnect. */
import { Hono } from "hono";
import { z } from "zod";
import {
  createMailbox,
  deleteMailbox,
  getProvider,
  listMailboxes,
  supportedProtocols,
  JOB_MAILBOX_SYNC,
  type Mailbox,
} from "@pigeon/mail";
import { canAddMailbox, tierLimits } from "@pigeon/quota";
import { enqueue } from "@pigeon/queue";
import type { AppEnv } from "../app.js";
import { requireAuth } from "../auth/middleware.js";

const createSchema = z.object({
  provider: z.enum(["gmail", "outlook", "icloud", "fastmail", "imap", "mock"]),
  protocol: z.string().refine((p) => supportedProtocols().includes(p), {
    message: "unsupported protocol",
  }),
  label: z.string().max(100).default(""),
  address: z.string().email().max(320),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  tls: z.boolean().default(true),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

/** Public shape — never includes credentials (not even sealed). */
export function sanitizeMailbox(mb: Mailbox) {
  return {
    id: mb.id,
    provider: mb.provider,
    protocol: mb.protocol,
    label: mb.label,
    address: mb.address,
    host: mb.host,
    port: mb.port,
    tls: mb.tls,
    username: mb.username,
    status: mb.status,
    statusDetail: mb.statusDetail,
    lastSyncedAt: mb.lastSyncedAt,
  };
}

export const mailboxRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/", async (c) => {
    const { pool } = c.get("deps");
    const mailboxes = await listMailboxes(pool, c.get("user").id);
    return c.json({ mailboxes: mailboxes.map(sanitizeMailbox) });
  })

  .post("/", async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: body.error.issues[0]?.message ?? "invalid input" }, 400);
    }
    const { pool, vault, logger } = c.get("deps");
    const user = c.get("user");
    const input = body.data;

    // Tier limit first ("quotas at the edge").
    if (!(await canAddMailbox(pool, user.id, user.tier))) {
      const limits = tierLimits(user.tier);
      return c.json(
        {
          error: `your ${limits.name} plan allows ${limits.maxMailboxes} mailbox${limits.maxMailboxes === 1 ? "" : "es"} — upgrade to connect more`,
          code: "quota_mailboxes",
        },
        403,
      );
    }

    // Test the connection BEFORE storing anything.
    try {
      await getProvider(input.protocol).testConnection({
        host: input.host,
        port: input.port,
        tls: input.tls,
        username: input.username,
        secret: input.password,
        address: input.address,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info("mailbox connection test failed", { user: user.id, error: message });
      return c.json({ error: `connection test failed: ${message}` }, 422);
    }

    const mailbox = await createMailbox(pool, vault, {
      userId: user.id,
      provider: input.provider,
      protocol: input.protocol,
      label: input.label,
      address: input.address,
      host: input.host,
      port: input.port,
      tls: input.tls,
      username: input.username,
      secret: input.password,
    });
    // Kick off the first sync immediately.
    await enqueue(pool, JOB_MAILBOX_SYNC, { mailboxId: mailbox.id }, {
      idempotencyKey: `${mailbox.id}:initial`,
    });
    return c.json({ mailbox: sanitizeMailbox(mailbox) }, 201);
  })

  .post("/:id/sync", async (c) => {
    const { pool } = c.get("deps");
    const user = c.get("user");
    const id = c.req.param("id");
    const owned = (await listMailboxes(pool, user.id)).some((m) => m.id === id);
    if (!owned) return c.json({ error: "not found" }, 404);
    await enqueue(pool, JOB_MAILBOX_SYNC, { mailboxId: id }, {
      idempotencyKey: `${id}:manual:${Math.floor(Date.now() / 10_000)}`,
    });
    return c.json({ ok: true }, 202);
  })

  .delete("/:id", async (c) => {
    const { pool } = c.get("deps");
    const deleted = await deleteMailbox(pool, c.get("user").id, c.req.param("id"));
    return deleted ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
