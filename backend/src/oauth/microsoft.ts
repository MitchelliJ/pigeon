/**
 * Microsoft identity platform OAuth connector (OAuth Provider Connectors
 * PRD). Uses the "common" authority so both personal Microsoft accounts and
 * work/school accounts can authenticate. The granted token is later used for
 * IMAP XOAUTH2 against Outlook (outlook.office365.com:993).
 */

export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/common";
export const MICROSOFT_AUTHORIZE_ENDPOINT = `${MICROSOFT_AUTHORITY}/oauth2/v2.0/authorize`;
export const MICROSOFT_TOKEN_ENDPOINT = `${MICROSOFT_AUTHORITY}/oauth2/v2.0/token`;
export const MICROSOFT_SCOPE =
  "offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All";
export const MICROSOFT_IMAP_HOST = "outlook.office365.com";
export const MICROSOFT_IMAP_PORT = 993;

export interface BuildAuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export function buildAuthorizeUrl(params: BuildAuthorizeUrlParams): string {
  const url = new URL(MICROSOFT_AUTHORIZE_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: params.clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: params.redirectUri,
    scope: MICROSOFT_SCOPE,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export type TokenPoster = (
  url: string,
  form: URLSearchParams,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresIn?: number;
  idToken?: string;
}

interface TokenResponseBody {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  id_token?: string;
}

function toTokenResult(body: TokenResponseBody): TokenResult {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scope: body.scope,
    expiresIn: body.expires_in,
    idToken: body.id_token,
  };
}

/**
 * Extracts the `email` claim from an unverified id_token JWT payload.
 *
 * Signature verification isn't needed here: the id_token only supplies the
 * mailbox address, and the token exchange itself (client secret + PKCE) is
 * what authenticates the response as genuinely from Microsoft.
 */
export function parseIdTokenEmail(idToken: string): string | null {
  const segments = idToken.split(".");
  const payloadSegment = segments[1];
  if (!payloadSegment) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export interface ExchangeCodeParams {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

export async function exchangeCode(
  params: ExchangeCodeParams,
  post: TokenPoster,
): Promise<TokenResult> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
    code_verifier: params.codeVerifier,
    scope: MICROSOFT_SCOPE,
  });
  const res = await post(MICROSOFT_TOKEN_ENDPOINT, form);
  const body = (await res.json()) as TokenResponseBody;
  return toTokenResult(body);
}

export interface RefreshAccessTokenParams {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export async function refreshAccessToken(
  params: RefreshAccessTokenParams,
  post: TokenPoster,
): Promise<TokenResult> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    scope: MICROSOFT_SCOPE,
  });
  const res = await post(MICROSOFT_TOKEN_ENDPOINT, form);
  const body = (await res.json()) as TokenResponseBody;
  return toTokenResult(body);
}
