/** WhatsApp + Signal connectors against fake HTTP endpoints, and gating. */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@pigeon/config";
import { createSignalConnector } from "../src/connectors/signal.js";
import { createWhatsAppConnector } from "../src/connectors/whatsapp.js";
import { registerChannelConnectors } from "../src/register.js";
import type { OutboundMessage } from "../src/types.js";

let server: Server;
let baseUrl = "";
let requests: Array<{ url: string; auth?: string; body: any }> = [];

const message: OutboundMessage = {
  kind: "immediate",
  title: "Needs you now",
  lines: [
    {
      fromName: "Bank",
      subject: "Verify login",
      summary: "Your bank wants you to verify a sign-in.",
      priority: "urgent",
      suggestedAction: "Verify",
    },
  ],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: JSON.parse(data || "{}"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("whatsapp connector", () => {
  const makeConnector = () =>
    createWhatsAppConnector({ accessToken: "wa-token", phoneNumberId: "12345", baseUrl });

  it("validates phone numbers", () => {
    const connector = makeConnector();
    expect(() => connector.validateConfig({ phoneNumber: "+31612345678" })).not.toThrow();
    expect(() => connector.validateConfig({ phoneNumber: "0612345678" })).toThrow(/international/);
  });

  it("posts a text message to the cloud api", async () => {
    await makeConnector().send({ phoneNumber: "+31612345678" }, message);
    const req = requests.at(-1)!;
    expect(req.url).toBe("/12345/messages");
    expect(req.auth).toBe("Bearer wa-token");
    expect(req.body.messaging_product).toBe("whatsapp");
    expect(req.body.to).toBe("+31612345678");
    expect(req.body.text.body).toContain("Your bank wants you to verify a sign-in.");
  });
});

describe("signal connector", () => {
  it("posts to signal-cli-rest-api", async () => {
    const connector = createSignalConnector({
      apiUrl: baseUrl,
      senderNumber: "+3100000000",
    });
    await connector.send({ phoneNumber: "+31687654321" }, message);
    const req = requests.at(-1)!;
    expect(req.url).toBe("/v2/send");
    expect(req.body.number).toBe("+3100000000");
    expect(req.body.recipients).toEqual(["+31687654321"]);
    expect(req.body.message).toContain("🕊️ Needs you now");
  });
});

describe("env gating", () => {
  const baseEnv = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://x:x@127.0.0.1:1/x",
    VAULT_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    SESSION_SECRET: "s".repeat(40),
  };

  it("only discord without env; all three with env", () => {
    expect(registerChannelConnectors(loadConfig(baseEnv, { dotenv: false }))).toEqual(["discord"]);
    const full = loadConfig(
      {
        ...baseEnv,
        WHATSAPP_ACCESS_TOKEN: "t",
        WHATSAPP_PHONE_NUMBER_ID: "1",
        SIGNAL_API_URL: "http://localhost:9999",
        SIGNAL_SENDER_NUMBER: "+31000",
      },
      { dotenv: false },
    );
    expect(registerChannelConnectors(full)).toEqual(["discord", "whatsapp", "signal"]);
  });
});
