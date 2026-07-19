import type { JSX } from "solid-js";
import { createResource, createSignal, For, Show } from "solid-js";
import { ApiError, billing } from "../lib/api";
import { NotificationProvider, useNotifications } from "./Notifications";

function pct(used: number, max: number): string {
  if (max <= 0) return "0%";
  return `${Math.min(100, Math.round((used / max) * 100))}%`;
}

function syncLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${minutes / 60}h` : `${minutes} min`;
}

export default function BillingPanel(): JSX.Element {
  return (
    <NotificationProvider>
      <BillingPanelContent />
    </NotificationProvider>
  );
}

function BillingPanelContent(): JSX.Element {
  const notifications = useNotifications();
  const [report, { refetch }] = createResource(() =>
    billing.usage().catch((err) => {
      if (
        err instanceof ApiError &&
        err.status === 401 &&
        typeof window !== "undefined"
      ) {
        window.location.href = "/login";
      }
      throw err;
    }),
  );
  const [busyTier, setBusyTier] = createSignal<string | null>(null);

  async function choose(tier: string) {
    setBusyTier(tier);
    try {
      let successMessage: string;
      if (tier === "free") {
        await billing.cancel();
        successMessage = "Plan changed to Free.";
      } else {
        const result = await billing.checkout(tier as "pro" | "team");
        if (result.mode === "checkout") {
          window.location.href = result.checkoutUrl;
          return;
        }
        successMessage = `Plan changed to ${tier} in sandbox mode.`;
      }
      notifications.success(successMessage);
      try {
        await refetch();
      } catch {
        notifications.info(
          "Your plan changed, but the displayed usage could not be refreshed.",
        );
      }
    } catch (error) {
      notifications.error(
        error instanceof ApiError ? error.message : "Could not change plans.",
      );
    } finally {
      setBusyTier(null);
    }
  }

  return (
    <div class="page-wrap">
      <a class="page-back" href="/">
        ← Back to dashboard
      </a>
      <h1 class="page-title">Plan &amp; billing</h1>

      <Show
        when={report()}
        fallback={
          <div class="state">
            <div class="spinner" />
          </div>
        }
      >
        {(r) => (
          <>
            <section class="card page-card">
              <div class="card-head">
                <span class="card-title">This month ({r().period})</span>
              </div>
              <div class="usage" style={{ "margin-bottom": "14px" }}>
                <div class="usage-label">
                  {r().usage.emailsProcessed} of {r().limits.monthlyEmailQuota}{" "}
                  emails summarized
                </div>
                <div class="usage-track">
                  <div
                    class="usage-fill"
                    style={{
                      width: pct(
                        r().usage.emailsProcessed,
                        r().limits.monthlyEmailQuota,
                      ),
                    }}
                  />
                </div>
              </div>
              <div class="usage">
                <div class="usage-label">
                  {r().usage.mailboxes} of {r().limits.maxMailboxes} inboxes
                  connected
                </div>
                <div class="usage-track">
                  <div
                    class="usage-fill"
                    style={{
                      width: pct(r().usage.mailboxes, r().limits.maxMailboxes),
                    }}
                  />
                </div>
              </div>
            </section>

            <div class="plans">
              <For each={r().tiers}>
                {(tier) => {
                  const current = () => tier.tier === r().tier;
                  return (
                    <section
                      class="card plan-card"
                      classList={{ "plan-current": current() }}
                    >
                      <div class="plan-name">{tier.name}</div>
                      <div class="plan-price">{tier.priceLabel ?? "€0"}</div>
                      <ul class="plan-features">
                        <li>
                          {tier.maxMailboxes} inbox
                          {tier.maxMailboxes === 1 ? "" : "es"}
                        </li>
                        <li>sync every {syncLabel(tier.syncIntervalMs)}</li>
                        <li>
                          {tier.monthlyEmailQuota.toLocaleString()} emails /
                          month
                        </li>
                      </ul>
                      <button
                        class="btn"
                        classList={{ "btn-primary": !current() }}
                        disabled={current() || busyTier() !== null}
                        onClick={() => void choose(tier.tier)}
                      >
                        {current()
                          ? "Current plan"
                          : busyTier() === tier.tier
                            ? "One moment…"
                            : tier.tier === "free"
                              ? "Downgrade"
                              : `Switch to ${tier.name}`}
                      </button>
                    </section>
                  );
                }}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
