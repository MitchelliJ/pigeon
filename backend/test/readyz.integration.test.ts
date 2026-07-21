import { describe, it, expect } from "vitest";
import { withTestDb } from "./db";
import { createApp } from "../src/server";
import { createMailSender } from "../src/mail/index";
import { createVault } from "../src/vault/index";
import type { Db } from "../src/db/index";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";

// `createApp` now also needs a `MailSender` and `Vault` to wire up the other
// feature routers — these tests only exercise `/healthz` and `/readyz`, so a
// single fixed test mail sender/vault (matching the ones used elsewhere in
// this repo) is enough to satisfy the signature.
const mail = createMailSender({
  NODE_ENV: "test",
  APP_BASE_URL: "http://localhost:4321",
});
const vault = createVault(TEST_VAULT_KEY);

describe("GET /readyz", () => {
  it("returns 200 { ok: true } when the DB is reachable", async () => {
    const { db, close } = await withTestDb();
    try {
      const app = createApp(db, mail, vault);
      const res = await app.request("/readyz");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; reason?: string };
      expect(body).toEqual({ ok: true });
    } finally {
      await close();
    }
  });

  it("returns 503 { ok: false, reason } when the DB is gone", async () => {
    const { db, close } = await withTestDb();
    const app = createApp(db, mail, vault);
    await close(); // shut the cluster so the DB is unreachable
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body).toHaveProperty("ok", false);
    expect(body).toHaveProperty("reason");
    expect(typeof body.reason).toBe("string");
    expect(body.reason).not.toBe("");
  });

  it("/healthz stays 200 regardless of DB", async () => {
    const { db, close } = await withTestDb();
    try {
      const app = createApp(db, mail, vault);
      const res = await app.request("/healthz");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; reason?: string };
      expect(body).toEqual({ ok: true });
    } finally {
      await close();
    }
  });

  it("readyz reason is non-empty even when the DB error has an empty message", async () => {
    const fakeDb = {
      query: (() => Promise.reject(new Error(""))) as unknown as Pick<
        Db,
        "query"
      >["query"],
    };
    const app = createApp(fakeDb as unknown as Db, mail, vault);
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body).toHaveProperty("ok", false);
    expect(typeof body.reason).toBe("string");
    expect(body.reason).not.toBe("");
  });
});
