import type { InboxProvider } from "../types.js";
import { imapProvider } from "./imap.js";
import { mockProvider } from "./mock.js";
import { pop3Provider } from "./pop3.js";

const providers = new Map<string, InboxProvider>([
  [imapProvider.protocol, imapProvider],
  [pop3Provider.protocol, pop3Provider],
  [mockProvider.protocol, mockProvider],
]);

/** OAuth protocols (gmail-oauth, microsoft-oauth) register here later. */
export function registerProvider(provider: InboxProvider): void {
  providers.set(provider.protocol, provider);
}

export function getProvider(protocol: string): InboxProvider {
  const provider = providers.get(protocol);
  if (!provider) throw new Error(`unsupported mailbox protocol: ${protocol}`);
  return provider;
}

export function supportedProtocols(): string[] {
  return [...providers.keys()];
}
