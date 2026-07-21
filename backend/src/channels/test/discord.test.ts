import { describe, expect, it, vi } from "vitest";
import { createDiscordConnector } from "../discord";

const validWebhookUrl =
  "https://discord.com/api/webhooks/123456789/secret-token";

function createFetchStub(): typeof fetch {
  return vi.fn() as unknown as typeof fetch;
}

function okDiscordResponse(id = "message-1"): Response {
  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonBody(fetchStub: typeof fetch): unknown {
  const init = vi.mocked(fetchStub).mock.calls[0]?.[1] as
    RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

function calledUrl(fetchStub: typeof fetch): string {
  const input = vi.mocked(fetchStub).mock.calls[0]?.[0];
  return input instanceof Request ? input.url : String(input);
}

describe("Discord channel connector", () => {
  it("accepts HTTPS Discord webhook URLs with the webhook API path", () => {
    const connector = createDiscordConnector({ fetch: createFetchStub() });

    expect(() =>
      connector.validateConfig({ webhookUrl: validWebhookUrl }),
    ).not.toThrow();
  });

  it.each([
    [
      "userinfo",
      "https://user:pass@discord.com/api/webhooks/123456789/secret-token",
    ],
    [
      "fragment",
      "https://discord.com/api/webhooks/123456789/secret-token#frag",
    ],
    [
      "unexpected port",
      "https://discord.com:444/api/webhooks/123456789/secret-token",
    ],
    [
      "non-Discord host",
      "https://evil.example/api/webhooks/123456789/secret-token",
    ],
    ["wrong path", "https://discord.com/channels/123456789/secret-token"],
    ["non-HTTPS URL", "http://discord.com/api/webhooks/123456789/secret-token"],
  ])("rejects %s", (_name, webhookUrl) => {
    const connector = createDiscordConnector({ fetch: createFetchStub() });

    expect(() => connector.validateConfig({ webhookUrl })).toThrow();
  });

  it("sendTest posts a wait=true test message and returns the Discord message id", async () => {
    const fetchStub = createFetchStub();
    vi.mocked(fetchStub).mockResolvedValue(okDiscordResponse());
    const connector = createDiscordConnector({ fetch: fetchStub });
    const config = connector.validateConfig({ webhookUrl: validWebhookUrl });

    const result = await connector.sendTest(config);

    expect({
      result,
      url: calledUrl(fetchStub),
      body: jsonBody(fetchStub),
    }).toMatchObject({
      result: { ok: true, providerMessageId: "message-1" },
      url: expect.stringContaining("wait=true"),
      body: expect.objectContaining({
        content: expect.stringContaining(
          "Pigeon test message — Discord delivery is connected.",
        ),
      }),
    });
  });

  it("returns a retryable sanitized failure when the network throws", async () => {
    const fetchStub = createFetchStub();
    vi.mocked(fetchStub).mockRejectedValue(
      new Error(`connect failed for ${validWebhookUrl}`),
    );
    const connector = createDiscordConnector({ fetch: fetchStub });
    const config = connector.validateConfig({ webhookUrl: validWebhookUrl });

    const result = await connector.sendTest(config);

    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      reason: expect.not.stringContaining("secret-token"),
    });
  });

  it.each([429, 500])("returns retryable true for HTTP %i", async (status) => {
    const fetchStub = createFetchStub();
    vi.mocked(fetchStub).mockResolvedValue(new Response("nope", { status }));
    const connector = createDiscordConnector({ fetch: fetchStub });
    const config = connector.validateConfig({ webhookUrl: validWebhookUrl });

    const result = await connector.sendTest(config);

    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it.each([401, 403, 404])(
    "returns retryable false for HTTP %i",
    async (status) => {
      const fetchStub = createFetchStub();
      vi.mocked(fetchStub).mockResolvedValue(new Response("nope", { status }));
      const connector = createDiscordConnector({ fetch: fetchStub });
      const config = connector.validateConfig({ webhookUrl: validWebhookUrl });

      const result = await connector.sendTest(config);

      expect(result).toMatchObject({ ok: false, retryable: false });
    },
  );

  it("returns retryable false for HTTP 400", async () => {
    const fetchStub = createFetchStub();
    vi.mocked(fetchStub).mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );
    const connector = createDiscordConnector({ fetch: fetchStub });
    const config = connector.validateConfig({ webhookUrl: validWebhookUrl });

    const result = await connector.sendTest(config);

    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it("sends digest body with capped fields, omitted count, and truncated summaries", async () => {
    const fetchStub = createFetchStub();
    vi.mocked(fetchStub).mockResolvedValue(okDiscordResponse());
    const connector = createDiscordConnector({ fetch: fetchStub });
    const config = connector.validateConfig({ webhookUrl: validWebhookUrl });
    const longSummary = "x".repeat(5000);

    await connector.send(config, {
      type: "digest",
      username: "Sam",
      omittedCount: 3,
      items: Array.from({ length: 30 }, () => ({
        category: "important" as const,
        summary: longSummary,
      })),
    });

    const body = jsonBody(fetchStub) as {
      content?: string;
      embeds?: Array<{
        title?: string;
        description?: string;
        fields?: Array<{ value?: string }>;
      }>;
    };
    expect(body).toMatchObject({
      content: expect.stringContaining(
        "This digest is capped to 30 emails, but there are 3 more available in Pigeon.",
      ),
      embeds: [
        expect.objectContaining({
          title: expect.stringContaining("Hi Sam, here is your email digest."),
          fields: expect.arrayContaining([
            expect.objectContaining({
              value: expect.not.stringContaining(longSummary),
            }),
          ]),
        }),
      ],
    });
    expect(body.embeds?.[0]?.fields).toHaveLength(25);
  });

  it("does not include the webhook secret or full webhook URL in failure reasons", async () => {
    const fetchStub = createFetchStub();
    vi.mocked(fetchStub).mockResolvedValue(
      new Response("server error", { status: 500 }),
    );
    const connector = createDiscordConnector({ fetch: fetchStub });
    const config = connector.validateConfig({ webhookUrl: validWebhookUrl });

    const result = await connector.sendTest(config);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.not.stringMatching(
        /secret-token|https:\/\/discord\.com\/api\/webhooks\/123456789\/secret-token/,
      ),
    });
  });
});
