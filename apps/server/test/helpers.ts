/** Shared test scaffolding: app instance over a throwaway embedded Postgres. */
import { loadConfig, createLogger, type Config } from "@pigeon/config";
import { startTestDb, type TestDb } from "@pigeon/db/testing";
import { createVaultFromMasterKey } from "@pigeon/vault";
import { createApp, type AppDeps } from "../src/app.js";

export interface TestContext {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  db: TestDb;
  stop(): Promise<void>;
}

export function testConfig(overrides: Record<string, string>): Config {
  return loadConfig(
    {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
      VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      SESSION_SECRET: "test-session-secret-test-session-secret",
      LOG_LEVEL: "error",
      ...overrides,
    },
    { dotenv: false },
  );
}

export async function startTestApp(
  configOverrides: Record<string, string> = {},
): Promise<TestContext> {
  const db = await startTestDb();
  const config = testConfig({ DATABASE_URL: db.connectionString, ...configOverrides });
  const logger = createLogger("error", { name: "test" });
  const vault = createVaultFromMasterKey(config.VAULT_MASTER_KEY);
  const deps: AppDeps = { config, logger, pool: db.pool, vault };
  const app = createApp(deps);
  return {
    app,
    deps,
    db,
    stop: () => db.stop(),
  };
}

/** Minimal cookie jar for exercising session flows through app.request(). */
export class CookieJar {
  private cookies = new Map<string, string>();

  store(res: Response) {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const line of setCookies) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === "" || line.toLowerCase().includes("max-age=0")) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
