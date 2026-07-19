/**
 * Shared domain types for Pigeon.
 *
 * These describe the shape of the data that flows between the backend
 * (`@pigeon/backend`) and the frontend (`@pigeon/frontend`). Imported
 * type-only on both sides, so there is no runtime coupling.
 */

/**
 * How Pigeon triages an email:
 * - `requires_action` — needs a human reply or decision.
 * - `important` — worth knowing about (FYI), but no action required.
 * - `noise` — status updates, newsletters, and other low-signal mail.
 */
export type Category = "requires_action" | "important" | "noise";

/** Email providers we know how to render a badge / connect flow for. */
export type Provider =
  "gmail" | "outlook" | "icloud" | "fastmail" | "imap" | "mock";

/** A connected mailbox, reached over IMAP/POP3 with an app password. */
export interface EmailAccount {
  id: string;
  provider: Provider;
  /** Friendly label, e.g. "Personal" or "Work". */
  label: string;
  address: string;
  protocol: "imap" | "pop3" | "mock" | "gmail-oauth" | "microsoft-oauth";
  status: "connected" | "syncing" | "disconnected" | "error";
  /** Number of unread messages currently in this mailbox. */
  unread: number;
}

/** A single triaged email with its AI summary. */
export interface Email {
  id: string;
  accountId: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  /** One-sentence, LLM-generated gist of the message. */
  summary: string;
  /** Full plain-text body of the email, shown when the row is expanded. */
  body: string;
  category: Category;
  /** Short relative string, e.g. "12m ago". */
  receivedAt: string;
  /** True when Pigeon thinks this genuinely needs a human reply/decision. */
  needsAttention: boolean;
  /** Suggested inline action label for requires_action items, e.g. "Reply now". */
  suggestedAction?: string;
}

/** Messaging services exposed to the shipped channel UI. */
export type ChannelKind = "discord";

/** A configured notification channel, with secrets intentionally omitted. */
export interface Channel {
  id: string;
  kind: ChannelKind;
  status: "active" | "error";
  /** User-safe connection error, never a webhook URL or provider secret. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Short day-of-week labels, Monday first. */
export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export const WEEKDAYS: Weekday[] = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
];

/** Mutually exclusive delivery policies for channel notifications. */
export type DeliveryMode = "daily" | "quiet";

/** UTC delivery settings and the last successful daily digest state. */
export interface Digest {
  mode: DeliveryMode;
  /** 24h UTC time string, e.g. "08:00". */
  digestTime: string;
  /** Days of the week the digest is sent. */
  digestDays: readonly Weekday[];
  timezone: "UTC";
  lastSuccessfulDigestAt: string | null;
}

/** Counts that drive the category stat cards. */
export interface Stats {
  requires_action: number;
  important: number;
  noise: number;
}

/** Subscription tiers, cheapest → most capable. */
export type PlanTier = "free" | "pro" | "team";

/** The subscription the signed-in user is on. */
export interface Plan {
  tier: PlanTier;
  /** Display name, e.g. "Free" or "Pro". */
  name: string;
  /** Monthly price label, e.g. "€8 / mo". null on the free tier. */
  price: string | null;
  /** Max inboxes this plan allows. null = unlimited. */
  inboxLimit: number | null;
  /** Friendly next billing date, e.g. "July 1, 2026". null on the free tier. */
  nextBillingDate: string | null;
  /** True when a higher tier exists to upgrade to. */
  canUpgrade: boolean;
}

/** The signed-in person. */
export interface User {
  name: string;
  email: string;
  plan: Plan;
}

/** The signed-in user as surfaced to the client after authentication. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  tier: string;
}

/** Sign-up request body. `name` is REQUIRED. */
export interface SignupInput {
  inviteCode: string;
  email: string;
  password: string;
  name: string;
}

/** Login request body — email + password only. */
export interface LoginInput {
  email: string;
  password: string;
}

/** Body for verifying an email address from a signup token. */
export interface VerifyEmailInput {
  token: string;
}

/** Body for requesting a password reset email. */
export interface ResetRequestInput {
  email: string;
}

/** Body for actually resetting a password with a token. */
export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

/** Everything the dashboard needs, in one payload. */
export interface DashboardData {
  /** The signed-in user — drives the hero greeting and profile menu. */
  user: User;
  stats: Stats;
  emails: Email[];
  accounts: EmailAccount[];
  channel: Channel | null;
  digest: Digest;
  /**
   * When all mailboxes were last synced. Sync runs on a single global
   * schedule for every inbox, not per-mailbox. Short relative string,
   * e.g. "2m ago".
   */
  lastSync: string;
}

export const CATEGORY_ORDER: Record<Category, number> = {
  requires_action: 3,
  important: 2,
  noise: 1,
};

/** Hard limits per subscription tier — enforced server-side, shown in the UI. */
export interface TierLimits {
  tier: PlanTier;
  name: string;
  /** Monthly price in euro cents; 0 on the free tier. */
  priceCents: number;
  priceLabel: string | null;
  /** Max connected mailboxes. */
  maxMailboxes: number;
  /** How often each mailbox syncs. */
  syncIntervalMs: number;
  /** Max LLM-processed emails per calendar month. */
  monthlyEmailQuota: number;
}

export const TIERS: Record<PlanTier, TierLimits> = {
  free: {
    tier: "free",
    name: "Free",
    priceCents: 0,
    priceLabel: null,
    maxMailboxes: 1,
    syncIntervalMs: 30 * 60 * 1000,
    monthlyEmailQuota: 200,
  },
  pro: {
    tier: "pro",
    name: "Pro",
    priceCents: 800,
    priceLabel: "€8 / mo",
    maxMailboxes: 5,
    syncIntervalMs: 5 * 60 * 1000,
    monthlyEmailQuota: 5000,
  },
  team: {
    tier: "team",
    name: "Team",
    priceCents: 2000,
    priceLabel: "€20 / mo",
    maxMailboxes: 15,
    syncIntervalMs: 60 * 1000,
    monthlyEmailQuota: 20000,
  },
};

export function tierLimits(tier: string): TierLimits {
  return TIERS[(tier as PlanTier) in TIERS ? (tier as PlanTier) : "free"];
}
