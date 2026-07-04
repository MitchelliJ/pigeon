/** OAuth building blocks: signed state, code exchange, token refresh. */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildAuthUrl,
  exchangeCode,
  OAUTH_PROVIDERS,
  refreshTokens,
  signOAuthState,
  verifyOAuthState,
} from "../src/oauth.js";

const secret = "test-secret-test-secret-test-secret!";

describe("oauth state", () => {
  it("round-trips a valid state", () => {
    const state = signOAuthState(secret, { userId: "u1", provider: "google" });
    expect(verifyOAuthState(secret, state)).toEqual({ userId: "u1", provider: "google" });
  });

  it("rejects tampering and wrong secrets", () => {
    const state = signOAuthState(secret, { userId: "u1", provider: "google" });
    expect(verifyOAuthState("other-secret", state)).toBeNull();
    const forged = Buffer.from("u2.google.9999999999999.xxxx").toString("base64url") + "." + state.split(".")[1];
    expect(verifyOAuthState(secret, forged)).toBeNull();
    expect(verifyOAuthState(secret, "garbage")).toBeNull();
  });

  it("expires", () => {
    const past = Date.now() - 60 * 60 * 1000;
    const state = signOAuthState(secret, { userId: "u1", provider: "google" }, past);
    expect(verifyOAuthState(secret, state)).toBeNull();
  });
});

describe("auth url", () => {
  it("carries client id, redirect, scope and state", () => {
    const url = new URL(
      buildAuthUrl(OAUTH_PROVIDERS.google, {
        clientId: "cid",
        redirectUri: "http://localhost:8788/api/oauth/google/callback",
        state: "st4te",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("scope")).toContain("mail.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });
});

describe("token endpoint calls", () => {
  let server: Server;
  let tokenUrl = "";
  let lastForm: URLSearchParams;
  let nextBody: Record<string, unknown> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastForm = new URLSearchParams(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(nextBody));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    tokenUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("exchanges a code and extracts the email from the id_token", async () => {
    const idToken =
      "x." + Buffer.from(JSON.stringify({ email: "me@gmail.com" })).toString("base64url") + ".y";
    nextBody = {
      access_token: "at1",
      refresh_token: "rt1",
      expires_in: 3600,
      id_token: idToken,
    };
    const tokens = await exchangeCode(
      { tokenUrl },
      { clientId: "cid", clientSecret: "cs", redirectUri: "http://x/cb", code: "c0de" },
    );
    expect(tokens.accessToken).toBe("at1");
    expect(tokens.refreshToken).toBe("rt1");
    expect(tokens.email).toBe("me@gmail.com");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(lastForm.get("grant_type")).toBe("authorization_code");
    expect(lastForm.get("code")).toBe("c0de");
  });

  it("refresh keeps the old refresh token when the provider omits it", async () => {
    nextBody = { access_token: "at2", expires_in: 1800 };
    const tokens = await refreshTokens({ tokenUrl }, {
      clientId: "cid",
      clientSecret: "cs",
      refreshToken: "rt-original",
    });
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBe("rt-original");
    expect(lastForm.get("grant_type")).toBe("refresh_token");
  });
});
