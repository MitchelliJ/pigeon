/**
 * /api/privacy — GDPR surfaces: consent records, data export (portability),
 * right to erasure, and the static privacy/sub-processor info.
 */
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@pigeon/db";
import { enqueue } from "@pigeon/queue";
import type { AppEnv } from "../app.js";
import { clearSessionCookie, requireAuth } from "../auth/middleware.js";
import { verifyPassword } from "../auth/hash.js";

export const JOB_GDPR_ERASE = "gdpr.erase";

/** What we tell users about where their data lives. */
const PRIVACY_INFO = {
  hosting: "Hetzner (EU, Germany/Finland) — application servers and database",
  subProcessors: [
    { name: "Hetzner Online GmbH", purpose: "EU hosting", location: "EU" },
    { name: "Mistral AI", purpose: "email summarization & classification", location: "EU (France)" },
    { name: "Mollie B.V.", purpose: "payment processing", location: "EU (Netherlands)" },
  ],
  retention: {
    emails: "90 days after ingestion, then deleted automatically",
    deliveries: "90 days",
    auditLog: "365 days",
    account: "until you delete it — erasure is immediate and irreversible",
  },
  dataMinimization:
    "Pigeon stores sender, subject, a truncated plain-text body, and the AI summary. Attachments are never fetched. Mailbox credentials are encrypted (AES-256-GCM) and never logged.",
};

const consentSchema = z.object({
  kind: z.enum(["terms", "privacy", "marketing"]),
  granted: z.boolean(),
  version: z.string().max(20).default("v1"),
});

const eraseSchema = z.object({
  password: z.string().min(1),
  confirm: z.literal("delete my account"),
});

export const privacyRoutes = new Hono<AppEnv>()
  .get("/info", (c) => c.json(PRIVACY_INFO))

  .use("*", requireAuth)

  .get("/consents", async (c) => {
    const { pool } = c.get("deps");
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (kind) kind, version, granted, created_at
       FROM consents WHERE user_id = $1
       ORDER BY kind, created_at DESC`,
      [c.get("user").id],
    );
    return c.json({ consents: rows });
  })

  .post("/consents", async (c) => {
    const body = consentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid consent" }, 400);
    const { pool } = c.get("deps");
    const user = c.get("user");
    await pool.query(
      "INSERT INTO consents (user_id, kind, version, granted) VALUES ($1,$2,$3,$4)",
      [user.id, body.data.kind, body.data.version, body.data.granted],
    );
    await audit(pool, {
      userId: user.id,
      actor: "user",
      action: "gdpr.consent",
      detail: { kind: body.data.kind, granted: body.data.granted },
    });
    return c.json({ ok: true }, 201);
  })

  // Data portability: everything we hold, one JSON document.
  .get("/export", async (c) => {
    const { pool } = c.get("deps");
    const user = c.get("user");
    const [mailboxes, emails, channels, settings, subscriptions, consents, deliveries, usage] =
      await Promise.all([
        pool.query(
          `SELECT id, provider, protocol, label, address, host, port, tls, username,
                  status, last_synced_at, created_at
           FROM mailboxes WHERE user_id = $1`,
          [user.id],
        ),
        pool.query(
          `SELECT id, mailbox_id, from_name, from_address, subject, body_text,
                  received_at, summary, priority, needs_attention, suggested_action
           FROM emails WHERE user_id = $1 ORDER BY received_at`,
          [user.id],
        ),
        pool.query(
          "SELECT id, kind, label, min_priority, enabled, created_at FROM channels WHERE user_id = $1",
          [user.id],
        ),
        pool.query("SELECT * FROM delivery_settings WHERE user_id = $1", [user.id]),
        pool.query(
          "SELECT tier, status, created_at, updated_at FROM subscriptions WHERE user_id = $1",
          [user.id],
        ),
        pool.query(
          "SELECT kind, version, granted, created_at FROM consents WHERE user_id = $1",
          [user.id],
        ),
        pool.query(
          "SELECT kind, status, created_at FROM deliveries WHERE user_id = $1",
          [user.id],
        ),
        pool.query("SELECT period, emails_processed FROM usage_counters WHERE user_id = $1", [
          user.id,
        ]),
      ]);

    await audit(pool, { userId: user.id, actor: "user", action: "gdpr.export" });
    c.header("content-disposition", `attachment; filename="pigeon-export-${user.id}.json"`);
    return c.json({
      exportedAt: new Date().toISOString(),
      user: { id: user.id, email: user.email, name: user.name, tier: user.tier },
      mailboxes: mailboxes.rows, // credentials are sealed and NOT exported
      emails: emails.rows,
      channels: channels.rows, // webhook configs are sealed and NOT exported
      deliverySettings: settings.rows[0] ?? null,
      subscriptions: subscriptions.rows,
      consents: consents.rows,
      deliveries: deliveries.rows,
      usage: usage.rows,
    });
  })

  // Right to erasure. Password + phrase confirm, then an async job wipes
  // everything (the users row cascades through every feature table).
  .post("/erase", async (c) => {
    const body = eraseSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(
        { error: 'confirmation requires your password and the phrase "delete my account"' },
        400,
      );
    }
    const { pool } = c.get("deps");
    const user = c.get("user");
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [user.id]);
    if (rows.length === 0 || !(await verifyPassword(body.data.password, rows[0].password_hash))) {
      return c.json({ error: "password incorrect" }, 403);
    }

    const request = await pool.query(
      "INSERT INTO erasure_requests (user_id) VALUES ($1) RETURNING id",
      [user.id],
    );
    await enqueue(pool, JOB_GDPR_ERASE, { userId: user.id, requestId: request.rows[0].id }, {
      idempotencyKey: `erase:${user.id}`,
    });
    // Kill every session immediately; the account dies within seconds.
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
    await audit(pool, { userId: user.id, actor: "user", action: "gdpr.erase.requested" });
    clearSessionCookie(c);
    return c.json({ ok: true, message: "your account and all data are being erased" }, 202);
  });
