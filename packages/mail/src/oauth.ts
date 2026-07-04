/**
 * OAuth support for Gmail / Microsoft mailboxes (spec feature 12).
 * Authorization-code flow; the resulting tokens drive IMAP XOAUTH2. Entirely
 * env-gated: without client credentials nothing registers and the UI hides
 * the buttons.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface OAuthProviderDef {
  id: "google" | "microsoft";
  displayName: string;
  /** Mailbox protocol registered for this provider. */
  protocol: "gmail-oauth" | "microsoft-oauth";
  /** Badge shown in the UI. */
  providerBadge: "gmail" | "outlook";
  authUrl: string;
  tokenUrl: string;
  scope: string;
  imapHost: string;
  imapPort: number;
}

export const OAUTH_PROVIDERS: Record<"google" | "microsoft", OAuthProviderDef> = {
  google: {
    id: "google",
    displayName: "Gmail",
    protocol: "gmail-oauth",
    providerBadge: "gmail",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email https://mail.google.com/",
    imapHost: "imap.gmail.com",
    imapPort: 993,
  },
  microsoft: {
    id: "microsoft",
    displayName: "Outlook / Microsoft 365",
    protocol: "microsoft-oauth",
    providerBadge: "outlook",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope:
      "openid email offline_access https://outlook.office.com/IMAP.AccessAsUser.All",
    imapHost: "outlook.office365.com",
    imapPort: 993,
  },
};

/** What we vault-seal as mailbox credentials for OAuth protocols. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when accessToken expires. */
  expiresAt: number;
}

export interface TokenResponse extends OAuthTokens {
  /** Extracted from the id_token when present. */
  email?: string;
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

/** Best-effort JWT payload decode (token came over TLS from the provider). */
function decodeJwtEmail(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

export function buildAuthUrl(
  def: OAuthProviderDef,
  params: { clientId: string; redirectUri: string; state: string },
): string {
  const url = new URL(def.authUrl);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", def.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("access_type", "offline"); // google: force refresh token
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function tokenCall(
  tokenUrl: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OAuthError(`token endpoint ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function exchangeCode(
  def: Pick<OAuthProviderDef, "tokenUrl">,
  params: { clientId: string; clientSecret: string; redirectUri: string; code: string },
): Promise<TokenResponse> {
  const data = await tokenCall(def.tokenUrl, {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code: params.code,
  });
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new OAuthError("no access_token in response");
  return {
    accessToken,
    refreshToken: String(data.refresh_token ?? ""),
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    email: decodeJwtEmail(typeof data.id_token === "string" ? data.id_token : undefined),
  };
}

export async function refreshTokens(
  def: Pick<OAuthProviderDef, "tokenUrl">,
  params: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<OAuthTokens> {
  const data = await tokenCall(def.tokenUrl, {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  });
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new OAuthError("refresh returned no access_token");
  return {
    accessToken,
    // Providers may rotate the refresh token; keep the old one otherwise.
    refreshToken: String(data.refresh_token ?? params.refreshToken),
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
}

// ---- Signed state: CSRF protection without a state table ------------------

const STATE_TTL_MS = 15 * 60 * 1000;

export function signOAuthState(
  secret: string,
  payload: { userId: string; provider: string },
  now = Date.now(),
): string {
  const body = `${payload.userId}.${payload.provider}.${now + STATE_TTL_MS}.${randomBytes(8).toString("base64url")}`;
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return Buffer.from(body).toString("base64url") + "." + mac;
}

export function verifyOAuthState(
  secret: string,
  state: string,
  now = Date.now(),
): { userId: string; provider: string } | null {
  const dot = state.lastIndexOf(".");
  if (dot < 0) return null;
  const bodyB64 = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  let body: string;
  try {
    body = Buffer.from(bodyB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [userId, provider, expiresAt] = body.split(".");
  if (!userId || !provider || Number(expiresAt) < now) return null;
  return { userId, provider };
}
