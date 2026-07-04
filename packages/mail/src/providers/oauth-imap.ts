/**
 * OAuth-backed IMAP provider (Gmail / Microsoft over XOAUTH2). The mailbox
 * "secret" is a JSON token bundle; access tokens are refreshed on the fly
 * and the rotated bundle is handed back to the sync engine for resealing
 * (via FetchResult.updatedSecret).
 */
import { refreshTokens, type OAuthProviderDef, type OAuthTokens } from "../oauth.js";
import type {
  FetchOptions,
  FetchResult,
  InboxProvider,
  MailConnection,
  SyncState,
} from "../types.js";
import { imapFetchNew, imapTestConnection, makeImapClient } from "./imap.js";

const REFRESH_MARGIN_MS = 60_000;

export function createOAuthImapProvider(
  def: OAuthProviderDef,
  credentials: { clientId: string; clientSecret: string },
): InboxProvider {
  async function freshTokens(conn: MailConnection): Promise<{ tokens: OAuthTokens; rotated: boolean }> {
    let tokens: OAuthTokens;
    try {
      tokens = JSON.parse(conn.secret) as OAuthTokens;
    } catch {
      throw new Error("stored OAuth credentials are corrupted — reconnect the mailbox");
    }
    if (tokens.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
      return { tokens, rotated: false };
    }
    if (!tokens.refreshToken) {
      throw new Error("OAuth access expired and no refresh token — reconnect the mailbox");
    }
    const refreshed = await refreshTokens(def, {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken: tokens.refreshToken,
    });
    return { tokens: refreshed, rotated: true };
  }

  return {
    protocol: def.protocol,

    async testConnection(conn) {
      const { tokens } = await freshTokens(conn);
      await imapTestConnection(
        makeImapClient(
          { host: def.imapHost, port: def.imapPort, tls: true },
          { user: conn.username, accessToken: tokens.accessToken },
        ),
      );
    },

    async fetchNew(conn, state: SyncState, options?: FetchOptions): Promise<FetchResult> {
      const { tokens, rotated } = await freshTokens(conn);
      const result = await imapFetchNew(
        makeImapClient(
          { host: def.imapHost, port: def.imapPort, tls: true },
          { user: conn.username, accessToken: tokens.accessToken },
        ),
        state,
        options,
      );
      return rotated ? { ...result, updatedSecret: JSON.stringify(tokens) } : result;
    },
  };
}
