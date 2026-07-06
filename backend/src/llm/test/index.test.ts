/*
 * Unit tests for the createLlmClassifier factory's provider selection.
 *
 * Selection rule (mirrors createMailSender in ../../mail/index.ts exactly):
 *   - In production, MISTRAL_API_KEY is required — throw if absent (a defensive
 *     guard; config validation already guarantees it in production).
 *   - If MISTRAL_API_KEY is set regardless of env, use the Mistral provider.
 *   - Otherwise (dev/test, no key) fall back to the mock singleton.
 *
 * Mock identifier convention (must match ../mock): the mock is exported as the
 * singleton `mockLlmClassifier` with `name === "mock"`. The Mistral provider is
 * identified by `name === "mistral"`.
 */

import { describe, it, expect } from "vitest";
import { createLlmClassifier } from "../index";
import { mockLlmClassifier } from "../mock";
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
  MISTRAL_API_KEY: undefined,
  MISTRAL_MODEL: "mistral-medium-3-5",
};

describe("createLlmClassifier provider selection", () => {
  it("throws in production when MISTRAL_API_KEY is absent", () => {
    const prodNoKey: Config = {
      ...devConfig,
      NODE_ENV: "production",
      MISTRAL_API_KEY: undefined,
    };
    expect(() => createLlmClassifier(prodNoKey)).toThrow();
  });

  it("selects the Mistral provider (not the mock) in development when MISTRAL_API_KEY is set", () => {
    const devWithKey: Config = { ...devConfig, MISTRAL_API_KEY: "mk_x" };
    const classifier = createLlmClassifier(devWithKey);
    expect(classifier).not.toBe(mockLlmClassifier);
    expect(classifier.name).toBe("mistral");
  });

  it("selects the mock singleton in development when MISTRAL_API_KEY is absent", () => {
    const classifier = createLlmClassifier(devConfig);
    expect(classifier).toBe(mockLlmClassifier);
    expect(classifier.name).toBe("mock");
  });
});
