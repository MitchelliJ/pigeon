import { describe, it, expect } from "vitest";
import { parseConfig, describeConfig } from "../src/config/index";
import type { Config } from "../src/config/index";

describe("parseConfig", () => {
  it("returns documented defaults when env is empty (NODE_ENV defaults to development)", () => {
    const cfg: Config = parseConfig({});

    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.PORT).toBe(8788);
    expect(cfg.LOG_LEVEL).toBe("info");
    expect(cfg.WORKER_HEARTBEAT_INTERVAL_MS).toBe(30000);
    expect(cfg.HOST).toBe("0.0.0.0");
    expect(cfg.DATABASE_URL).toBe(
      "postgres://pigeon:pigeon@localhost:5432/pigeon",
    );
  });

  it("throws a ZodError mentioning DATABASE_URL in production without DATABASE_URL", () => {
    expect(() => parseConfig({ NODE_ENV: "production" })).toThrowError(
      /DATABASE_URL/,
    );
  });

  it("succeeds in production when DATABASE_URL + the new required keys are provided and echoes the values", () => {
    const cfg = parseConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@h:5432/d",
      APP_BASE_URL: "https://app.pigeon.email",
      MAIL_FROM: "Pigeon <noreply@pigeon.email>",
      RESEND_API_KEY: "re_xxx",
    });

    expect(cfg.NODE_ENV).toBe("production");
    expect(cfg.DATABASE_URL).toBe("postgres://u:p@h:5432/d");
    expect(cfg.APP_BASE_URL).toBe("https://app.pigeon.email");
    expect(cfg.MAIL_FROM).toBe("Pigeon <noreply@pigeon.email>");
    expect(cfg.RESEND_API_KEY).toBe("re_xxx");
    expect(cfg.SIGNUP_OPEN).toBe(false);
  });

  it("throws a ZodError mentioning LOG_LEVEL when LOG_LEVEL is invalid", () => {
    expect(() => parseConfig({ LOG_LEVEL: "bogus" })).toThrowError(/LOG_LEVEL/);
  });

  it("throws a ZodError mentioning PORT when PORT is not a number", () => {
    expect(() => parseConfig({ PORT: "not-a-number" })).toThrowError(/PORT/);
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
      }),
    ).toThrowError(/RESEND_API_KEY/);
  });

  it("parses with SIGNUP_OPEN defaulting to false in development with empty env", () => {
    const cfg = parseConfig({});

    expect(cfg.SIGNUP_OPEN).toBe(false);
    // RESEND_API_KEY is optional in development and should be absent here.
    expect(cfg.RESEND_API_KEY).toBeUndefined();
  });

  it("parses SIGNUP_OPEN=true and exposes the new dev-optional keys", () => {
    const cfg = parseConfig({ SIGNUP_OPEN: "true" });

    expect(cfg.SIGNUP_OPEN).toBe(true);
    // APP_BASE_URL has a sensible dev default; MAIL_FROM is optional in dev.
    // Only assert they are reachable on the Config type (RED until extended).
    expect(typeof cfg.APP_BASE_URL).toBe("string");
  });

  it("throws a ZodError mentioning APP_BASE_URL when APP_BASE_URL is not a valid URL", () => {
    expect(() => parseConfig({ APP_BASE_URL: "not-a-url" })).toThrowError(
      /APP_BASE_URL/,
    );
  });

  it("succeeds in production with all required new keys present and echoes them", () => {
    const cfg = parseConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@h:5432/d",
      APP_BASE_URL: "https://app.pigeon.email",
      MAIL_FROM: "Pigeon <noreply@pigeon.email>",
      RESEND_API_KEY: "re_xxx",
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
