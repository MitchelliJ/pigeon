/*
 * Unit tests for the Resend mail provider.
 *
 * Pure unit tests: global.fetch is stubbed, no network is hit. The Resend
 * provider is required to go through fetch (so the test never imports the
 * `resend` npm package directly). global.fetch is restored in afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMailSender } from "../index";
import type { Config } from "../../config";

const config: Config = {
  NODE_ENV: "production",
  PORT: 8788,
  DATABASE_URL: "postgres://pigeon:pigeon@localhost:5432/pigeon",
  APP_BASE_URL: "http://x",
  MAIL_FROM: "Pigeon <noreply@pigeon.email>",
  RESEND_API_KEY: "re_test_key",
  SIGNUP_OPEN: false,
  LOG_LEVEL: "info",
  WORKER_HEARTBEAT_INTERVAL_MS: 30000,
  HOST: "0.0.0.0",
};

function jsonResponse(
  body: unknown,
  init: { ok: boolean; status: number },
): Response {
  const res = {
    ok: init.ok,
    status: init.status,
    json: async () => body,
  } as unknown as Response;
  return res;
}

describe("resend mail sender", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs to Resend with the right URL, headers, and body, and resolves { ok: true }", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: "msg_1" }, { ok: true, status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const sender = createMailSender(config);
    const result = await sender.send({
      to: "u@x",
      subject: "S",
      html: "<i>h</i>",
      text: "h",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [url, init] = call as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.from).toBe("Pigeon <noreply@pigeon.email>");
    expect(body.to).toEqual(["u@x"]);
    expect(body.subject).toBe("S");
    expect(body.html).toBe("<i>h</i>");
    expect(body.text).toBe("h");
    expect(result).toEqual({ ok: true });
  });

  it("resolves { ok: false, reason } when Resend returns a non-ok status (no throw)", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(
        { name: "error", message: "boom" },
        { ok: false, status: 500 },
      ),
    ) as unknown as typeof global.fetch;

    const sender = createMailSender(config);
    const result = await sender.send({
      to: "u@x",
      subject: "S",
      html: "<i>h</i>",
      text: "h",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("resolves { ok: false, reason } when fetch rejects (network error, no throw)", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof global.fetch;

    const sender = createMailSender(config);
    const result = await sender.send({
      to: "u@x",
      subject: "S",
      html: "<i>h</i>",
      text: "h",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
