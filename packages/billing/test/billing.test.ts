/** Subscription lifecycle against a fake Mollie API. */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, loadConfig, type Config } from "@pigeon/config";
import { startTestDb, type TestDb } from "@pigeon/db/testing";
import {
  cancelSubscription,
  createMollieClient,
  currentSubscription,
  handlePaymentWebhook,
  startCheckout,
} from "../src/index.js";

const logger = createLogger("error", { name: "billing-test" });

/** Minimal stateful fake of the Mollie v2 API. */
class FakeMollie {
  server!: Server;
  baseUrl = "";
  payments = new Map<string, any>();
  subscriptions = new Map<string, any>();
  customers: string[] = [];
  private seq = 0;

  async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body = data ? JSON.parse(data) : {};
        const url = req.url ?? "";
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.method === "POST" && url === "/v2/customers") {
          const id = `cst_${++this.seq}`;
          this.customers.push(id);
          return send(201, { id });
        }
        if (req.method === "POST" && url === "/v2/payments") {
          const id = `tr_${++this.seq}`;
          const payment = {
            id,
            status: "open",
            customerId: body.customerId,
            metadata: body.metadata,
            _links: { checkout: { href: `${this.baseUrl}/checkout/${id}` } },
          };
          this.payments.set(id, payment);
          return send(201, payment);
        }
        const paymentGet = url.match(/^\/v2\/payments\/(.+)$/);
        if (req.method === "GET" && paymentGet) {
          const payment = this.payments.get(paymentGet[1]!);
          return payment ? send(200, payment) : send(404, { detail: "no such payment" });
        }
        const subPost = url.match(/^\/v2\/customers\/(.+)\/subscriptions$/);
        if (req.method === "POST" && subPost) {
          const id = `sub_${++this.seq}`;
          this.subscriptions.set(id, { id, status: "active", customerId: subPost[1] });
          return send(201, { id, status: "active" });
        }
        const subDelete = url.match(/^\/v2\/customers\/(.+)\/subscriptions\/(.+)$/);
        if (req.method === "DELETE" && subDelete) {
          this.subscriptions.delete(subDelete[2]!);
          return send(204, {});
        }
        send(404, { detail: `unhandled ${req.method} ${url}` });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  close(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

describe("billing", () => {
  let db: TestDb;
  let fake: FakeMollie;
  let config: Config;
  let userId: string;

  function deps() {
    return {
      pool: db.pool,
      config,
      logger,
      mollie: createMollieClient("test_key", fake.baseUrl),
    };
  }

  const user = () => ({ id: userId, name: "Michi", email: "bill@t.dev" });

  beforeAll(async () => {
    db = await startTestDb();
    fake = new FakeMollie();
    await fake.listen();
    config = loadConfig(
      {
        NODE_ENV: "test",
        DATABASE_URL: "postgres://ignored:ignored@127.0.0.1:1/x",
        VAULT_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
        SESSION_SECRET: "s".repeat(40),
        MOLLIE_API_KEY: "test_key",
        MOLLIE_BASE_URL: fake.baseUrl,
      },
      { dotenv: false },
    );
    const { rows } = await db.pool.query(
      "INSERT INTO users (email, name, password_hash) VALUES ('bill@t.dev','Michi','x') RETURNING id",
    );
    userId = rows[0].id;
  });
  afterAll(async () => {
    await db.stop();
    await fake.close();
  });

  it("checkout creates a Mollie customer + payment and a pending subscription", async () => {
    const result = await startCheckout(deps(), user(), "pro");
    expect(result.mode).toBe("checkout");
    if (result.mode !== "checkout") throw new Error("unreachable");
    expect(result.checkoutUrl).toContain("/checkout/tr_");
    expect(fake.customers).toHaveLength(1);

    const sub = await currentSubscription(db.pool, userId);
    expect(sub!.status).toBe("pending");
    expect(sub!.tier).toBe("pro");

    // Tier unchanged until the money actually moves.
    const tier = await db.pool.query("SELECT tier FROM users WHERE id = $1", [userId]);
    expect(tier.rows[0].tier).toBe("free");
  });

  it("paid webhook activates the tier and starts the recurring subscription", async () => {
    const paymentId = [...fake.payments.keys()][0]!;
    fake.payments.get(paymentId)!.status = "paid";

    expect(await handlePaymentWebhook(deps(), paymentId)).toBe("activated");
    const tier = await db.pool.query("SELECT tier FROM users WHERE id = $1", [userId]);
    expect(tier.rows[0].tier).toBe("pro");
    const sub = await currentSubscription(db.pool, userId);
    expect(sub!.status).toBe("active");
    expect(sub!.mollieSubscriptionId).toMatch(/^sub_/);
    expect(fake.subscriptions.size).toBe(1);

    // Replay: idempotent, no second recurring subscription.
    expect(await handlePaymentWebhook(deps(), paymentId)).toBe("ignored");
    expect(fake.subscriptions.size).toBe(1);
  });

  it("cancel stops Mollie and drops the user to free", async () => {
    expect(await cancelSubscription(deps(), userId)).toBe("canceled");
    const tier = await db.pool.query("SELECT tier FROM users WHERE id = $1", [userId]);
    expect(tier.rows[0].tier).toBe("free");
    expect(fake.subscriptions.size).toBe(0);
    expect(await currentSubscription(db.pool, userId)).toBeNull();
  });

  it("failed first payment cancels the pending subscription, tier stays free", async () => {
    const result = await startCheckout(deps(), user(), "team");
    if (result.mode !== "checkout") throw new Error("expected checkout");
    const paymentId = [...fake.payments.keys()].at(-1)!;
    fake.payments.get(paymentId)!.status = "failed";

    expect(await handlePaymentWebhook(deps(), paymentId)).toBe("failed");
    const tier = await db.pool.query("SELECT tier FROM users WHERE id = $1", [userId]);
    expect(tier.rows[0].tier).toBe("free");
    expect(await currentSubscription(db.pool, userId)).toBeNull();
  });

  it("sandbox mode (no Mollie) applies the upgrade instantly", async () => {
    const sandboxDeps = { pool: db.pool, config, logger, mollie: null };
    const result = await startCheckout(sandboxDeps, user(), "pro");
    expect(result).toEqual({ mode: "sandbox", tier: "pro" });
    const tier = await db.pool.query("SELECT tier FROM users WHERE id = $1", [userId]);
    expect(tier.rows[0].tier).toBe("pro");
    // Sandbox cancel works too.
    expect(await cancelSubscription(sandboxDeps, userId)).toBe("canceled");
  });
});
