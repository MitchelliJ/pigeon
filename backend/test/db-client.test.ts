// Integration test for the @pigeon/backend DB client (`backend/src/db/index.ts`)
// and the embedded-Postgres test harness (`backend/test/db.ts`).
//
// This is RED: neither module exists yet, so every `it` fails to resolve the
// imports. Once task 2.3 lands `createDb`/`Db` and `withTestDb`, these tests
// exercise a real embedded Postgres cluster (hence the long Vitest timeouts).

import { describe, it, expect } from "vitest";
import { withTestDb } from "./db";
import type { Db } from "../src/db/index";

describe("DB client + embedded Postgres harness", () => {
  it("query returns rows", async () => {
    const { db, close }: { db: Db; close: () => Promise<void> } =
      await withTestDb();
    try {
      const rows = await db.query`SELECT 1 AS one`;
      expect(rows.length).toBe(1);
      expect(rows[0]?.one).toBe(1);
    } finally {
      await close();
    }
  });

  it("withTx commits on success", async () => {
    const { db, close } = await withTestDb();
    try {
      const result = await db.withTx(async (tx) => {
        const r = await tx`SELECT 9 AS nine`;
        return r[0]?.nine;
      });
      expect(result).toBe(9);
    } finally {
      await close();
    }
  });

  it("withTx rolls back on throw", async () => {
    const { db, close } = await withTestDb();
    try {
      await expect(
        db.withTx(async (tx) => {
          await tx`SELECT 1`;
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    } finally {
      await close();
    }
  });

  it("close stops the cluster", async () => {
    const { db, close } = await withTestDb();
    // Smoke query while the cluster is up.
    await db.query`SELECT 1`;
    await close();
    // After close, the pool is shut down — further queries must reject.
    await expect(db.query`SELECT 1`).rejects.toThrow();
  });
});
