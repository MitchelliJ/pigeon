/**
 * Subscription lifecycle. Two modes:
 *  - Real: MOLLIE_API_KEY set → hosted checkout, webhook-driven activation,
 *    recurring subscription created after the first payment.
 *  - Sandbox: no key → upgrades/downgrades apply instantly so the whole
 *    product is usable without a Mollie account (dev + demo).
 * The user's `tier` column is the single source of truth for limits; this
 * module is the only writer.
 */
import type { Config, Logger } from "@pigeon/config";
import { withTransaction, type Pool } from "@pigeon/db";
import { TIERS, tierLimits, type PlanTier } from "@pigeon/shared";
import { createMollieClient, type MollieClient } from "./mollie.js";

export interface SubscriptionRow {
  id: string;
  userId: string;
  tier: string;
  status: "pending" | "active" | "canceled" | "past_due";
  molliePaymentId: string | null;
  mollieSubscriptionId: string | null;
  createdAt: Date;
}

function rowToSubscription(row: Record<string, unknown>): SubscriptionRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    tier: row.tier as string,
    status: row.status as SubscriptionRow["status"],
    molliePaymentId: (row.mollie_payment_id as string) ?? null,
    mollieSubscriptionId: (row.mollie_subscription_id as string) ?? null,
    createdAt: row.created_at as Date,
  };
}

export interface BillingDeps {
  pool: Pool;
  config: Config;
  logger: Logger;
  /** Injectable for tests; defaults to the real client (or null in sandbox). */
  mollie?: MollieClient | null;
}

export function makeMollie(config: Config): MollieClient | null {
  if (!config.MOLLIE_API_KEY) return null;
  return createMollieClient(config.MOLLIE_API_KEY, config.MOLLIE_BASE_URL);
}

export function euros(cents: number): { currency: "EUR"; value: string } {
  return { currency: "EUR", value: (cents / 100).toFixed(2) };
}

export async function currentSubscription(
  pool: Pool,
  userId: string,
): Promise<SubscriptionRow | null> {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions
     WHERE user_id = $1 AND status IN ('pending', 'active', 'past_due')
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows.length > 0 ? rowToSubscription(rows[0]) : null;
}

async function setUserTier(pool: Pool, userId: string, tier: PlanTier): Promise<void> {
  await pool.query("UPDATE users SET tier = $2 WHERE id = $1", [userId, tier]);
}

async function getOrCreateMollieCustomer(
  deps: Required<Pick<BillingDeps, "pool" | "mollie">>,
  user: { id: string; name: string; email: string },
): Promise<string> {
  const { rows } = await deps.pool.query(
    "SELECT mollie_customer_id FROM billing_customers WHERE user_id = $1",
    [user.id],
  );
  if (rows.length > 0) return rows[0].mollie_customer_id as string;
  const customer = await deps.mollie!.createCustomer({
    name: user.name || user.email,
    email: user.email,
  });
  await deps.pool.query(
    `INSERT INTO billing_customers (user_id, mollie_customer_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id, customer.id],
  );
  return customer.id;
}

export type CheckoutResult =
  | { mode: "checkout"; checkoutUrl: string }
  | { mode: "sandbox"; tier: PlanTier };

/**
 * Start an upgrade. Real mode returns a Mollie hosted-checkout URL; sandbox
 * mode activates immediately.
 */
export async function startCheckout(
  deps: BillingDeps,
  user: { id: string; name: string; email: string },
  tier: PlanTier,
): Promise<CheckoutResult> {
  const limits = TIERS[tier];
  if (!limits || limits.priceCents === 0) {
    throw new Error("cannot check out the free tier — use cancel instead");
  }
  const mollie = deps.mollie === undefined ? makeMollie(deps.config) : deps.mollie;

  if (!mollie) {
    await withTransaction(deps.pool, async (client) => {
      await client.query(
        `UPDATE subscriptions SET status = 'canceled', updated_at = now()
         WHERE user_id = $1 AND status IN ('pending','active','past_due')`,
        [user.id],
      );
      await client.query(
        `INSERT INTO subscriptions (user_id, tier, status) VALUES ($1, $2, 'active')`,
        [user.id, tier],
      );
      await client.query("UPDATE users SET tier = $2 WHERE id = $1", [user.id, tier]);
    });
    deps.logger.info("sandbox upgrade applied", { userId: user.id, tier });
    return { mode: "sandbox", tier };
  }

  const customerId = await getOrCreateMollieCustomer({ pool: deps.pool, mollie }, user);
  const payment = await mollie.createPayment({
    amount: euros(limits.priceCents),
    description: `Pigeon ${limits.name} — first payment`,
    redirectUrl: `${deps.config.WEB_ORIGIN}/billing?checkout=done`,
    webhookUrl: `${deps.config.API_ORIGIN}/api/billing/webhook`,
    customerId,
    sequenceType: "first",
    metadata: { userId: user.id, tier },
  });
  const checkoutUrl = payment._links?.checkout?.href;
  if (!checkoutUrl) throw new Error("mollie returned no checkout link");

  await deps.pool.query(
    `INSERT INTO subscriptions (user_id, tier, status, mollie_payment_id)
     VALUES ($1, $2, 'pending', $3)`,
    [user.id, tier, payment.id],
  );
  return { mode: "checkout", checkoutUrl };
}

/**
 * Mollie webhook: re-fetch the payment (webhooks carry only an id — the
 * fetch IS the authentication) and reconcile our state. Idempotent.
 */
export async function handlePaymentWebhook(
  deps: BillingDeps,
  paymentId: string,
): Promise<"activated" | "failed" | "ignored"> {
  const mollie = deps.mollie === undefined ? makeMollie(deps.config) : deps.mollie;
  if (!mollie) {
    deps.logger.warn("billing webhook received in sandbox mode", { paymentId });
    return "ignored";
  }
  const payment = await mollie.getPayment(paymentId);
  await deps.pool.query(
    `INSERT INTO billing_events (mollie_id, kind, detail) VALUES ($1, $2, $3)`,
    [paymentId, `payment.${payment.status}`, JSON.stringify({ metadata: payment.metadata })],
  );

  const { rows } = await deps.pool.query(
    "SELECT * FROM subscriptions WHERE mollie_payment_id = $1",
    [paymentId],
  );
  if (rows.length === 0) {
    deps.logger.warn("webhook for unknown payment", { paymentId });
    return "ignored";
  }
  const sub = rowToSubscription(rows[0]);

  if (payment.status === "paid") {
    if (sub.status === "active") return "ignored"; // replayed webhook
    let mollieSubscriptionId: string | null = sub.mollieSubscriptionId;
    if (!mollieSubscriptionId && payment.customerId) {
      const recurring = await mollie.createSubscription(payment.customerId, {
        amount: euros(tierLimits(sub.tier).priceCents),
        interval: "1 month",
        description: `Pigeon ${tierLimits(sub.tier).name}`,
        webhookUrl: `${deps.config.API_ORIGIN}/api/billing/webhook`,
        metadata: { userId: sub.userId, tier: sub.tier },
      });
      mollieSubscriptionId = recurring.id;
    }
    await withTransaction(deps.pool, async (client) => {
      await client.query(
        `UPDATE subscriptions SET status = 'canceled', updated_at = now()
         WHERE user_id = $1 AND status = 'active' AND id != $2`,
        [sub.userId, sub.id],
      );
      await client.query(
        `UPDATE subscriptions SET status = 'active', mollie_subscription_id = $2, updated_at = now()
         WHERE id = $1`,
        [sub.id, mollieSubscriptionId],
      );
      await client.query("UPDATE users SET tier = $2 WHERE id = $1", [sub.userId, sub.tier]);
    });
    deps.logger.info("subscription activated", { userId: sub.userId, tier: sub.tier });
    return "activated";
  }

  if (["failed", "canceled", "expired"].includes(payment.status)) {
    if (sub.status !== "pending") return "ignored";
    await deps.pool.query(
      "UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE id = $1",
      [sub.id],
    );
    deps.logger.info("checkout did not complete", { userId: sub.userId, status: payment.status });
    return "failed";
  }

  return "ignored";
}

/** Cancel: stop the Mollie subscription (if real) and drop to free. */
export async function cancelSubscription(
  deps: BillingDeps,
  userId: string,
): Promise<"canceled" | "none"> {
  const sub = await currentSubscription(deps.pool, userId);
  if (!sub) return "none";
  const mollie = deps.mollie === undefined ? makeMollie(deps.config) : deps.mollie;

  if (mollie && sub.mollieSubscriptionId) {
    const { rows } = await deps.pool.query(
      "SELECT mollie_customer_id FROM billing_customers WHERE user_id = $1",
      [userId],
    );
    if (rows.length > 0) {
      try {
        await mollie.cancelSubscription(rows[0].mollie_customer_id, sub.mollieSubscriptionId);
      } catch (err) {
        // Already-canceled upstream must not strand the user on a paid tier.
        deps.logger.warn("mollie cancel failed, downgrading anyway", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  await withTransaction(deps.pool, async (client) => {
    await client.query(
      "UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE id = $1",
      [sub.id],
    );
    await client.query("UPDATE users SET tier = 'free' WHERE id = $1", [userId]);
  });
  deps.logger.info("subscription canceled", { userId });
  return "canceled";
}
