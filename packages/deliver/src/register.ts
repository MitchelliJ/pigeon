/** Env-gated channel connector registration (server + worker startup). */
import type { Config, Logger } from "@pigeon/config";
import { registerConnector } from "./connectors/index.js";
import { createSignalConnector } from "./connectors/signal.js";
import { createWhatsAppConnector } from "./connectors/whatsapp.js";

export function registerChannelConnectors(config: Config, logger?: Logger): string[] {
  const enabled: string[] = ["discord"]; // always on — webhooks need no app creds
  if (config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID) {
    registerConnector(
      createWhatsAppConnector({
        accessToken: config.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
      }),
    );
    enabled.push("whatsapp");
  }
  if (config.SIGNAL_API_URL && config.SIGNAL_SENDER_NUMBER) {
    registerConnector(
      createSignalConnector({
        apiUrl: config.SIGNAL_API_URL,
        senderNumber: config.SIGNAL_SENDER_NUMBER,
      }),
    );
    enabled.push("signal");
  }
  if (enabled.length > 1) logger?.info("channel connectors enabled", { kinds: enabled });
  return enabled;
}
