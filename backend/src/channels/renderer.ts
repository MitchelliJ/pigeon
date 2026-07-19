/**
 * Renders provider-neutral channel messages into simple serializable content.
 * Connectors can translate this stable shape to provider-specific payloads.
 */
import type { Category } from "@pigeon/shared";
import type { DeliveryMessage, DeliverySummaryItem } from "./types";

const CATEGORY_LABELS: Record<Category, string> = {
  requires_action: "Requires action",
  important: "Important",
  noise: "Noise",
};

export interface RenderedDeliveryMessage {
  title?: string;
  text?: string;
  items?: RenderedDeliveryItem[];
}

export interface RenderedDeliveryItem {
  category: string;
  summary: string;
}

export function renderDeliveryMessage(
  message: DeliveryMessage,
): RenderedDeliveryMessage {
  switch (message.type) {
    case "test":
      return { text: "Pigeon test message — Discord delivery is connected." };
    case "immediate":
      return {
        title: "Requires action",
        items: [renderItem(message)],
      };
    case "heartbeat":
      return { text: "Pigeon is still here — all is well." };
    case "digest":
      return renderDigest(message);
    case "empty_digest":
      return { text: "No new emails since your last digest." };
  }
}

function renderDigest(
  message: Extract<DeliveryMessage, { type: "digest" }>,
): RenderedDeliveryMessage {
  const rendered: RenderedDeliveryMessage = {
    title: "Pigeon daily digest",
    items: message.items.map(renderItem),
  };

  if (message.omittedCount !== undefined && message.omittedCount > 0) {
    rendered.text = `+${message.omittedCount} more email(s) are available in Pigeon.`;
  }

  return rendered;
}

function renderItem(item: DeliverySummaryItem): RenderedDeliveryItem {
  return {
    category: CATEGORY_LABELS[item.category],
    summary: item.summary,
  };
}
