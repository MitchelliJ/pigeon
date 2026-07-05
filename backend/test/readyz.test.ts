import { describe, it, expect } from "vitest";
import { withTestDb } from "./db";
import { createApp } from "../src/server";
import type { Db } from "../src/db/index";

describe("GET /readyz", () => {
  it("returns 200 { ok: true } when the DB is reachable", async () => {
    const { db, close } = await withTestDb();
    try {
      const app = createApp(db);
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
    const app = createApp(db);
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
      const app = createApp(db);
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
    const app = createApp(fakeDb as Pick<Db, "query">);
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body).toHaveProperty("ok", false);
    expect(typeof body.reason).toBe("string");
    expect(body.reason).not.toBe("");
  });
});
