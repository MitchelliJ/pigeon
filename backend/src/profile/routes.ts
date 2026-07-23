/* Authenticated profile settings routes. */
import { Hono } from "hono";
import { z } from "zod";

import { csrfGuard, requireAuth } from "../auth/middleware";
import { isAcceptablePassword } from "../auth/password";
import {
  changePassword,
  confirmEmailChange,
  requestEmailChange,
  verifyCurrentPassword,
} from "../auth/service";
import { bodyLimit, rateLimit } from "../http/limits";
import { getDeletionSchedule } from "./deletion";
import type { Context } from "hono";
import type { AuthVariables } from "../auth/middleware";
import type { Db } from "../db/index";
import type { MailSender } from "../mail/index";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_APP_BASE_URL = "http://localhost:4321";

const profilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
  })
  .strict();

const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().refine(isAcceptablePassword, {
      message: "password does not meet the strength requirements",
    }),
  })
  .strict();

const emailChangeSchema = z
  .object({
    currentPassword: z.string().min(1),
    newEmail: z.string().trim().email(),
  })
  .strict();

const emailChangeConfirmSchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();

const eraseAccountSchema = z
  .object({
    password: z.string().min(1),
    confirm: z.string().min(1),
  })
  .strict();

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function profileFromRow(row: {
  name?: unknown;
  email?: unknown;
  tier?: unknown;
  deletion_requested_at?: unknown;
}): {
  name: string;
  email: string;
  tier: string;
  deletionRequestedAt: string | null;
  deletesAt: string | null;
} {
  const { requestedAt: deletionRequestedAt, deletesAt } = getDeletionSchedule(
    row.deletion_requested_at as Date | string | null | undefined,
  );

  return {
    name: String(row.name),
    email: String(row.email),
    tier: String(row.tier),
    deletionRequestedAt,
    deletesAt,
  };
}

/** Build the authenticated profile settings router. */
export function profileRoutes(
  db: Db,
  mail: MailSender,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const auth = requireAuth(db);
  const csrf = csrfGuard(process.env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL);
  const reauthRateLimit = rateLimit({ max: 10, windowMs: 60_000 });

  app.get("/api/settings/profile", auth, async (c) => {
    const rows = await db.query`
      SELECT name, email, tier, deletion_requested_at
      FROM users
      WHERE id = ${c.get("sessionUser").id}
    `;
    const row = rows[0];
    if (!row) {
      return c.json({ error: "profile not found", code: "not_found" }, 404);
    }

    return c.json({ profile: profileFromRow(row) }, 200);
  });

  app.patch(
    "/api/settings/profile",
    bodyLimit(MAX_BODY_BYTES),
    csrf,
    auth,
    async (c) => {
      const body = await readJsonBody(c);
      if (body === undefined) {
        return c.json(
          { error: "request body must be JSON", code: "invalid_body" },
          400,
        );
      }

      const parsed = profilePatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: "name must be between 1 and 100 characters",
            code: "invalid_input",
          },
          400,
        );
      }

      const rows = await db.query`
        UPDATE users
        SET name = ${parsed.data.name}, updated_at = now()
        WHERE id = ${c.get("sessionUser").id}
        RETURNING name, email, tier, deletion_requested_at
      `;
      const row = rows[0];
      if (!row) {
        return c.json({ error: "profile not found", code: "not_found" }, 404);
      }

      return c.json({ profile: profileFromRow(row) }, 200);
    },
  );

  app.post(
    "/api/settings/password",
    bodyLimit(MAX_BODY_BYTES),
    csrf,
    auth,
    reauthRateLimit,
    async (c) => {
      const body = await readJsonBody(c);
      if (body === undefined) {
        return c.json(
          { error: "request body must be JSON", code: "invalid_body" },
          400,
        );
      }

      const parsed = passwordChangeSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: "currentPassword and newPassword are required",
            code: "invalid_input",
          },
          400,
        );
      }

      const result = await changePassword(
        db,
        c.get("sessionUser").id,
        parsed.data.currentPassword,
        parsed.data.newPassword,
        c.get("sessionTokenHash"),
      );

      switch (result.kind) {
        case "changed":
          return c.json({ ok: true }, 200);
        case "bad_credentials":
          return c.json(
            {
              error: "email or password is incorrect",
              code: "bad_credentials",
            },
            401,
          );
      }
    },
  );

  app.post(
    "/api/settings/email",
    bodyLimit(MAX_BODY_BYTES),
    csrf,
    auth,
    reauthRateLimit,
    async (c) => {
      const body = await readJsonBody(c);
      if (body === undefined) {
        return c.json(
          { error: "request body must be JSON", code: "invalid_body" },
          400,
        );
      }

      const parsed = emailChangeSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: "currentPassword and newEmail are required",
            code: "invalid_input",
          },
          400,
        );
      }

      const result = await verifyCurrentPassword(
        db,
        c.get("sessionUser").id,
        parsed.data.currentPassword,
      );
      if (result.kind === "bad_credentials") {
        return c.json(
          {
            error: "email or password is incorrect",
            code: "bad_credentials",
          },
          401,
        );
      }

      await requestEmailChange(
        db,
        mail,
        { APP_BASE_URL: process.env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL },
        c.get("sessionUser").id,
        parsed.data.newEmail,
      );

      return c.json({ ok: true }, 200);
    },
  );

  app.post(
    "/api/settings/email/confirm",
    bodyLimit(MAX_BODY_BYTES),
    csrf,
    async (c) => {
      const body = await readJsonBody(c);
      if (body === undefined) {
        return c.json(
          { error: "request body must be JSON", code: "invalid_body" },
          400,
        );
      }

      const parsed = emailChangeConfirmSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: "token is required",
            code: "invalid_input",
          },
          400,
        );
      }

      const result = await confirmEmailChange(db, parsed.data.token);
      switch (result.kind) {
        case "confirmed":
          return c.json({ profile: result.profile }, 200);
        case "invalid_or_expired_token":
          return c.json(
            {
              error: "token is invalid or expired",
              code: "invalid_or_expired_token",
            },
            400,
          );
        case "email_taken":
          return c.json(
            {
              error: "email is already in use",
              code: "email_taken",
            },
            409,
          );
      }
    },
  );

  app.post("/api/privacy/erase/cancel", csrf, auth, async (c) => {
    const userId = c.get("sessionUser").id;
    const outcome = await db.withTx(async (tx) => {
      const rows = await tx`
        SELECT deletion_requested_at
        FROM users
        WHERE id = ${userId}
        FOR UPDATE
      `;
      const user = rows[0];
      if (!user) {
        return "not_found" as const;
      }

      if (user.deletion_requested_at === null) {
        return "cleared" as const;
      }

      const dueRows = await tx`
        SELECT ${user.deletion_requested_at} + interval '24 hours' <= now() AS deletion_due
      `;
      if (dueRows[0]?.deletion_due === true) {
        return "deletion_due" as const;
      }

      await tx`
        UPDATE users
        SET deletion_requested_at = NULL
        WHERE id = ${userId}
      `;

      return "cleared" as const;
    });

    if (outcome === "not_found") {
      return c.json({ error: "profile not found", code: "not_found" }, 404);
    }

    if (outcome === "deletion_due") {
      return c.json(
        {
          error: "account deletion is already due",
          code: "deletion_due",
        },
        409,
      );
    }

    return c.json({ ok: true }, 200);
  });

  app.post(
    "/api/privacy/erase",
    bodyLimit(MAX_BODY_BYTES),
    csrf,
    auth,
    reauthRateLimit,
    async (c) => {
      const body = await readJsonBody(c);
      if (body === undefined) {
        return c.json(
          { error: "request body must be JSON", code: "invalid_body" },
          400,
        );
      }

      const parsed = eraseAccountSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            error: "password and confirm are required",
            code: "invalid_input",
          },
          400,
        );
      }

      const result = await verifyCurrentPassword(
        db,
        c.get("sessionUser").id,
        parsed.data.password,
      );
      if (result.kind === "bad_credentials") {
        return c.json(
          {
            error: "email or password is incorrect",
            code: "bad_credentials",
          },
          401,
        );
      }

      if (parsed.data.confirm !== "delete my account") {
        return c.json(
          {
            error: "confirmation must exactly match delete my account",
            code: "invalid_input",
          },
          400,
        );
      }

      const rows = await db.query`
        UPDATE users
        SET deletion_requested_at = COALESCE(deletion_requested_at, now())
        WHERE id = ${c.get("sessionUser").id}
        RETURNING deletion_requested_at
      `;
      const { requestedAt, deletesAt } = getDeletionSchedule(
        rows[0]?.deletion_requested_at,
      );
      if (requestedAt === null || deletesAt === null) {
        return c.json({ error: "profile not found", code: "not_found" }, 404);
      }

      return c.json({ ok: true, requestedAt, deletesAt }, 200);
    },
  );

  return app;
}
