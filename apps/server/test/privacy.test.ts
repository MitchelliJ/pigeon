/** GDPR surfaces: consents, export, erasure request. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CookieJar, startTestApp, type TestContext } from "./helpers.js";

describe("privacy routes", () => {
  let ctx: TestContext;
  const jar = new CookieJar();
  const password = "password123!";
  let userId: string;

  beforeAll(async () => {
    ctx = await startTestApp();
    const res = await ctx.app.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "gdpr@example.com", password, name: "G" }),
    });
    jar.store(res);
    userId = (await res.json()).user.id;
  });
  afterAll(async () => {
    await ctx.stop();
  });

  it("signup recorded terms+privacy consent and an audit entry", async () => {
    const res = await ctx.app.request("/api/privacy/consents", {
      headers: { cookie: jar.header() },
    });
    const { consents } = await res.json();
    const kinds = consents.map((c: { kind: string }) => c.kind).sort();
    expect(kinds).toEqual(["privacy", "terms"]);
    const auditRows = await ctx.db.pool.query(
      "SELECT action FROM audit_log WHERE user_id = $1",
      [userId],
    );
    expect(auditRows.rows.map((r) => r.action)).toContain("auth.signup");
  });

  it("privacy info is public", async () => {
    const res = await ctx.app.request("/api/privacy/info");
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(JSON.stringify(info.subProcessors)).toContain("Mistral");
  });

  it("export contains the user's data but no secrets", async () => {
    // Give the user a mailbox + email so the export has content.
    await ctx.app.request("/api/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar.header() },
      body: JSON.stringify({
        provider: "mock",
        protocol: "mock",
        label: "Personal",
        address: "gdpr@example.com",
        host: "mock",
        port: 1,
        tls: false,
        username: "gdpr@example.com",
        password: "super-secret-app-password",
      }),
    });
    const res = await ctx.app.request("/api/privacy/export", {
      headers: { cookie: jar.header() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("pigeon-export");
    const body = await res.text();
    expect(body).toContain("gdpr@example.com");
    expect(body).toContain('"mailboxes"');
    expect(body).not.toContain("super-secret-app-password");
    expect(body).not.toContain("credentials_sealed");
    expect(body).not.toContain("password_hash");
  });

  it("erasure requires password + phrase, then queues the wipe and kills the session", async () => {
    const wrong = await ctx.app.request("/api/privacy/erase", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar.header() },
      body: JSON.stringify({ password: "nope", confirm: "delete my account" }),
    });
    expect(wrong.status).toBe(403);

    const res = await ctx.app.request("/api/privacy/erase", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar.header() },
      body: JSON.stringify({ password, confirm: "delete my account" }),
    });
    expect(res.status).toBe(202);

    const jobs = await ctx.db.pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE type = 'gdpr.erase'",
    );
    expect(jobs.rows[0].n).toBe(1);

    // Session dead immediately.
    const me = await ctx.app.request("/api/auth/me", { headers: { cookie: jar.header() } });
    expect(me.status).toBe(401);
  });
});
