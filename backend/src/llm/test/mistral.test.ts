/*
 * Unit tests for the Mistral LLM classifier provider.
 *
 * Pure unit tests: global.fetch is stubbed, no network is hit. The Mistral
 * provider is required to go through fetch (so the test never imports a Mistral
 * SDK directly). global.fetch is restored in afterEach. Mirrors the style of
 * `mail/test/resend.test.ts`. Classification failures must surface as
 * `{ ok: false, reason }` rather than throwing (PRD §6).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMistralClassifier } from "../mistral";
import type { ClassifyInput } from "../index";
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
  VAULT_MASTER_KEY: "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=",
  MAILBOX_CONNECT_TIMEOUT_MS: 10000,
  WORKER_POLL_INTERVAL_MS: 5000,
  WORKER_CONCURRENCY: 5,
  SCHEDULER_INTERVAL_MS: 60000,
  MISTRAL_API_KEY: "ml_test_key",
  MISTRAL_MODEL: "mistral-medium-3-5",
};

const input: ClassifyInput = {
  fromName: "Pietje Puk",
  fromAddress: "pietje@example.com",
  subject: "Please review the invoice",
  body: "Could you take a look at the attached invoice and confirm?",
  classificationInstructions: "Treat anything from my accountant as important.",
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

/** Build a Mistral chat-completions-shaped response wrapping `content`. */
function completion(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

describe("mistral classifier", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves { ok: true, result } with the parsed summary and category", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(
        completion(
          '{"summary":"Pietje asks you to review the invoice.","category":"important"}',
        ),
        { ok: true, status: 200 },
      ),
    ) as unknown as typeof global.fetch;

    const classifier = createMistralClassifier(config);
    const result = await classifier.classify(input);

    expect(result).toEqual({
      ok: true,
      result: {
        summary: "Pietje asks you to review the invoice.",
        category: "important",
      },
    });
  });

  it("POSTs to the Mistral chat completions endpoint with auth headers and the configured model", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(completion('{"summary":"S","category":"noise"}'), {
        ok: true,
        status: 200,
      }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const classifier = createMistralClassifier(config);
    await classifier.classify(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [url, init] = call as unknown as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ml_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("mistral-medium-3-5");
  });

  it("includes the classification instructions in the request when provided", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(completion('{"summary":"S","category":"noise"}'), {
        ok: true,
        status: 200,
      }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const classifier = createMistralClassifier(config);
    await classifier.classify(input);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [, init] = call as unknown as [string, RequestInit];
    expect(init.body as string).toContain(
      "Treat anything from my accountant as important.",
    );
  });

  it("omits the classification instructions placeholder when no instructions are provided", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(completion('{"summary":"S","category":"noise"}'), {
        ok: true,
        status: 200,
      }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const {
      classificationInstructions: _classificationInstructions,
      ...inputWithoutInstructions
    } = input;

    const classifier = createMistralClassifier(config);
    await classifier.classify(inputWithoutInstructions);

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [, init] = call as unknown as [string, RequestInit];
    expect(init.body as string).not.toContain(
      "{{CLASSIFICATION_INSTRUCTIONS}}",
    );
    expect(init.body as string).not.toContain(
      "Treat anything from my accountant as important.",
    );
  });

  it("resolves { ok: false, reason } when the model category is outside the enum (no throw)", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(completion('{"summary":"S","category":"urgent"}'), {
        ok: true,
        status: 200,
      }),
    ) as unknown as typeof global.fetch;

    const classifier = createMistralClassifier(config);
    const result = await classifier.classify(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("resolves { ok: false, reason } on a non-2xx response (no throw)", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ message: "internal error" }, { ok: false, status: 500 }),
    ) as unknown as typeof global.fetch;

    const classifier = createMistralClassifier(config);
    const result = await classifier.classify(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("resolves { ok: false, reason } when the model content is not valid JSON (no throw)", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(completion("not json"), { ok: true, status: 200 }),
    ) as unknown as typeof global.fetch;

    const classifier = createMistralClassifier(config);
    const result = await classifier.classify(input);

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

    const classifier = createMistralClassifier(config);
    const result = await classifier.classify(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
