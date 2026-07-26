/*
 * Access-token resolution (OAuth Provider Connectors PRD). `getAccessToken`
 * turns a mailbox's vault-sealed refresh token into a usable IMAP XOAUTH2
 * access token by unsealing it and driving the injected refresh grant.
 */
import type { Db } from "../db/index";
import type { Vault } from "../vault/index";
import type { TokenResult } from "./microsoft";

export async function getAccessToken(
  db: Db,
  vault: Vault,
  mailboxId: string,
  refresh: (refreshToken: string) => Promise<TokenResult>,
): Promise<string> {
  const rows = await db.query`
    SELECT oauth_refresh_ciphertext FROM mailboxes WHERE id = ${mailboxId}`;
  const row = rows[0];
  if (!row || row.oauth_refresh_ciphertext == null) {
    throw new Error(
      `getAccessToken: mailbox ${mailboxId} has no oauth refresh token`,
    );
  }
  const refreshToken = vault.open(String(row.oauth_refresh_ciphertext));
  const result = await refresh(refreshToken);

  // WHY: an empty access token is a failed grant, not a usable credential —
  // surface it instead of handing a blank token to the IMAP layer.
  if (!result.accessToken) {
    throw new Error(
      `getAccessToken: refresh grant for mailbox ${mailboxId} returned no access token`,
    );
  }

  // WHY: Microsoft may rotate the refresh token on each grant; persist the
  // new one so the next sync doesn't use a revoked token.
  if (result.refreshToken && result.refreshToken !== refreshToken) {
    await db.query`
      UPDATE mailboxes
      SET oauth_refresh_ciphertext = ${vault.seal(result.refreshToken)},
          updated_at = now()
      WHERE id = ${mailboxId}`;
  }

  return result.accessToken;
}
