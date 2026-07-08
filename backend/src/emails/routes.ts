/*
 * Emails read route (LLM Processing — Summarize + Classify PRD §3.4,
 * FR-13/FR-23).
 *
 * `emailsRoutes(db)` mounts `GET /api/emails` behind `requireAuth(db)` and
 * serves the paginated, per-category triage inbox the frontend renders. It is
 * a thin transport wrapper over `loadEmailPage`: it validates the query params
 * and hands off to the service, which owns the actual SQL and keyset cursor.
 *
 * `category` is required and must be one of the three known buckets — a missing
 * or unknown value is a `400 { error, code: "invalid_category" }`, never a
 * silent empty page, so a typo surfaces loudly instead of looking like "no
 * mail". `cursor` is an opaque token passed straight through to the service.
 * `limit` defaults to 10 and is CLAMPED to a max of 50 rather than rejected
 * (FR-13): an over-max request is a valid request for "as much as we allow",
 * not an error, so callers can ask for "lots" without knowing the exact cap.
 */
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import { InvalidCursorError, loadEmailPage } from "./service";
import type { AuthVariables } from "../auth/middleware";
import type { Db } from "../db/index";
import type { Category } from "@pigeon/shared";

/** The three triage buckets a caller may page through. */
const CATEGORIES: readonly Category[] = [
  "requires_action",
  "important",
  "noise",
];

/** Default page size when `limit` is omitted, and the hard cap it clamps to. */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** Narrow an arbitrary query value to a known `Category`, or `undefined`. */
function parseCategory(value: string | undefined): Category | undefined {
  return CATEGORIES.find((category) => category === value);
}

/**
 * Parse the optional `limit` query param: default when absent or unparseable,
 * clamped into `[1, MAX_LIMIT]` so an over-max value is accepted (FR-13), not
 * rejected, and a zero/negative value can never produce an empty-forever page.
 */
function parseLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

/** Mount `GET /api/emails` onto a fresh Hono app bound to `db`. */
export function emailsRoutes(db: Db): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/api/emails", requireAuth(db), async (c) => {
    const category = parseCategory(c.req.query("category"));
    if (!category) {
      return c.json(
        { error: "unknown or missing category", code: "invalid_category" },
        400,
      );
    }

    const sessionUser = c.get("sessionUser");
    const cursor = c.req.query("cursor");
    const limit = parseLimit(c.req.query("limit"));

    try {
      const { emails, nextCursor } = await loadEmailPage(
        db,
        sessionUser.id,
        category,
        cursor,
        limit,
      );
      return c.json({ emails, nextCursor }, 200);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return c.json({ error: "invalid cursor", code: "invalid_cursor" }, 400);
      }
      throw err;
    }
  });

  return app;
}
