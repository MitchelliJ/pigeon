/*
 * Unit tests for the mock mail provider and the createMailSender factory's
 * provider selection.
 *
 * Mock identifier convention (must match the implementation in ../mock):
 *   - The mock provider is exported as a singleton `mockMail`.
 *   - `mockMail.name === "mock"` is the stable identifier.
 *   - `mockMail.outbox()` returns the array of captured emails.
 *   - `mockMail.clear()` resets the outbox. Tests call `clear()` in
 *     `beforeEach` so no state leaks across `it` blocks.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMailSender } from "../index";
import { mockMail } from "../mock";
import type { Config } from "../../config";

const devConfig: Config = {
  NODE_ENV: "development",
  PORT: 8788,
  DATABASE_URL: "postgres://pigeon:pigeon@localhost:5432/pigeon",
  APP_BASE_URL: "http://x",
  MAIL_FROM: "a@b.c",
  RESEND_API_KEY: undefined,
  SIGNUP_OPEN: false,
  LOG_LEVEL: "info",
  WORKER_HEARTBEAT_INTERVAL_MS: 30000,
  HOST: "0.0.0.0",
  VAULT_MASTER_KEY: "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=",
  MAILBOX_CONNECT_TIMEOUT_MS: 10000,
  WORKER_POLL_INTERVAL_MS: 5000,
  WORKER_CONCURRENCY: 5,
  SCHEDULER_INTERVAL_MS: 60000,
};

const prodConfig: Config = {
  ...devConfig,
  NODE_ENV: "production",
  RESEND_API_KEY: "re_x",
};

describe("mock mail sender", () => {
  beforeEach(() => {
    mockMail.clear();
  });

  it("selects the mock provider in development when RESEND_API_KEY is absent", () => {
    const sender = createMailSender(devConfig);
    expect(sender).toBe(mockMail);
    expect(sender.name).toBe("mock");
  });

  it("send() resolves to { ok: true }", async () => {
    const sender = createMailSender(devConfig);
    const result = await sender.send({
      to: "u@x",
      subject: "Hi",
      html: "<b>x</b>",
      text: "x",
    });
    expect(result).toEqual({ ok: true });
  });

  it("captures the sent email in the outbox", async () => {
    const sender = createMailSender(devConfig);
    await sender.send({
      to: "u@x",
      subject: "Hi",
      html: "<b>x</b>",
      text: "x",
    });
    const outbox = mockMail.outbox();
    expect(Array.isArray(outbox)).toBe(true);
    expect(outbox).toHaveLength(1);
    const entry = outbox[0];
    expect(entry?.to).toBe("u@x");
    expect(entry?.subject).toBe("Hi");
    expect(entry?.html).toContain("<b>x</b>");
    expect(entry?.text).toContain("x");
  });

  it("does not leak outbox state between tests", async () => {
    // The previous test sent one email; beforeEach cleared it, so the
    // outbox here must start empty.
    expect(mockMail.outbox()).toHaveLength(0);
    const sender = createMailSender(devConfig);
    await sender.send({
      to: "second@x",
      subject: "Two",
      html: "<i>y</i>",
      text: "y",
    });
    expect(mockMail.outbox()).toHaveLength(1);
  });

  it("selects the Resend provider (not the mock) in production", () => {
    const sender = createMailSender(prodConfig);
    expect(sender).not.toBe(mockMail);
    expect(sender.name).not.toBe("mock");
  });
});
