export * from "./types.js";
export { getConnector, registerConnector, supportedChannelKinds } from "./connectors/index.js";
export { discordConnector, formatDiscordContent } from "./connectors/discord.js";
export {
  createChannel,
  listChannels,
  getChannel,
  updateChannel,
  deleteChannel,
  openChannelConfig,
  getDeliverySettings,
  updateDeliverySettings,
  listDigestCandidates,
  type Channel,
  type DeliverySettings,
} from "./store.js";
export { routeEmail, sendDigest, sendToChannel } from "./service.js";
export { registerChannelConnectors } from "./register.js";
export { createWhatsAppConnector, type WhatsAppSettings } from "./connectors/whatsapp.js";
export { createSignalConnector, type SignalSettings } from "./connectors/signal.js";
export { formatPlainText } from "./connectors/text-format.js";
export { userClock, isDigestDue, type DigestSchedule, type UserClock } from "./time.js";
