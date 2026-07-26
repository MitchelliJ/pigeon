/**
 * Unit tests for the Microsoft OAuth connector (OAuth Provider Connectors
 * PRD): authorization URL construction for the common-authority
 * identity-platform endpoint.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  MICROSOFT_TOKEN_ENDPOINT,
  MICROSOFT_SCOPE,
} from "../microsoft";

describe("buildAuthorizeUrl", () => {
  it("builds the Microsoft identity-platform authorize URL with the expected params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "test-client-id",
        redirectUri: "https://app.example.com/oauth/microsoft/callback",
        state: "test-state",
        codeChallenge: "test-code-challenge",
      }),
    );

    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");

    const params = url.searchParams;
    expect(params.get("client_id")).toBe("test-client-id");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("response_mode")).toBe("query");
    expect(params.get("redirect_uri")).toBe(
      "https://app.example.com/oauth/microsoft/callback",
    );
    expect(params.get("state")).toBe("test-state");
    expect(params.get("code_challenge")).toBe("test-code-challenge");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")).toBe(
      "offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All",
    );
  });
});

describe("microsoft token exchange", () => {
  function fakePost() {
    return vi.fn(async (_url: string, _form: URLSearchParams) => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "at-123",
        refresh_token: "rt-456",
        scope: "offline_access openid email",
        expires_in: 3600,
      }),
    }));
  }

  it("exchangeCode posts the authorization_code grant with the expected form fields", async () => {
    const post = fakePost();

    await exchangeCode(
      {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        redirectUri: "https://app.example.com/oauth/microsoft/callback",
        code: "test-code",
        codeVerifier: "test-code-verifier",
      },
      post,
    );

    expect(post).toHaveBeenCalledOnce();
    const [url, form] = post.mock.calls[0]!;
    expect(url).toBe(MICROSOFT_TOKEN_ENDPOINT);
    expect(form).toBeInstanceOf(URLSearchParams);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe("test-client-id");
    expect(form.get("client_secret")).toBe("test-client-secret");
    expect(form.get("redirect_uri")).toBe(
      "https://app.example.com/oauth/microsoft/callback",
    );
    expect(form.get("code")).toBe("test-code");
    expect(form.get("code_verifier")).toBe("test-code-verifier");
    expect(form.get("scope")).toBe(MICROSOFT_SCOPE);
  });

  it("exchangeCode maps the snake_case token response to camelCase", async () => {
    const post = fakePost();

    const result = await exchangeCode(
      {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        redirectUri: "https://app.example.com/oauth/microsoft/callback",
        code: "test-code",
        codeVerifier: "test-code-verifier",
      },
      post,
    );

    expect(result).toEqual({
      accessToken: "at-123",
      refreshToken: "rt-456",
      scope: "offline_access openid email",
      expiresIn: 3600,
    });
  });

  it("refreshAccessToken posts the refresh_token grant with the expected form fields", async () => {
    const post = fakePost();

    await refreshAccessToken(
      {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        refreshToken: "rt-existing",
      },
      post,
    );

    expect(post).toHaveBeenCalledOnce();
    const [url, form] = post.mock.calls[0]!;
    expect(url).toBe(MICROSOFT_TOKEN_ENDPOINT);
    expect(form).toBeInstanceOf(URLSearchParams);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("test-client-id");
    expect(form.get("client_secret")).toBe("test-client-secret");
    expect(form.get("refresh_token")).toBe("rt-existing");
    expect(form.get("scope")).toBe(MICROSOFT_SCOPE);
  });

  it("refreshAccessToken maps the snake_case token response to camelCase", async () => {
    const post = fakePost();

    const result = await refreshAccessToken(
      {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        refreshToken: "rt-existing",
      },
      post,
    );

    expect(result).toEqual({
      accessToken: "at-123",
      refreshToken: "rt-456",
      scope: "offline_access openid email",
      expiresIn: 3600,
    });
  });
});
