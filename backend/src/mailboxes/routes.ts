/*
 * Mailbox HTTP routes (Inbox Connectors & Provider Abstraction PRD
 * §3.2.3/§3.2.4, FR-6..FR-9; §3.5 FR-20).
 *
 * `mailboxesRoutes(db, vault, getConnectorFn)` mounts `POST /api/mailboxes`
 * and `DELETE /api/mailboxes/:id`, both behind `requireAuth(db)` (same guard
 * `../auth/middleware` uses everywhere else). Handlers stay thin: validate
 * the body with Zod, delegate to `./service`, then shape the HTTP response
 * from the result `kind` — same pattern as `../auth/routes`. `getConnectorFn`
 * defaults to `../connectors`'s real `getConnector` but is overridable so
 * tests can inject a fake `MailboxConnector` and never touch a real socket
 * (FR-20).
 */
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { bodyLimit } from "../http/limits";
import { getConnector } from "./connectors/index";
import { connectMailbox, removeMailbox } from "./service";
import type { Context } from "hono";
import type { AuthVariables } from "../auth/middleware";
import type { Db } from "../db/index";
import type { Vault } from "../vault/index";
import type { MailboxConnector } from "./connectors/types";

/**
 * `POST /api/mailboxes` request shape (FR-6). `tls` must be the literal
 * `true` — TLS is mandatory, never a caller-chosen option — and `provider`
 * deliberately excludes `"mock"`: that value only ever exists as a seeded
 * dev/demo row, never as something a caller connects through this route.
 */
const connectMailboxSchema = z.object({
  provider: z.enum(["gmail", "outlook", "icloud", "fastmail", "imap"]),
  protocol: z.enum(["imap", "pop3"]),
  label: z.string().trim().min(1).max(200),
  address: z.string().trim().email(),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.literal(true),
  username: z.string().min(1),
  password: z.string().min(1),
});

/** Same "invalid JSON body" parse used by `../auth/routes`. */
async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * Turn a failed `connectMailboxSchema` parse into the right `{ error, code }`
 * body. `provider` and `tls` get their own codes (the test suite asserts on
 * them specifically); every other field failure is a generic 400.
 */
function invalidMailboxBody(error: z.ZodError): {
  error: string;
  code: string;
} {
  const firstIssue = error.issues[0];
  if (firstIssue?.path[0] === "provider") {
    return {
      error: "provider is not supported",
      code: "provider_not_supported",
    };
  }
  if (firstIssue?.path[0] === "tls") {
    return { error: "TLS is required", code: "tls_required" };
  }
  return {
    error: firstIssue?.message ?? "invalid mailbox request",
    code: "invalid_input",
  };
}

/** Mount the mailbox routes onto a fresh Hono app bound to `db`/`vault`. */
export function mailboxesRoutes(
  db: Db,
  vault: Vault,
  getConnectorFn: (
    protocol: "imap" | "pop3",
  ) => MailboxConnector = getConnector,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // Cap request bodies (the connect payload is small JSON) before parsing.
  app.use("*", bodyLimit(64 * 1024));

  app.post("/api/mailboxes", requireAuth(db), async (c) => {
    const body = await readJsonBody(c);
    if (body === undefined) {
      return c.json(
        { error: "request body must be JSON", code: "invalid_body" },
        400,
      );
    }

    const parsed = connectMailboxSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(invalidMailboxBody(parsed.error), 400);
    }

    const connector = getConnectorFn(parsed.data.protocol);
    const sessionUser = c.get("sessionUser");
    const result = await connectMailbox(
      db,
      vault,
      connector,
      sessionUser.id,
      parsed.data,
    );

    switch (result.kind) {
      case "created":
        return c.json({ mailbox: { ...result.mailbox, unread: 0 } }, 201);
      case "duplicate":
        return c.json(
          {
            error: "mailbox already connected",
            code: "mailbox_already_connected",
          },
          409,
        );
      case "connection_failed":
        return c.json({ error: result.reason, code: "connection_failed" }, 422);
    }
  });

  app.delete("/api/mailboxes/:id", requireAuth(db), async (c) => {
    const sessionUser = c.get("sessionUser");
    const mailboxId = c.req.param("id");
    const result = await removeMailbox(db, sessionUser.id, mailboxId);

    if (!result.removed) {
      return c.json({ error: "not found", code: "not_found" }, 404);
    }
    return c.json({ ok: true }, 200);
  });

  return app;
}
