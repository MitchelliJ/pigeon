import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CookieJar, startTestApp, type TestContext } from "./helpers.js";

describe("auth", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => {
    await ctx.stop();
  });

  const email = "michi@example.com";
  const password = "correct horse battery staple";

  it("signs up, sets a session cookie, and /me works", async () => {
    const jar = new CookieJar();
    const res = await ctx.app.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name: "Michi" }),
    });
    expect(res.status).toBe(201);
    jar.store(res);
    const body = await res.json();
    expect(body.user.email).toBe(email);
    expect(body.user).not.toHaveProperty("password_hash");

    const me = await ctx.app.request("/api/auth/me", {
      headers: { cookie: jar.header() },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).user.name).toBe("Michi");
  });

  it("rejects duplicate email (case-insensitive)", async () => {
    const res = await ctx.app.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.toUpperCase(), password }),
    });
    expect(res.status).toBe(409);
  });

  it("rejects short passwords", async () => {
    const res = await ctx.app.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@example.com", password: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("logs in with correct credentials, rejects wrong ones", async () => {
    const bad = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong password 123" }),
    });
    expect(bad.status).toBe(401);

    const good = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(good.status).toBe(200);
  });

  it("logout invalidates the session server-side", async () => {
    const jar = new CookieJar();
    const login = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    jar.store(login);
    const cookieBeforeLogout = jar.header();

    const logout = await ctx.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: cookieBeforeLogout },
    });
    expect(logout.status).toBe(200);

    // Replaying the old cookie must fail — session was deleted in the DB.
    const me = await ctx.app.request("/api/auth/me", {
      headers: { cookie: cookieBeforeLogout },
    });
    expect(me.status).toBe(401);
  });

  it("requires auth on /me", async () => {
    const res = await ctx.app.request("/api/auth/me");
    expect(res.status).toBe(401);
  });
});
