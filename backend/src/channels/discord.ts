/**
 * Discord channel connector.
 *
 * Validates user-supplied webhook URLs defensively, renders provider-neutral
 * delivery messages into Discord webhook payloads, and reports sanitized send
 * results for the delivery worker's retry policy.
 */
import { renderDeliveryMessage } from "./renderer";
import type { ChannelConnector, DeliveryMessage, SendResult } from "./types";

const DISCORD_WEBHOOK_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
]);
const MAX_DISCORD_FIELDS = 25;
const MAX_FIELD_VALUE_LENGTH = 1024;
const TRUNCATED_SUMMARY_LENGTH = 1000;

export interface DiscordConfig {
  webhookUrl: string;
}

interface DiscordConnectorOptions {
  fetch: typeof fetch;
}

interface DiscordEmbedField {
  name: string;
  value: string;
}

interface DiscordEmbed {
  title?: string;
  fields?: DiscordEmbedField[];
}

interface DiscordPayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

export function createDiscordConnector({
  fetch,
}: DiscordConnectorOptions): ChannelConnector<DiscordConfig> {
  return {
    kind: "discord",

    validateConfig(input: unknown): DiscordConfig {
      if (!isWebhookConfig(input)) {
        throw new Error("Invalid Discord webhook config");
      }

      const url = parseDiscordWebhookUrl(input.webhookUrl);
      return { webhookUrl: url.toString() };
    },

    sendTest(config: DiscordConfig): Promise<SendResult> {
      return sendDiscordPayload(fetch, config.webhookUrl, { type: "test" });
    },

    send(config: DiscordConfig, message: DeliveryMessage): Promise<SendResult> {
      return sendDiscordPayload(fetch, config.webhookUrl, message);
    },
  };
}

function isWebhookConfig(input: unknown): input is DiscordConfig {
  return (
    typeof input === "object" &&
    input !== null &&
    "webhookUrl" in input &&
    typeof input.webhookUrl === "string"
  );
}

function parseDiscordWebhookUrl(webhookUrl: string): URL {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error("Invalid Discord webhook URL");
  }

  if (
    url.protocol !== "https:" ||
    !DISCORD_WEBHOOK_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.port !== "" ||
    !hasWebhookPath(url)
  ) {
    throw new Error("Invalid Discord webhook URL");
  }

  return url;
}

function hasWebhookPath(url: URL): boolean {
  const parts = url.pathname.split("/");
  return (
    parts.length === 5 &&
    parts[0] === "" &&
    parts[1] === "api" &&
    parts[2] === "webhooks" &&
    parts[3] !== "" &&
    parts[4] !== ""
  );
}

async function sendDiscordPayload(
  fetchImpl: typeof fetch,
  webhookUrl: string,
  message: DeliveryMessage,
): Promise<SendResult> {
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");

  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toDiscordPayload(message)),
    });

    if (!response.ok) {
      return discordFailure(response.status);
    }

    return {
      ok: true,
      providerMessageId: await readDiscordMessageId(response),
    };
  } catch {
    return {
      ok: false,
      retryable: true,
      reason: "Discord request failed",
    };
  }
}

function toDiscordPayload(message: DeliveryMessage): DiscordPayload {
  const rendered = renderDeliveryMessage(message);
  const payload: DiscordPayload = {};

  if (rendered.text !== undefined) {
    payload.content = rendered.text;
  }

  if (rendered.title !== undefined || rendered.items !== undefined) {
    payload.embeds = [
      {
        title: rendered.title,
        fields: rendered.items?.slice(0, MAX_DISCORD_FIELDS).map((item) => ({
          name: item.category,
          value: truncateSummary(item.summary),
        })),
      },
    ];
  }

  return payload;
}

function truncateSummary(summary: string): string {
  if (summary.length <= MAX_FIELD_VALUE_LENGTH) {
    return summary;
  }

  return `${summary.slice(0, TRUNCATED_SUMMARY_LENGTH)}…`;
}

function discordFailure(status: number): SendResult {
  return {
    ok: false,
    retryable: status === 429 || status >= 500,
    reason: `Discord responded with HTTP ${status}`,
    channelInvalid: status === 401 || status === 403 || status === 404,
  };
}

async function readDiscordMessageId(
  response: Response,
): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "id" in body &&
      typeof body.id === "string"
    ) {
      return body.id;
    }
  } catch {
    // Discord may return an empty body in non-standard test fakes; success is
    // still success, just without a provider id.
  }

  return undefined;
}
