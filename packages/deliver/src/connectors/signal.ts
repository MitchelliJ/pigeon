/**
 * Signal channel via a self-hosted signal-cli-rest-api instance (env-gated:
 * SIGNAL_API_URL + SIGNAL_SENDER_NUMBER). Channel config holds the
 * recipient: { phoneNumber: "+31612345678" }.
 */
import {
  ChannelSendError,
  type ChannelConnector,
} from "../types.js";
import { formatPlainText } from "./text-format.js";

export interface SignalSettings {
  apiUrl: string;
  senderNumber: string;
}

export function createSignalConnector(settings: SignalSettings): ChannelConnector {
  const baseUrl = settings.apiUrl.replace(/\/$/, "");
  return {
    kind: "signal",

    validateConfig(config) {
      const phone = config.phoneNumber;
      if (typeof phone !== "string" || !/^\+[1-9]\d{6,15}$/.test(phone)) {
        throw new Error("phoneNumber must be in international format, e.g. +31612345678");
      }
    },

    async send(config, message) {
      const res = await fetch(`${baseUrl}/v2/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: formatPlainText(message),
          number: settings.senderNumber,
          recipients: [String(config.phoneNumber)],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      throw new ChannelSendError(
        `signal api responded ${res.status}: ${body.slice(0, 200)}`,
        retryable,
      );
    },
  };
}
