/**
 * Centralized, typed, validated configuration for every Pigeon service.
 *
 * One schema for the whole backend: server and worker both call
 * `loadConfig()` at startup and crash immediately (with the offending
 * variable named) when something is missing or malformed. Secrets never
 * appear in logs — see `configSummary`.
 */
import { z } from "zod";
import { loadNearestDotenv } from "./env.js";

export { loadNearestDotenv } from "./env.js";
export { createLogger, type Logger, type LogLevel } from "./logger.js";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  DATABASE_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith("postgres://") || u.startsWith("postgresql://"), {
      message: "must be a postgres:// connection string",
    }),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),

  /**
   * 32-byte key for the secrets vault, base64-encoded (44 chars).
   * Generate with: node -e "console.log(crypto.randomBytes(32).toString('base64'))"
   */
  VAULT_MASTER_KEY: z
    .string()
    .refine((s) => Buffer.from(s, "base64").length === 32, {
      message: "must be 32 random bytes, base64-encoded",
    }),

  /** Secret used to sign session tokens. Any long random string. */
  SESSION_SECRET: z.string().min(32),

  /** Public origin of the web app, for CORS + links in notifications. */
  WEB_ORIGIN: z.string().url().default("http://localhost:4321"),
  /** Public origin of this API, for OAuth redirect URIs + Mollie webhooks. */
  API_ORIGIN: z.string().url().default("http://localhost:8788"),

  // ---- Optional integrations (features degrade gracefully when unset) ----

  /** Mistral API key. When absent, the deterministic mock LLM is used. */
  MISTRAL_API_KEY: z.string().min(1).optional(),
  MISTRAL_MODEL: z.string().default("mistral-small-latest"),
  /** Override the Mistral endpoint (used by tests to point at a fake). */
  MISTRAL_BASE_URL: z.string().url().default("https://api.mistral.ai"),

  /** Mollie API key (test_... or live_...). Absent = billing sandbox mode. */
  MOLLIE_API_KEY: z.string().min(1).optional(),
  MOLLIE_BASE_URL: z.string().url().default("https://api.mollie.com"),

  /** Gmail OAuth app credentials. Absent = Gmail OAuth hidden in UI. */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /** Microsoft OAuth app credentials. Absent = Microsoft OAuth hidden. */
  MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),

  /** WhatsApp Business Cloud API. Absent = WhatsApp channel hidden. */
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
  /** signal-cli-rest-api base URL. Absent = Signal channel hidden. */
  SIGNAL_API_URL: z.string().url().optional(),
  SIGNAL_SENDER_NUMBER: z.string().min(1).optional(),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

/** Env vars whose values must never be logged. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "DATABASE_URL", // contains the db password
  "VAULT_MASTER_KEY",
  "SESSION_SECRET",
  "MISTRAL_API_KEY",
  "MOLLIE_API_KEY",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_SECRET",
  "WHATSAPP_ACCESS_TOKEN",
]);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Parse and validate configuration from the environment (plus the nearest
 * `.env` file). Throws `ConfigError` naming every offending variable.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  { dotenv = true }: { dotenv?: boolean } = {},
): Config {
  if (dotenv) loadNearestDotenv();
  // `KEY=` in a .env file yields "", not undefined — treat blank as unset so
  // optional integrations can be left empty in the file.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }
  return Object.freeze(result.data);
}

/**
 * A loggable one-object summary of the config with secrets redacted.
 * Secret values show only whether they are set.
 */
export function configSummary(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    out[key] = SECRET_KEYS.has(key) ? "<set>" : value;
  }
  return out;
}
