/**
 * Pigeon API client — talks to the real backend (@pigeon/backend) with
 * cookie sessions. Every call sends credentials; 401 anywhere but the auth
 * endpoints bounces to /login.
 */
import type {
  Category,
  DashboardData,
  Email,
  LoginInput,
  PlanTier,
  ResetPasswordInput,
  ResetRequestInput,
  SessionUser,
  SignupInput,
  VerifyEmailInput,
  Weekday,
} from "@pigeon/shared";

// Empty string = same-origin, which is what production (and the dev proxy
// configured in astro.config.mjs) both want. Only staging/cross-origin setups
// need PUBLIC_API_BASE.
export const API_BASE = import.meta.env.PUBLIC_API_BASE ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(
  path: string,
  init: RequestInit & { redirectOn401?: boolean } = {},
): Promise<T> {
  const { redirectOn401 = true, ...rest } = init;
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers:
      rest.body !== undefined
        ? { "content-type": "application/json", ...rest.headers }
        : rest.headers,
    ...rest,
  });
  if (res.status === 401 && redirectOn401 && typeof window !== "undefined") {
    window.location.href = "/login";
    throw new ApiError("session expired", 401);
  }
  if (!res.ok) {
    let message = `Pigeon API responded ${res.status}`;
    let code: string | undefined;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
      code = body?.code;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, res.status, code);
  }
  return (await res.json()) as T;
}

// ---- auth ------------------------------------------------------------

export const auth = {
  signup: (input: SignupInput) =>
    call<{ status: string }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify(input),
      redirectOn401: false,
    }),
  login: (input: LoginInput) =>
    call<{ user: SessionUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
      redirectOn401: false,
    }),
  logout: () => call<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () =>
    call<{ user: SessionUser }>("/api/auth/me", { redirectOn401: false }),
  verifyEmail: (token: string) =>
    call<{ user: SessionUser }>("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({ token } satisfies VerifyEmailInput),
      redirectOn401: false,
    }),
  resendVerify: (email: string) =>
    call<{ status: string }>("/api/auth/verify/resend", {
      method: "POST",
      body: JSON.stringify({ email }),
      redirectOn401: false,
    }),
  requestReset: (email: string) =>
    call<{ status: string }>("/api/auth/password/reset-request", {
      method: "POST",
      body: JSON.stringify({ email } satisfies ResetRequestInput),
      redirectOn401: false,
    }),
  resetPassword: (input: ResetPasswordInput) =>
    call<{ ok: true }>("/api/auth/password/reset", {
      method: "POST",
      body: JSON.stringify(input),
      redirectOn401: false,
    }),
};

// ---- dashboard -------------------------------------------------------

export function fetchDashboard(): Promise<DashboardData> {
  return call<DashboardData>("/api/dashboard");
}

// ---- emails ----------------------------------------------------------

/**
 * One keyset-paginated page of a single category's triaged emails (FR-13).
 * Omit `cursor` for the newest page; pass the previous response's
 * `nextCursor` to fetch the next. `nextCursor: null` means the category is
 * exhausted, which is what stops the feed's infinite scroll.
 */
export function fetchEmails(
  category: Category,
  cursor?: string,
): Promise<{ emails: Email[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ category });
  if (cursor) params.set("cursor", cursor);
  return call(`/api/emails?${params.toString()}`);
}

// ---- mailboxes -------------------------------------------------------

export const mailboxes = {
  create: (input: {
    provider: string;
    protocol: string;
    label: string;
    address: string;
    host: string;
    port: number;
    tls: boolean;
    username: string;
    password: string;
  }) =>
    call<{ mailbox: unknown }>("/api/mailboxes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    call<{ ok: true }>(`/api/mailboxes/${id}`, { method: "DELETE" }),
  syncNow: (id: string) =>
    call<{ ok: true }>(`/api/mailboxes/${id}/sync`, { method: "POST" }),
};

// ---- channels & delivery settings -------------------------------------

export const channels = {
  create: (input: {
    kind: string;
    label: string;
    config: Record<string, string>;
    minCategory: Category;
  }) =>
    call<{ channel: unknown }>("/api/channels", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (
    id: string,
    patch: {
      label?: string;
      enabled?: boolean;
      minCategory?: Category;
      config?: Record<string, string>;
    },
  ) =>
    call<{ channel: unknown }>(`/api/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    call<{ ok: true }>(`/api/channels/${id}`, { method: "DELETE" }),
  test: (id: string) =>
    call<{ ok: true }>(`/api/channels/${id}/test`, { method: "POST" }),
  supported: () =>
    call<{ channels: unknown[]; supportedKinds: string[] }>(
      "/api/channels",
    ).then((r) => r.supportedKinds),
};

export const deliverySettings = {
  update: (patch: {
    digestEnabled?: boolean;
    digestTime?: string;
    digestDays?: Weekday[];
    digestChannelId?: string;
    timezone?: string;
    quietReassurance?: boolean;
  }) =>
    call<{ settings: unknown }>("/api/settings/delivery", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};

// ---- profile / AI instructions ----------------------------------------

export interface Profile {
  name: string;
  email: string;
  tier: string;
}

export const profile = {
  get: () =>
    call<{ profile: Profile }>("/api/settings/profile").then((r) => r.profile),
  update: (patch: { name?: string }) =>
    call<{ profile: Profile }>("/api/settings/profile", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => r.profile),
};

// ---- usage & billing ---------------------------------------------------

export interface UsageReport {
  tier: string;
  period: string;
  usage: { mailboxes: number; emailsProcessed: number };
  limits: {
    tier: PlanTier;
    name: string;
    priceLabel: string | null;
    maxMailboxes: number;
    syncIntervalMs: number;
    monthlyEmailQuota: number;
  };
  tiers: UsageReport["limits"][];
}

export const billing = {
  usage: () => call<UsageReport>("/api/usage"),
  state: () =>
    call<{ tier: string; subscription: unknown; mode: "mollie" | "sandbox" }>(
      "/api/billing",
    ),
  checkout: (tier: "pro" | "team") =>
    call<
      | { mode: "checkout"; checkoutUrl: string }
      | { mode: "sandbox"; tier: string }
    >("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ tier }),
    }),
  cancel: () =>
    call<{ outcome: string }>("/api/billing/subscription", {
      method: "DELETE",
    }),
};

// ---- privacy -----------------------------------------------------------

export const privacy = {
  consents: () => call<{ consents: unknown[] }>("/api/privacy/consents"),
  exportUrl: `${API_BASE}/api/privacy/export`,
  erase: (password: string) =>
    call<{ ok: true }>("/api/privacy/erase", {
      method: "POST",
      body: JSON.stringify({ password, confirm: "delete my account" }),
      redirectOn401: false,
    }),
};

// ---- oauth ---------------------------------------------------------------

export interface OAuthProviderInfo {
  id: string;
  displayName: string;
  providerBadge: string;
}

export const oauth = {
  providers: () =>
    call<{ providers: OAuthProviderInfo[] }>("/api/oauth/providers").then(
      (r) => r.providers,
    ),
  startUrl: (id: string) => `${API_BASE}/api/oauth/${id}/start`,
};
