/*
 * Configuration module.
 *
 * Validates environment variables with Zod at startup so the process
 * crashes immediately — naming the offending variable — when something
 * is missing or malformed. Secrets are never echoed by describeConfig:
 * it only reports whether DATABASE_URL, MAIL_FROM, RESEND_API_KEY, and
 * VAULT_MASTER_KEY are set. APP_BASE_URL is reported as host-only and
 * SIGNUP_OPEN as a boolean label.
 */

import { z } from "zod";
import { decodeMasterKey } from "../vault/index";

const DEV_DATABASE_URL = "postgres://pigeon:pigeon@localhost:5432/pigeon";

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(8788),
    DATABASE_URL: z.string().optional(),
    // Base URL of the web app, used to build links in outgoing mail.
    // A dev/test default is applied in parseConfig; production requires it.
    APP_BASE_URL: z.string().url().optional(),
    // Sender address for outgoing mail. Optional in dev; production requires it.
    MAIL_FROM: z.string().min(1).optional(),
    // Resend API key. Secret — never echoed. Optional in dev; production requires it.
    RESEND_API_KEY: z.string().optional(),
    // Whether new sign-ups are accepted. Accepts the strings "true"/"false"
    // from env (z.coerce.boolean() would misread "false" as true).
    SIGNUP_OPEN: z
      .preprocess(
        (v) => (v === undefined ? false : v === true || v === "true"),
        z.boolean(),
      )
      .default(false),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error"])
      .default("info"),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30000),
    HOST: z.string().default("0.0.0.0"),
    // Base64-encoded 32-byte AES-256 key used by the vault module to seal
    // provider credentials at rest (PRD "Inbox Connectors & Provider
    // Abstraction" §3.4, FR-15). Required in every environment — unlike
    // APP_BASE_URL/MAIL_FROM/RESEND_API_KEY, a missing or malformed key
    // must never be tolerated even in dev, since it would silently break
    // vault.seal/open. Left optional here so the presence/format/length
    // checks can all be reported as one clear VAULT_MASTER_KEY issue in
    // .superRefine below, instead of Zod's generic "Required" error.
    VAULT_MASTER_KEY: z.string().optional(),
    // Timeout for opening a connection to a mailbox provider (FR-16/FR-17).
    MAILBOX_CONNECT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10000),
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
    // Production-only required vars. Test env runs without these.
    const requireInProd = (
      name: "APP_BASE_URL" | "MAIL_FROM" | "RESEND_API_KEY",
      value: string | undefined,
    ) => {
      if (data.NODE_ENV === "production" && !value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} is required in production`,
          path: [name],
        });
      }
    };
    requireInProd("APP_BASE_URL", data.APP_BASE_URL);
    requireInProd("MAIL_FROM", data.MAIL_FROM);
    requireInProd("RESEND_API_KEY", data.RESEND_API_KEY);

    // VAULT_MASTER_KEY is required in every NODE_ENV (not just production):
    // a missing/malformed key would silently break vault.seal/open the
    // first time a secret needs sealing, so fail fast at startup instead.
    if (!data.VAULT_MASTER_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "VAULT_MASTER_KEY is required",
        path: ["VAULT_MASTER_KEY"],
      });
    } else {
      try {
        decodeMasterKey(data.VAULT_MASTER_KEY);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `VAULT_MASTER_KEY is invalid: ${reason}`,
          path: ["VAULT_MASTER_KEY"],
        });
      }
    }
  });

export type Config = {
  NODE_ENV: "development" | "test" | "production";
  PORT: number;
  DATABASE_URL: string;
  APP_BASE_URL: string;
  MAIL_FROM: string | undefined;
  RESEND_API_KEY: string | undefined;
  SIGNUP_OPEN: boolean;
  LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error";
  WORKER_HEARTBEAT_INTERVAL_MS: number;
  HOST: string;
  VAULT_MASTER_KEY: string;
  MAILBOX_CONNECT_TIMEOUT_MS: number;
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
  // APP_BASE_URL is required in production (enforced above); in dev/test
  // fall back to a local default when absent.
  const APP_BASE_URL = parsed.APP_BASE_URL ?? "http://localhost:4321";

  return {
    NODE_ENV: parsed.NODE_ENV,
    PORT: parsed.PORT,
    DATABASE_URL,
    APP_BASE_URL,
    MAIL_FROM: parsed.MAIL_FROM,
    RESEND_API_KEY: parsed.RESEND_API_KEY,
    SIGNUP_OPEN: parsed.SIGNUP_OPEN,
    LOG_LEVEL: parsed.LOG_LEVEL,
    WORKER_HEARTBEAT_INTERVAL_MS: parsed.WORKER_HEARTBEAT_INTERVAL_MS,
    HOST: parsed.HOST,
    // .superRefine above guarantees VAULT_MASTER_KEY is present and valid
    // whenever parse succeeds, so it's safe to assert non-undefined here.
    VAULT_MASTER_KEY: parsed.VAULT_MASTER_KEY as string,
    MAILBOX_CONNECT_TIMEOUT_MS: parsed.MAILBOX_CONNECT_TIMEOUT_MS,
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
  // APP_BASE_URL: report host only (no scheme/path), never the full URL.
  const rawAppBaseUrl = p?.APP_BASE_URL ?? env.APP_BASE_URL;
  const appBaseUrl = (() => {
    if (!rawAppBaseUrl) return "not set";
    try {
      return new URL(rawAppBaseUrl).host;
    } catch {
      return "set";
    }
  })();
  // MAIL_FROM, RESEND_API_KEY, and VAULT_MASTER_KEY are secrets: presence only.
  const mailFrom = p?.MAIL_FROM ?? env.MAIL_FROM;
  const resendApiKey = p?.RESEND_API_KEY ?? env.RESEND_API_KEY;
  const vaultMasterKey = p?.VAULT_MASTER_KEY ?? env.VAULT_MASTER_KEY;
  // SIGNUP_OPEN: report as a label (not the raw env string).
  const signupOpen = (() => {
    const value = p?.SIGNUP_OPEN ?? env.SIGNUP_OPEN === "true";
    return value ? "enabled" : "disabled";
  })();

  return {
    NODE_ENV: pick("NODE_ENV"),
    PORT: p ? String(p.PORT) : (env.PORT ?? "not set"),
    DATABASE_URL: databaseUrl ? "set" : "not set",
    APP_BASE_URL: appBaseUrl,
    MAIL_FROM: mailFrom ? "set" : "not set",
    RESEND_API_KEY: resendApiKey ? "set" : "not set",
    SIGNUP_OPEN: signupOpen,
    LOG_LEVEL: pick("LOG_LEVEL"),
    HOST: pick("HOST"),
    VAULT_MASTER_KEY: vaultMasterKey ? "set" : "not set",
    MAILBOX_CONNECT_TIMEOUT_MS: p
      ? String(p.MAILBOX_CONNECT_TIMEOUT_MS)
      : (env.MAILBOX_CONNECT_TIMEOUT_MS ?? "not set"),
  };
}
