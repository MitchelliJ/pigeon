import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CookieJar, startTestApp, type TestContext } from "./helpers.js";

describe("mailbox routes", () => {
  let ctx: TestContext;
  const jar = new CookieJar();

  beforeAll(async () => {
    ctx = await startTestApp();
    const res = await ctx.app.request("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "mb@example.com", password: "password123", name: "MB" }),
    });
    jar.store(res);
  });
  afterAll(async () => {
    await ctx.stop();
  });

  const mailboxPayload = {
    provider: "mock",
    protocol: "mock",
    label: "Personal",
    address: "me@pigeon.test",
    host: "mock",
    port: 995,
    tls: true,
    username: "me@pigeon.test",
    password: "app-password",
  };

  it("requires auth", async () => {
    const res = await ctx.app.request("/api/mailboxes");
    expect(res.status).toBe(401);
  });

  it("rejects a failing connection test without storing anything", async () => {
    const res = await ctx.app.request("/api/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar.header() },
      body: JSON.stringify({ ...mailboxPayload, password: "fail" }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("connection test failed");
    const list = await ctx.app.request("/api/mailboxes", { headers: { cookie: jar.header() } });
    expect((await list.json()).mailboxes).toHaveLength(0);
  });

  it("connects a mailbox, enqueues the initial sync, hides credentials", async () => {
    const res = await ctx.app.request("/api/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar.header() },
      body: JSON.stringify(mailboxPayload),
    });
    expect(res.status).toBe(201);
    const { mailbox } = await res.json();
    expect(mailbox.address).toBe("me@pigeon.test");
    expect(JSON.stringify(mailbox)).not.toContain("app-password");
    expect(mailbox).not.toHaveProperty("credentialsSealed");

    const { rows } = await ctx.db.pool.query(
      "SELECT type FROM jobs WHERE type = 'mailbox.sync'",
    );
    expect(rows.length).toBe(1);
  });

  it("manual sync enqueues idempotently", async () => {
    const list = await ctx.app.request("/api/mailboxes", { headers: { cookie: jar.header() } });
    const id = (await list.json()).mailboxes[0].id;
    const r1 = await ctx.app.request(`/api/mailboxes/${id}/sync`, {
      method: "POST",
      headers: { cookie: jar.header() },
    });
    const r2 = await ctx.app.request(`/api/mailboxes/${id}/sync`, {
      method: "POST",
      headers: { cookie: jar.header() },
    });
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    const { rows } = await ctx.db.pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE type = 'mailbox.sync' AND status = 'pending'",
    );
    expect(rows[0].n).toBeLessThanOrEqual(2); // initial + at most one manual
  });

  it("deletes own mailbox, 404s on others", async () => {
    const list = await ctx.app.request("/api/mailboxes", { headers: { cookie: jar.header() } });
    const id = (await list.json()).mailboxes[0].id;
    const bad = await ctx.app.request(`/api/mailboxes/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
      headers: { cookie: jar.header() },
    });
    expect(bad.status).toBe(404);
    const ok = await ctx.app.request(`/api/mailboxes/${id}`, {
      method: "DELETE",
      headers: { cookie: jar.header() },
    });
    expect(ok.status).toBe(200);
  });
});
