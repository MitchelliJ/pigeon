/*
 * OAuth provider discovery route (Inbox Connectors & Provider Abstraction PRD
 * §3.2.6, FR-11).
 *
 * `oauthRoutes(db, config)` mounts `GET /api/oauth/providers` behind
 * `requireAuth(db)` for consistency with every other Feature-3-and-later
 * route, even though the connect dialog that calls it only requires the
 * caller to already be authenticated (a mailbox need not exist yet).
 *
 * The provider list is config-driven: the `microsoft` provider is offered
 * only when both `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` are set
 * in `config`, so the frontend connect dialog only renders providers whose
 * OAuth app credentials are actually configured.
 *
 * `GET /api/oauth/microsoft/callback` completes the flow: it exchanges the
 * authorization code, reads the mailbox address off the id_token, verifies
 * the access token actually authenticates over IMAP XOAUTH2 *before*
 * persisting anything, seals the refresh token, and inserts a `syncing`
 * mailbox row (mirroring `connectMailbox`'s insert-then-enqueue shape). If
 * that insert hits a (user_id, address) duplicate, an errored row for the
 * same mailbox is reconnected in place (rotating the sealed refresh token
 * and resetting status to `syncing`); a non-errored duplicate is left
 * untouched and reported as "already connected".
 */
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import {
  buildAuthorizeUrl,
  exchangeCode,
  parseIdTokenEmail,
  MICROSOFT_IMAP_HOST,
  MICROSOFT_IMAP_PORT,
} from "./microsoft";
import {
  generateCodeVerifier,
  computeCodeChallenge,
  generateState,
} from "./pkce";
import { insertOAuthState, consumeOAuthState } from "./states";
import { enqueueSyncJob } from "../queue/store";
import { getConnector } from "../mailboxes/connectors/index";
import type { TokenPoster } from "./microsoft";
import type { AuthVariables } from "../auth/middleware";
import type { Db } from "../db/index";
import type { Vault } from "../vault/index";
import type { MailboxConnector } from "../mailboxes/connectors/types";

/** Structural config subset `oauthRoutes` needs for provider discovery. */
export interface OAuthRoutesConfig {
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  APP_BASE_URL?: string;
}

/** Injectable collaborators for the callback route; all default to real implementations. */
export interface OAuthRoutesDeps {
  vault?: Vault;
  post?: TokenPoster;
  connector?: MailboxConnector;
}

/** Narrow an unknown thrown value down to "was this a 23505 from postgres.js?" */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

const defaultPost: TokenPoster = async (url, form) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
};

/** Mount the `/api/oauth/*` routes onto a fresh Hono app bound to `db`. */
export function oauthRoutes(
  db: Db,
  config: OAuthRoutesConfig,
  deps?: OAuthRoutesDeps,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const post = deps?.post ?? defaultPost;
  const connector = deps?.connector ?? getConnector("microsoft-oauth");
  const vault = deps?.vault;

  app.get("/api/oauth/providers", requireAuth(db), (c) => {
    const providers = [];
    if (config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET) {
      providers.push({
        id: "microsoft",
        label: "Outlook / Hotmail",
        startPath: "/api/oauth/microsoft/start",
      });
    }
    return c.json({ providers }, 200);
  });

  app.get("/api/oauth/microsoft/start", requireAuth(db), async (c) => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = computeCodeChallenge(codeVerifier);
    const state = generateState();
    const redirectUri = `${config.APP_BASE_URL}/api/oauth/microsoft/callback`;

    await insertOAuthState(db, {
      state,
      userId: c.get("sessionUser").id,
      codeVerifier,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    return c.redirect(
      buildAuthorizeUrl({
        clientId: config.MICROSOFT_CLIENT_ID ?? "",
        redirectUri,
        state,
        codeChallenge,
      }),
    );
  });

  app.get("/api/oauth/microsoft/callback", requireAuth(db), async (c) => {
    const errorRedirect = `${config.APP_BASE_URL}/?connected=error`;
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      return c.redirect(errorRedirect);
    }

    const consumed = await consumeOAuthState(db, state);
    if (!consumed || consumed.userId !== c.get("sessionUser").id) {
      return c.redirect(errorRedirect);
    }

    const tokens = await exchangeCode(
      {
        clientId: config.MICROSOFT_CLIENT_ID ?? "",
        clientSecret: config.MICROSOFT_CLIENT_SECRET ?? "",
        redirectUri: `${config.APP_BASE_URL}/api/oauth/microsoft/callback`,
        code,
        codeVerifier: consumed.codeVerifier,
      },
      post,
    );

    const address = parseIdTokenEmail(tokens.idToken ?? "");
    if (!address) {
      return c.redirect(errorRedirect);
    }

    const verify = await connector.testConnection({
      host: MICROSOFT_IMAP_HOST,
      port: MICROSOFT_IMAP_PORT,
      tls: true,
      username: address,
      accessToken: tokens.accessToken,
    });
    if (!verify.ok) {
      return c.redirect(errorRedirect);
    }

    // `vault` is only required for this callback (never for /providers or
    // /start), so it's not defaulted like `post`/`connector` above.
    if (!vault || !tokens.refreshToken) {
      return c.redirect(errorRedirect);
    }

    let rows;
    try {
      rows = await db.query`
        INSERT INTO mailboxes (
          user_id, provider, protocol, label, address, host, port, tls,
          username, oauth_refresh_ciphertext, oauth_scope, status
        ) VALUES (
          ${consumed.userId}, 'outlook', 'microsoft-oauth', ${address}, ${address},
          ${MICROSOFT_IMAP_HOST}, ${MICROSOFT_IMAP_PORT}, true,
          ${address}, ${vault.seal(tokens.refreshToken)}, ${tokens.scope}, 'syncing'
        ) RETURNING id
      `;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      // A 23505 here means this (user_id, address) mailbox already exists. Only
      // reconnect it in place if it's errored: a healthy/syncing row is left
      // untouched so a stray callback replay can't clobber live sync state.
      const reconnected = await db.query`
        UPDATE mailboxes
        SET oauth_refresh_ciphertext = ${vault.seal(tokens.refreshToken)},
            oauth_scope = ${tokens.scope},
            status = 'syncing'
        WHERE user_id = ${consumed.userId}
          AND address = ${address}
          AND protocol = 'microsoft-oauth'
          AND status = 'error'
        RETURNING id
      `;
      const reconnectedRow = reconnected[0];
      if (!reconnectedRow) {
        return c.redirect(`${config.APP_BASE_URL}/?connected=already`);
      }
      await enqueueSyncJob(db, String(reconnectedRow.id));
      return c.redirect(`${config.APP_BASE_URL}/?connected=outlook`);
    }
    const row = rows[0];
    if (!row) {
      throw new Error("oauth callback: mailbox insert returned no row");
    }

    await enqueueSyncJob(db, String(row.id));

    return c.redirect(`${config.APP_BASE_URL}/?connected=outlook`);
  });

  return app;
}
