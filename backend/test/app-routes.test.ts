/*
 * RED note: today's `createApp(db: Pick<Db, "query">)` takes a single `db`
 * argument and only mounts `/healthz` and `/readyz` (see `src/server.ts`).
 * This test calls a `createApp(db, mail, vault)` that does not exist yet
 * (PRD "Inbox Connectors & Provider Abstraction" §4, the `server.ts` wiring
 * bullet: `authRoutes`, `mailboxesRoutes`, `dashboardRoutes`, and
 * `oauthRoutes` all need mounting there). Vitest/tsx does not typecheck, so
 * the extra `mail`/`vault` arguments are silently ignored at runtime and none
 * of the new routers get mounted — every request below except `/healthz`
 * currently comes back `404` instead of the expected status.
 */
import { describe, it, expect } from "vitest";
import { withTestDb } from "./db";
import { runMigrations } from "../src/migrate/runner";
import { createApp } from "../src/server";
import { createMailSender } from "../src/mail/index";
import { createVault } from "../src/vault/index";

const TEST_VAULT_KEY = "J371VUEASEUQsYjxvMKhAklLcZOslC7QAGV9/NWQTbY=";

describe("createApp wires up every feature router", () => {
  it("mounts auth, mailboxes, dashboard, and oauth routes behind the app, alongside a still-working /healthz", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const mail = createMailSender({
        NODE_ENV: "test",
        APP_BASE_URL: "http://localhost:4321",
      });
      const vault = createVault(TEST_VAULT_KEY);

      const app = createApp(db, mail, vault);

      // 1. authRoutes mounted: garbage signup body is a validation 4xx, not a 404.
      const signupRes = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(signupRes.status).not.toBe(404);

      // 2. mailboxesRoutes mounted + behind requireAuth: no cookie -> 401, not 404.
      const mailboxesRes = await app.request("/api/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(mailboxesRes.status).toBe(401);

      // 3. dashboardRoutes mounted + behind requireAuth: no cookie -> 401, not 404.
      const dashboardRes = await app.request("/api/dashboard");
      expect(dashboardRes.status).toBe(401);

      // 4. oauthRoutes mounted + behind requireAuth: no cookie -> 401, not 404.
      const oauthRes = await app.request("/api/oauth/providers");
      expect(oauthRes.status).toBe(401);

      // 5. Regression: the pre-existing liveness route still works.
      const healthzRes = await app.request("/healthz");
      expect(healthzRes.status).toBe(200);
      const healthzBody = (await healthzRes.json()) as { ok: boolean };
      expect(healthzBody).toEqual({ ok: true });
    } finally {
      await close();
    }
  });
});
