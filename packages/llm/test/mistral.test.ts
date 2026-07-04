/** Mistral provider against a fake in-process HTTP endpoint. */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMistralProvider, MistralError } from "../src/mistral.js";

let server: Server;
let baseUrl: string;
let lastRequest: { auth?: string; body?: any } = {};
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      lastRequest = {
        auth: req.headers.authorization,
        body: JSON.parse(data || "{}"),
      };
      res.writeHead(nextResponse.status, { "content-type": "application/json" });
      res.end(JSON.stringify(nextResponse.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function provider() {
  return createMistralProvider({
    apiKey: "test-key",
    model: "mistral-small-latest",
    baseUrl,
  });
}

const input = {
  fromName: "Bank",
  fromAddress: "alerts@bank.example",
  subject: "Verify your login",
  bodyText: "We noticed a new sign-in. Verify it was you.",
  instructions: "anything from my bank is urgent",
};

describe("mistral provider", () => {
  it("parses a well-formed triage response and sends auth + instructions", async () => {
    nextResponse = {
      status: 200,
      body: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Your bank wants you to verify a new sign-in.",
                priority: "urgent",
                needs_attention: true,
                suggested_action: "Verify now",
              }),
            },
          },
        ],
      },
    };
    const result = await provider().triage(input);
    expect(result).toEqual({
      summary: "Your bank wants you to verify a new sign-in.",
      priority: "urgent",
      needsAttention: true,
      suggestedAction: "Verify now",
    });
    expect(lastRequest.auth).toBe("Bearer test-key");
    expect(lastRequest.body.response_format).toEqual({ type: "json_object" });
    expect(lastRequest.body.messages[1].content).toContain("anything from my bank is urgent");
    expect(lastRequest.body.messages[1].content).toContain("Verify your login");
  });

  it("normalizes junk priorities and clamps long summaries", async () => {
    nextResponse = {
      status: 200,
      body: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "x".repeat(500),
                priority: "CRITICAL!!",
                needs_attention: "yes",
                suggested_action: "",
              }),
            },
          },
        ],
      },
    };
    const result = await provider().triage(input);
    expect(result.priority).toBe("everything");
    expect(result.summary.length).toBeLessThanOrEqual(240);
    expect(result.suggestedAction).toBeUndefined();
  });

  it("throws MistralError on HTTP errors (so the job retries)", async () => {
    nextResponse = { status: 429, body: { error: "rate limited" } };
    await expect(provider().triage(input)).rejects.toThrow(MistralError);
  });

  it("throws MistralError on non-JSON content", async () => {
    nextResponse = {
      status: 200,
      body: { choices: [{ message: { content: "I cannot help with that." } }] },
    };
    await expect(provider().triage(input)).rejects.toThrow(/non-JSON/);
  });
});
