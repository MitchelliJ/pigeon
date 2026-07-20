// Pure compile-time contract test for the dashboard onboarding phase shared
// types.
//
// This is a `.test-d.ts` file (NOT a `.test.ts` file): the root Vitest config
// only includes the shared test glob (see root vitest.config), so this file
// is never executed. It is type-checked by `pnpm --filter @pigeon/shared
// typecheck` because `shared/tsconfig.json` has `include: ["src"]`. No
// `vitest` import, no runtime, no `describe`/`it` — just assignments and
// `@ts-expect-error` directives that prove the interface has exactly the
// required shape.

import type { DashboardData, OnboardingPhase } from "../index";

// OnboardingPhase — the four dashboard onboarding states.
const _phaseImporting: OnboardingPhase = "importing";
const _phaseSummarizing: OnboardingPhase = "summarizing";
const _phaseError: OnboardingPhase = "error";
const _phaseReady: OnboardingPhase = "ready";

// @ts-expect-error "syncing" is a mailbox status, not a dashboard onboarding phase
const _phaseSyncing: OnboardingPhase = "syncing";

// @ts-expect-error arbitrary strings must not be onboarding phases
const _phaseUnknown: OnboardingPhase = "waiting";

// DashboardData — requires onboardingPhase with the OnboardingPhase contract.
const _dashboardComplete: DashboardData = {
  user: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    plan: {
      tier: "pro",
      name: "Pro",
      price: "€8 / mo",
      inboxLimit: 5,
      nextBillingDate: "July 1, 2026",
      canUpgrade: true,
    },
  },
  stats: {
    requires_action: 1,
    important: 2,
    noise: 3,
  },
  emails: [],
  accounts: [],
  channel: null,
  digest: {
    mode: "daily",
    digestTime: "08:00",
    digestDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    timezone: "Europe/Amsterdam",
    lastSuccessfulDigestAt: null,
  },
  lastSync: "2m ago",
  onboardingPhase: "ready",
};

// @ts-expect-error DashboardData must include onboardingPhase
const _dashboardMissingOnboardingPhase: DashboardData = {
  user: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    plan: {
      tier: "pro",
      name: "Pro",
      price: "€8 / mo",
      inboxLimit: 5,
      nextBillingDate: "July 1, 2026",
      canUpgrade: true,
    },
  },
  stats: {
    requires_action: 1,
    important: 2,
    noise: 3,
  },
  emails: [],
  accounts: [],
  channel: null,
  digest: {
    mode: "daily",
    digestTime: "08:00",
    digestDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    timezone: "Europe/Amsterdam",
    lastSuccessfulDigestAt: null,
  },
  lastSync: "2m ago",
};

const _dashboardInvalidOnboardingPhase: DashboardData = {
  ..._dashboardComplete,
  // @ts-expect-error DashboardData rejects invalid onboarding phase strings
  onboardingPhase: "syncing",
};
