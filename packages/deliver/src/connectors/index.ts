import type { ChannelConnector, ChannelKind } from "../types.js";
import { discordConnector } from "./discord.js";

const connectors = new Map<string, ChannelConnector>([
  [discordConnector.kind, discordConnector],
]);

/** WhatsApp / Signal connectors register here when configured. */
export function registerConnector(connector: ChannelConnector): void {
  connectors.set(connector.kind, connector);
}

export function getConnector(kind: string): ChannelConnector {
  const connector = connectors.get(kind);
  if (!connector) throw new Error(`unsupported channel kind: ${kind}`);
  return connector;
}

export function supportedChannelKinds(): ChannelKind[] {
  return [...connectors.keys()] as ChannelKind[];
}
