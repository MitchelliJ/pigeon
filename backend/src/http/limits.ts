/*
 * Lightweight, dependency-free HTTP guards: a per-IP fixed-window rate limiter
 * and a request-body size cap. Both are Hono middleware.
 *
 * Pigeon runs as a single API process (multi-process is an explicit PRD
 * non-goal), so an in-memory limiter is sufficient and avoids standing up
 * Redis. If the deployment ever scales horizontally, this becomes per-instance
 * and should move to a shared store — called out here so that's a conscious
 * choice, not a silent gap.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

/** Resolve the caller's IP: trust the socket first, then an XFF hint. */
function clientIp(c: Context): string {
  try {
    const info = getConnInfo(c);
    if (info.remote.address) return info.remote.address;
  } catch {
    // getConnInfo throws if the runtime isn't the node adapter (e.g. inside
    // Hono's test `app.request`) — fall through to the header/`unknown`.
  }
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return "unknown";
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window rate limit of `max` requests per `windowMs`, keyed by client IP.
 * On exceed, responds `429` with a `Retry-After` header and never calls the
 * downstream handler — so an expensive route (e.g. login's deliberate scrypt
 * cost) can't be turned into a brute-force or CPU-exhaustion vector.
 *
 * Buckets are swept lazily on access; a periodic global sweep keeps idle keys
 * from accumulating without needing a timer that would keep the process alive.
 */
export function rateLimit(opts: {
  max: number;
  windowMs: number;
}): MiddlewareHandler {
  const { max, windowMs } = opts;
  const buckets = new Map<string, Window>();
  let lastSweep = Date.now();

  const sweep = (now: number): void => {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, window] of buckets) {
      if (window.resetAt <= now) buckets.delete(key);
    }
  };

  return async (c, next) => {
    const now = Date.now();
    sweep(now);

    const key = clientIp(c);
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (existing.count >= max) {
      const retryAfter = Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1000),
      );
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { error: "too many requests, slow down", code: "rate_limited" },
        429,
      );
    }

    existing.count += 1;
    return next();
  };
}

/**
 * Reject a request whose declared `Content-Length` exceeds `maxBytes` with a
 * `413`, before the body is buffered or JSON-parsed. Guards the unauthenticated
 * auth routes (and mailbox routes) against a cheap memory/CPU exhaustion via an
 * oversized payload. A chunked request without a `Content-Length` header slips
 * past this cheap check — acceptable for the small, well-formed JSON bodies
 * these routes expect.
 */
export function bodyLimit(maxBytes: number): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("content-length");
    if (header !== undefined) {
      const declared = Number(header);
      if (!Number.isNaN(declared) && declared > maxBytes) {
        return c.json(
          { error: "request body too large", code: "payload_too_large" },
          413,
        );
      }
    }
    return next();
  };
}
