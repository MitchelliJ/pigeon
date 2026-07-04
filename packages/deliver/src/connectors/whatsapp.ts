/**
 * WhatsApp channel via the Business Cloud API (env-gated: needs
 * WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID). Channel config holds
 * the recipient: { phoneNumber: "+31612345678" }.
 */
import {
  ChannelSendError,
  type ChannelConnector,
} from "../types.js";
import { formatPlainText } from "./text-format.js";

export interface WhatsAppSettings {
  accessToken: string;
  phoneNumberId: string;
  /** Overridable for tests. */
  baseUrl?: string;
}

const DEFAULT_BASE = "https://graph.facebook.com/v20.0";

export function createWhatsAppConnector(settings: WhatsAppSettings): ChannelConnector {
  const baseUrl = (settings.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  return {
    kind: "whatsapp",

    validateConfig(config) {
      const phone = config.phoneNumber;
      if (typeof phone !== "string" || !/^\+[1-9]\d{6,15}$/.test(phone)) {
        throw new Error("phoneNumber must be in international format, e.g. +31612345678");
      }
    },

    async send(config, message) {
      const res = await fetch(`${baseUrl}/${settings.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${settings.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: String(config.phoneNumber),
          type: "text",
          text: { body: formatPlainText(message) },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      throw new ChannelSendError(
        `whatsapp api responded ${res.status}: ${body.slice(0, 200)}`,
        retryable,
      );
    },
  };
}
