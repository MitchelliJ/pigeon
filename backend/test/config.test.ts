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

  it("succeeds in production when DATABASE_URL is provided and echoes the values", () => {
    const cfg = parseConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@h:5432/d",
    });

    expect(cfg.NODE_ENV).toBe("production");
    expect(cfg.DATABASE_URL).toBe("postgres://u:p@h:5432/d");
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
