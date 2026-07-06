import { describe, it, expect } from "vitest";
import { parseConfig, describeConfig } from "../src/config/index";
import type { Config } from "../src/config/index";

// Fixed test-only base64 32-byte value — not a real secret, just a
// deterministic valid-shape VAULT_MASTER_KEY for tests (FR-15).
const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";

describe("parseConfig", () => {
  it("returns documented defaults when env is empty (NODE_ENV defaults to development)", () => {
    const cfg: Config = parseConfig({ VAULT_MASTER_KEY: TEST_VAULT_KEY });

    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.PORT).toBe(8788);
    expect(cfg.LOG_LEVEL).toBe("info");
    expect(cfg.WORKER_HEARTBEAT_INTERVAL_MS).toBe(30000);
    expect(cfg.HOST).toBe("0.0.0.0");
    expect(cfg.DATABASE_URL).toBe(
      "postgres://pigeon:pigeon@localhost:5432/pigeon",
    );
    expect(cfg.VAULT_MASTER_KEY).toBe(TEST_VAULT_KEY);
    expect(cfg.MAILBOX_CONNECT_TIMEOUT_MS).toBe(10000);
  });

  it("throws a ZodError mentioning DATABASE_URL in production without DATABASE_URL", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        VAULT_MASTER_KEY: TEST_VAULT_KEY,
      }),
    ).toThrowError(/DATABASE_URL/);
  });

  it("succeeds in production when DATABASE_URL + the new required keys are provided and echoes the values", () => {
    const cfg = parseConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@h:5432/d",
      APP_BASE_URL: "https://app.pigeon.email",
      MAIL_FROM: "Pigeon <noreply@pigeon.email>",
      RESEND_API_KEY: "re_xxx",
      VAULT_MASTER_KEY: TEST_VAULT_KEY,
    });

    expect(cfg.NODE_ENV).toBe("production");
    expect(cfg.DATABASE_URL).toBe("postgres://u:p@h:5432/d");
    expect(cfg.APP_BASE_URL).toBe("https://app.pigeon.email");
    expect(cfg.MAIL_FROM).toBe("Pigeon <noreply@pigeon.email>");
    expect(cfg.RESEND_API_KEY).toBe("re_xxx");
    expect(cfg.SIGNUP_OPEN).toBe(false);
    expect(cfg.VAULT_MASTER_KEY).toBe(TEST_VAULT_KEY);
  });

  it("throws a ZodError mentioning LOG_LEVEL when LOG_LEVEL is invalid", () => {
    expect(() =>
      parseConfig({ LOG_LEVEL: "bogus", VAULT_MASTER_KEY: TEST_VAULT_KEY }),
    ).toThrowError(/LOG_LEVEL/);
  });

  it("throws a ZodError mentioning PORT when PORT is not a number", () => {
    expect(() =>
      parseConfig({
        PORT: "not-a-number",
        VAULT_MASTER_KEY: TEST_VAULT_KEY,
      }),
    ).toThrowError(/PORT/);
  });
});

describe("describeConfig", () => {
  it("redacts DATABASE_URL secrets and reports it as set when present", () => {
    const summary = describeConfig({
      DATABASE_URL: "postgres://secretuser:secretpw@host:5432/db",
    });

    const json = JSON.stringify(summary);
    expect(json).not.toContain("secretpw");
    expect(json).not.toContain("secretuser");
    expect(json).not.toContain("postgres://secretuser:secretpw@host:5432/db");
    // conveys that DATABASE_URL is set, e.g. { DATABASE_URL: "set" }
    expect(summary).toHaveProperty("DATABASE_URL");
    expect(summary.DATABASE_URL).not.toBe(
      "postgres://secretuser:secretpw@host:5432/db",
    );
  });

  it("reports DATABASE_URL as not set for empty env", () => {
    const summary = describeConfig({});

    expect(summary).toHaveProperty("DATABASE_URL");
    expect(summary.DATABASE_URL).not.toBe("set");
  });
});

describe("parseConfig — FR-30/FR-31 new keys", () => {
  it("throws a ZodError mentioning APP_BASE_URL in production without APP_BASE_URL", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://u:p@h:5432/d",
        MAIL_FROM: "x@y.z",
        RESEND_API_KEY: "re_xxx",
        VAULT_MASTER_KEY: TEST_VAULT_KEY,
      }),
    ).toThrowError(/APP_BASE_URL/);
  });

  it("throws a ZodError mentioning MAIL_FROM in production without MAIL_FROM", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://u:p@h:5432/d",
        APP_BASE_URL: "https://app.pigeon.email",
        RESEND_API_KEY: "re_xxx",
        VAULT_MASTER_KEY: TEST_VAULT_KEY,
      }),
    ).toThrowError(/MAIL_FROM/);
  });

  it("throws a ZodError mentioning RESEND_API_KEY in production without RESEND_API_KEY", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://u:p@h:5432/d",
        APP_BASE_URL: "https://app.pigeon.email",
        MAIL_FROM: "x@y.z",
        VAULT_MASTER_KEY: TEST_VAULT_KEY,
      }),
    ).toThrowError(/RESEND_API_KEY/);
  });

  it("parses with SIGNUP_OPEN defaulting to false in development with empty env", () => {
    const cfg = parseConfig({ VAULT_MASTER_KEY: TEST_VAULT_KEY });

    expect(cfg.SIGNUP_OPEN).toBe(false);
    // RESEND_API_KEY is optional in development and should be absent here.
    expect(cfg.RESEND_API_KEY).toBeUndefined();
  });

  it("parses SIGNUP_OPEN=true and exposes the new dev-optional keys", () => {
    const cfg = parseConfig({
      SIGNUP_OPEN: "true",
      VAULT_MASTER_KEY: TEST_VAULT_KEY,
    });

    expect(cfg.SIGNUP_OPEN).toBe(true);
    // APP_BASE_URL has a sensible dev default; MAIL_FROM is optional in dev.
    // Only assert they are reachable on the Config type (RED until extended).
    expect(typeof cfg.APP_BASE_URL).toBe("string");
  });

  it("throws a ZodError mentioning APP_BASE_URL when APP_BASE_URL is not a valid URL", () => {
    expect(() =>
      parseConfig({
        APP_BASE_URL: "not-a-url",
        VAULT_MASTER_KEY: TEST_VAULT_KEY,
      }),
    ).toThrowError(/APP_BASE_URL/);
  });

  it("succeeds in production with all required new keys present and echoes them", () => {
    const cfg = parseConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@h:5432/d",
      APP_BASE_URL: "https://app.pigeon.email",
      MAIL_FROM: "Pigeon <noreply@pigeon.email>",
      RESEND_API_KEY: "re_xxx",
      VAULT_MASTER_KEY: TEST_VAULT_KEY,
    });

    expect(cfg.APP_BASE_URL).toBe("https://app.pigeon.email");
    expect(cfg.MAIL_FROM).toBe("Pigeon <noreply@pigeon.email>");
    expect(cfg.RESEND_API_KEY).toBe("re_xxx");
  });
});

describe("describeConfig — FR-30 redaction", () => {
  it("redacts RESEND_API_KEY and reports SIGNUP_OPEN without leaking the secret", () => {
    const summary = describeConfig({
      RESEND_API_KEY: "re_secret",
      APP_BASE_URL: "https://app.x",
      MAIL_FROM: "noreply@x",
      SIGNUP_OPEN: "true",
    });

    const json = JSON.stringify(summary);
    // The secret must never appear in the redacted summary.
    expect(json).not.toContain("re_secret");
    // SIGNUP_OPEN is reported as a label/boolean, and is present.
    expect(summary).toHaveProperty("SIGNUP_OPEN");
    expect(summary.SIGNUP_OPEN).not.toBe("true");
    // APP_BASE_URL is reported (host is fine) without leaking the secret.
    expect(summary).toHaveProperty("APP_BASE_URL");
  });
});

describe("parseConfig — VAULT_MASTER_KEY / MAILBOX_CONNECT_TIMEOUT_MS (FR-15..FR-17)", () => {
  it("throws a ZodError mentioning VAULT_MASTER_KEY in development when it is entirely absent", () => {
    // No NODE_ENV given -> defaults to development. VAULT_MASTER_KEY must
    // still be required, proving it's not gated behind the production-only
    // requireInProd pattern used by APP_BASE_URL/MAIL_FROM/RESEND_API_KEY.
    expect(() => parseConfig({})).toThrowError(/VAULT_MASTER_KEY/);
  });

  it("throws a ZodError mentioning VAULT_MASTER_KEY when it is not valid base64", () => {
    expect(() =>
      parseConfig({ VAULT_MASTER_KEY: "not-valid-base64!!!" }),
    ).toThrowError(/VAULT_MASTER_KEY/);
  });

  it("throws a ZodError mentioning VAULT_MASTER_KEY when the decoded key is not exactly 32 bytes", () => {
    expect(() =>
      parseConfig({
        VAULT_MASTER_KEY: Buffer.from("too short").toString("base64"),
      }),
    ).toThrowError(/VAULT_MASTER_KEY/);
  });

  it("coerces MAILBOX_CONNECT_TIMEOUT_MS to a number when provided", () => {
    const cfg = parseConfig({
      VAULT_MASTER_KEY: TEST_VAULT_KEY,
      MAILBOX_CONNECT_TIMEOUT_MS: "5000",
    });

    expect(cfg.MAILBOX_CONNECT_TIMEOUT_MS).toBe(5000);
  });

  it("throws a ZodError mentioning MAILBOX_CONNECT_TIMEOUT_MS when it is not a number", () => {
    expect(() =>
      parseConfig({
        VAULT_MASTER_KEY: TEST_VAULT_KEY,
        MAILBOX_CONNECT_TIMEOUT_MS: "not-a-number",
      }),
    ).toThrowError(/MAILBOX_CONNECT_TIMEOUT_MS/);
  });
});

describe("parseConfig — queue/scheduler env vars (Feature 5)", () => {
  it("defaults WORKER_POLL_INTERVAL_MS to 5000 when absent and coerces a provided string value to a number", () => {
    const defaults = parseConfig({ VAULT_MASTER_KEY: TEST_VAULT_KEY });
    expect(defaults.WORKER_POLL_INTERVAL_MS).toBe(5000);

    const coerced = parseConfig({
      VAULT_MASTER_KEY: TEST_VAULT_KEY,
      WORKER_POLL_INTERVAL_MS: "1000",
    });
    expect(coerced.WORKER_POLL_INTERVAL_MS).toBe(1000);
  });

  it("throws a ZodError mentioning WORKER_POLL_INTERVAL_MS when it is not a number", () => {
    expect(() =>
      parseConfig({
        VAULT_MASTER_KEY: TEST_VAULT_KEY,
        WORKER_POLL_INTERVAL_MS: "not-a-number",
      }),
    ).toThrowError(/WORKER_POLL_INTERVAL_MS/);
  });

  it("defaults WORKER_CONCURRENCY to 5 when absent and coerces a provided string value to a number", () => {
    const defaults = parseConfig({ VAULT_MASTER_KEY: TEST_VAULT_KEY });
    expect(defaults.WORKER_CONCURRENCY).toBe(5);

    const coerced = parseConfig({
      VAULT_MASTER_KEY: TEST_VAULT_KEY,
      WORKER_CONCURRENCY: "1000",
    });
    expect(coerced.WORKER_CONCURRENCY).toBe(1000);
  });

  it("throws a ZodError mentioning WORKER_CONCURRENCY when it is not a number", () => {
    expect(() =>
      parseConfig({
        VAULT_MASTER_KEY: TEST_VAULT_KEY,
        WORKER_CONCURRENCY: "not-a-number",
      }),
    ).toThrowError(/WORKER_CONCURRENCY/);
  });

  it("defaults SCHEDULER_INTERVAL_MS to 60000 when absent and coerces a provided string value to a number", () => {
    const defaults = parseConfig({ VAULT_MASTER_KEY: TEST_VAULT_KEY });
    expect(defaults.SCHEDULER_INTERVAL_MS).toBe(60000);

    const coerced = parseConfig({
      VAULT_MASTER_KEY: TEST_VAULT_KEY,
      SCHEDULER_INTERVAL_MS: "1000",
    });
    expect(coerced.SCHEDULER_INTERVAL_MS).toBe(1000);
  });

  it("throws a ZodError mentioning SCHEDULER_INTERVAL_MS when it is not a number", () => {
    expect(() =>
      parseConfig({
        VAULT_MASTER_KEY: TEST_VAULT_KEY,
        SCHEDULER_INTERVAL_MS: "not-a-number",
      }),
    ).toThrowError(/SCHEDULER_INTERVAL_MS/);
  });
});
