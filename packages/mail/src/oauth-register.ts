/**
 * Env-gated OAuth provider registration — called once at startup by both
 * server and worker. Without client credentials nothing registers, the
 * protocols stay unsupported, and the UI hides the buttons.
 */
import type { Config } from "@pigeon/config";
import { OAUTH_PROVIDERS, type OAuthProviderDef } from "./oauth.js";
import { registerProvider } from "./providers/index.js";
import { createOAuthImapProvider } from "./providers/oauth-imap.js";

export interface EnabledOAuthProvider {
  def: OAuthProviderDef;
  clientId: string;
  clientSecret: string;
}

export function enabledOAuthProviders(config: Config): EnabledOAuthProvider[] {
  const out: EnabledOAuthProvider[] = [];
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    out.push({
      def: OAUTH_PROVIDERS.google,
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
    });
  }
  if (config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET) {
    out.push({
      def: OAUTH_PROVIDERS.microsoft,
      clientId: config.MICROSOFT_CLIENT_ID,
      clientSecret: config.MICROSOFT_CLIENT_SECRET,
    });
  }
  return out;
}

export function registerOAuthProviders(config: Config): EnabledOAuthProvider[] {
  const enabled = enabledOAuthProviders(config);
  for (const { def, clientId, clientSecret } of enabled) {
    registerProvider(createOAuthImapProvider(def, { clientId, clientSecret }));
  }
  return enabled;
}
