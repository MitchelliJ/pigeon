/** Plain-text rendering shared by WhatsApp and Signal (no rich markdown). */
import type { MessageLine, OutboundMessage } from "../types.js";

const PRIORITY_TAG: Record<string, string> = {
  urgent: "[!]",
  important: "[~]",
  everything: "[·]",
};

function formatLine(line: MessageLine): string {
  const action = line.suggestedAction ? ` → ${line.suggestedAction}` : "";
  const source = line.mailboxLabel ? ` (${line.mailboxLabel})` : "";
  return `${PRIORITY_TAG[line.priority] ?? "[·]"} ${line.fromName || "Unknown"} — ${line.summary}${action}${source}`;
}

export function formatPlainText(message: OutboundMessage): string {
  const parts: string[] = [`🕊️ ${message.title}`];
  for (const line of message.lines) parts.push(formatLine(line));
  if (message.footer) parts.push(message.footer);
  let text = parts.join("\n");
  // WhatsApp caps text messages at 4096 chars; Signal is more generous.
  if (text.length > 4000) text = text.slice(0, 3997) + "…";
  return text;
}
