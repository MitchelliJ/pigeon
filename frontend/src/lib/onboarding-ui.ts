/**
 * Pure onboarding UI helpers shared by dashboard components.
 *
 * The copy and polling constants live here so phase rendering stays consistent
 * without depending on browser APIs.
 */
import type { OnboardingPhase } from "@pigeon/shared";

export const FAST_POLL_MS = 2_000;
export const NORMAL_POLL_MS = 30_000;
export const FAST_POLL_CAP_MS = 10 * 60 * 1000;

interface EmptyState {
  title: string;
  body: string;
  showSpinner: boolean;
}

type ActiveOnboardingPhase = Exclude<OnboardingPhase, "ready">;

interface PhaseCopy {
  meta: string;
  emptyState: EmptyState;
}

const IMPORTING_TITLE = "Importing your email…";
const SUMMARIZING_TITLE = "Summarizing your email…";

const PHASE_COPY = {
  importing: {
    meta: IMPORTING_TITLE,
    emptyState: {
      title: IMPORTING_TITLE,
      body: "We're fetching the last 7 days of email from your mailbox. This usually takes a minute or two.",
      showSpinner: true,
    },
  },
  summarizing: {
    meta: SUMMARIZING_TITLE,
    emptyState: {
      title: SUMMARIZING_TITLE,
      body: "Pigeon is reading your email and writing one-sentence summaries. They'll appear here as they're ready.",
      showSpinner: true,
    },
  },
  error: {
    meta: "Couldn't sync your mailbox",
    emptyState: {
      title: "We couldn't reach your mailbox",
      body: "Double-check the email address and app password, then remove this mailbox and connect it again. Pigeon also retries automatically every few minutes.",
      showSpinner: false,
    },
  },
} satisfies Record<ActiveOnboardingPhase, PhaseCopy>;

function copyForPhase(phase: OnboardingPhase): PhaseCopy | null {
  if (phase === "ready") {
    return null;
  }

  return PHASE_COPY[phase];
}

export function phaseMetaText(phase: OnboardingPhase): string | null {
  return copyForPhase(phase)?.meta ?? null;
}

export function filterbarMetaText(
  phase: OnboardingPhase,
  visibleCount: number,
): string {
  return phaseMetaText(phase) ?? `${visibleCount} messages`;
}

export function emptyStateForPhase(
  phase: OnboardingPhase,
  visibleCount: number,
): EmptyState | null {
  if (visibleCount > 0) {
    return null;
  }

  return copyForPhase(phase)?.emptyState ?? null;
}

export function nextNonReadySinceMs(
  previousSinceMs: number | null,
  phase: OnboardingPhase,
  nowMs: number,
): number | null {
  if (phase === "ready") {
    return null;
  }

  return previousSinceMs ?? nowMs;
}

export function pollDelayMs(
  phase: OnboardingPhase,
  nonReadySinceMs: number | null,
  nowMs: number,
): number {
  if (phase === "ready") {
    return NORMAL_POLL_MS;
  }

  if (nonReadySinceMs === null) {
    return FAST_POLL_MS;
  }

  return nowMs - nonReadySinceMs < FAST_POLL_CAP_MS
    ? FAST_POLL_MS
    : NORMAL_POLL_MS;
}
