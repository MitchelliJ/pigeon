/** OAuth routes: env gating, consent redirect, state validation. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CookieJar, startTestApp, type TestContext } from "./helpers.js";

describe("oauth routes", () => {
  describe("unconfigured (default)", () => {
    let ctx: TestContext;
    beforeAll(async () => {
      ctx = await startTestApp();
    });
    afterAll(async () => {
      await ctx.stop();
    });

    it("advertises no providers and 404s the flow", async () => {
      const res = await ctx.app.request("/api/oauth/providers");
      expect((await res.json()).providers).toEqual([]);
      const jar = new CookieJar();
      const signup = await ctx.app.request("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "o@example.com", password: "password123" }),
      });
      jar.store(signup);
      const start = await ctx.app.request("/api/oauth/google/start", {
        headers: { cookie: jar.header() },
      });
      expect(start.status).toBe(404);
    });
  });

  describe("configured", () => {
    let ctx: TestContext;
    const jar = new CookieJar();
    beforeAll(async () => {
      ctx = await startTestApp({
        GOOGLE_CLIENT_ID: "google-cid",
        GOOGLE_CLIENT_SECRET: "google-secret",
      });
      const signup = await ctx.app.request("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "o2@example.com", password: "password123" }),
      });
      jar.store(signup);
    });
    afterAll(async () => {
      await ctx.stop();
    });

    it("advertises google", async () => {
      const res = await ctx.app.request("/api/oauth/providers");
      const { providers } = await res.json();
      expect(providers).toEqual([
        { id: "google", displayName: "Gmail", providerBadge: "gmail" },
      ]);
    });

    it("start requires auth and redirects to Google with signed state", async () => {
      const anon = await ctx.app.request("/api/oauth/google/start");
      expect(anon.status).toBe(401);

      const res = await ctx.app.request("/api/oauth/google/start", {
        headers: { cookie: jar.header() },
      });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(location.hostname).toBe("accounts.google.com");
      expect(location.searchParams.get("client_id")).toBe("google-cid");
      expect(location.searchParams.get("state")).toBeTruthy();
      expect(location.searchParams.get("redirect_uri")).toContain("/api/oauth/google/callback");
    });

    it("callback rejects forged state", async () => {
      const res = await ctx.app.request(
        "/api/oauth/google/callback?code=abc&state=forged.state",
      );
      expect(res.status).toBe(400);
    });

    it("callback with provider error redirects back gracefully", async () => {
      const res = await ctx.app.request("/api/oauth/google/callback?error=access_denied");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("connect=denied");
    });
  });
});
