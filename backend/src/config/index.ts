/*
 * Configuration module.
 *
 * Validates environment variables with Zod at startup so the process
 * crashes immediately — naming the offending variable — when something
 * is missing or malformed. Secrets are never echoed by describeConfig:
 * it only reports whether DATABASE_URL is set.
 */

import { z } from "zod";

const DEV_DATABASE_URL = "postgres://pigeon:pigeon@localhost:5432/pigeon";

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(8788),
    DATABASE_URL: z.string().optional(),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error"])
      .default("info"),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30000),
    HOST: z.string().default("0.0.0.0"),
  })
  .superRefine((data, ctx) => {
    const requiresDatabaseUrl =
      data.NODE_ENV === "production" || data.NODE_ENV === "test";
    if (requiresDatabaseUrl && !data.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "DATABASE_URL is required in production and test environments",
        path: ["DATABASE_URL"],
      });
    }
  });

export type Config = {
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  DATABASE_URL: string;
  LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error";
  WORKER_HEARTBEAT_INTERVAL_MS: number;
  HOST: string;
};

/**
 * Parse and validate environment variables into a typed Config.
 * Development falls back to a local DATABASE_URL; production/test
 * require DATABASE_URL to be present or validation throws.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = configSchema.parse(env);
  // The schema rejects production/test without DATABASE_URL, so the only
  // case where it can be absent here is development — fall back to the
  // local dev default.
  const DATABASE_URL = parsed.DATABASE_URL ?? DEV_DATABASE_URL;

  return {
    NODE_ENV: parsed.NODE_ENV,
    PORT: parsed.PORT,
    DATABASE_URL,
    LOG_LEVEL: parsed.LOG_LEVEL,
    WORKER_HEARTBEAT_INTERVAL_MS: parsed.WORKER_HEARTBEAT_INTERVAL_MS,
    HOST: parsed.HOST,
  };
}

/**
 * Return a redacting summary of the environment: secrets are reported
 * only as "set" / "not set", never as their raw values.
 */
export function describeConfig(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const parsed = configSchema.safeParse(env);
  const p = parsed.success ? parsed.data : null;
  // Reports a validated value when available, else the raw env value,
  // else "not set". Used only for non-secret string fields.
  const pick = (k: "NODE_ENV" | "LOG_LEVEL" | "HOST") =>
    p?.[k] ?? env[k] ?? "not set";
  // DATABASE_URL is a secret: report only presence, never the raw value.
  const databaseUrl = p?.DATABASE_URL ?? env.DATABASE_URL;

  return {
    NODE_ENV: pick("NODE_ENV"),
    PORT: p ? String(p.PORT) : (env.PORT ?? "not set"),
    DATABASE_URL: databaseUrl ? "set" : "not set",
    LOG_LEVEL: pick("LOG_LEVEL"),
    HOST: pick("HOST"),
  };
}
