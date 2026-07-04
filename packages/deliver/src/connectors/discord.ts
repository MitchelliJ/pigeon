/** Discord webhook connector — the first real channel. */
import {
  ChannelSendError,
  type ChannelConnector,
  type MessageLine,
  type OutboundMessage,
} from "../types.js";

const PRIORITY_EMOJI: Record<string, string> = {
  urgent: "🔴",
  important: "🟡",
  everything: "⚪",
};

function formatLine(line: MessageLine): string {
  const action = line.suggestedAction ? ` → **${line.suggestedAction}**` : "";
  const source = line.mailboxLabel ? ` _(${line.mailboxLabel})_` : "";
  return `${PRIORITY_EMOJI[line.priority] ?? "⚪"} **${line.fromName || "Unknown"}** — ${line.summary}${action}${source}`;
}

export function formatDiscordContent(message: OutboundMessage): string {
  const parts: string[] = [`**🕊️ ${message.title}**`];
  for (const line of message.lines) parts.push(formatLine(line));
  if (message.footer) parts.push(`_${message.footer}_`);
  let content = parts.join("\n");
  // Discord hard limit is 2000 chars per message.
  if (content.length > 1990) content = content.slice(0, 1987) + "…";
  return content;
}

export const discordConnector: ChannelConnector = {
  kind: "discord",

  validateConfig(config) {
    const url = config.webhookUrl;
    if (typeof url !== "string" || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) {
      throw new Error("webhookUrl must be a Discord webhook URL (https://discord.com/api/webhooks/...)");
    }
  },

  async send(config, message) {
    const url = String(config.webhookUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: formatDiscordContent(message),
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return;
    const body = await res.text().catch(() => "");
    // 4xx (bad/deleted webhook) won't heal on retry; 429/5xx will.
    const retryable = res.status === 429 || res.status >= 500;
    throw new ChannelSendError(
      `discord webhook responded ${res.status}: ${body.slice(0, 200)}`,
      retryable,
    );
  },
};
