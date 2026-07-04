/** Thin Mollie v2 REST client — plain fetch, only the calls Pigeon needs. */

export interface MollieAmount {
  currency: string;
  value: string; // "8.00"
}

export interface MolliePayment {
  id: string;
  status:
    | "open"
    | "pending"
    | "paid"
    | "failed"
    | "canceled"
    | "expired"
    | "authorized";
  customerId?: string;
  mandateId?: string;
  metadata?: Record<string, string> | null;
  _links?: { checkout?: { href: string } };
}

export interface MollieSubscription {
  id: string;
  status: "pending" | "active" | "canceled" | "suspended" | "completed";
}

export class MollieError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "MollieError";
  }
}

export interface MollieClient {
  createCustomer(input: { name: string; email: string }): Promise<{ id: string }>;
  createPayment(input: {
    amount: MollieAmount;
    description: string;
    redirectUrl: string;
    webhookUrl: string;
    customerId: string;
    sequenceType: "first" | "oneoff";
    metadata: Record<string, string>;
  }): Promise<MolliePayment>;
  getPayment(id: string): Promise<MolliePayment>;
  createSubscription(
    customerId: string,
    input: {
      amount: MollieAmount;
      interval: string;
      description: string;
      webhookUrl: string;
      metadata: Record<string, string>;
    },
  ): Promise<MollieSubscription>;
  cancelSubscription(customerId: string, subscriptionId: string): Promise<void>;
}

export function createMollieClient(apiKey: string, baseUrl: string): MollieClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new MollieError(`mollie ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    createCustomer: (input) => call("POST", "/customers", input),
    createPayment: (input) => call("POST", "/payments", input),
    getPayment: (id) => call("GET", `/payments/${id}`),
    createSubscription: (customerId, input) =>
      call("POST", `/customers/${customerId}/subscriptions`, input),
    cancelSubscription: async (customerId, subscriptionId) => {
      await call("DELETE", `/customers/${customerId}/subscriptions/${subscriptionId}`);
    },
  };
}
