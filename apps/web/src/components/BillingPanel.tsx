import type { JSX } from "solid-js";
import { createResource, createSignal, For, Show } from "solid-js";
import { ApiError, billing } from "../lib/api";

function pct(used: number, max: number): string {
  if (max <= 0) return "0%";
  return `${Math.min(100, Math.round((used / max) * 100))}%`;
}

function syncLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${minutes / 60}h` : `${minutes} min`;
}

export default function BillingPanel(): JSX.Element {
  const [report, { refetch }] = createResource(() =>
    billing.usage().catch((err) => {
      if (err instanceof ApiError && err.status === 401 && typeof window !== "undefined") {
        window.location.href = "/login";
      }
      throw err;
    }),
  );
  const [busyTier, setBusyTier] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  async function choose(tier: string) {
    setBusyTier(tier);
    setNotice(null);
    try {
      if (tier === "free") {
        await billing.cancel();
        setNotice("Downgraded to Free.");
      } else {
        const result = await billing.checkout(tier as "pro" | "team");
        if (result.mode === "checkout") {
          window.location.href = result.checkoutUrl;
          return;
        }
        setNotice(`You're on ${tier} now (sandbox mode — no payment provider configured).`);
      }
      await refetch();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusyTier(null);
    }
  }

  return (
    <div class="page-wrap">
      <a class="page-back" href="/">← Back to dashboard</a>
      <h1 class="page-title">Plan &amp; billing</h1>

      <Show when={report()} fallback={<div class="state"><div class="spinner" /></div>}>
        {(r) => (
          <>
            <section class="card page-card">
              <div class="card-head">
                <span class="card-title">This month ({r().period})</span>
              </div>
              <div class="usage" style={{ "margin-bottom": "14px" }}>
                <div class="usage-label">
                  {r().usage.emailsProcessed} of {r().limits.monthlyEmailQuota} emails summarized
                </div>
                <div class="usage-track">
                  <div
                    class="usage-fill"
                    style={{ width: pct(r().usage.emailsProcessed, r().limits.monthlyEmailQuota) }}
                  />
                </div>
              </div>
              <div class="usage">
                <div class="usage-label">
                  {r().usage.mailboxes} of {r().limits.maxMailboxes} inboxes connected
                </div>
                <div class="usage-track">
                  <div
                    class="usage-fill"
                    style={{ width: pct(r().usage.mailboxes, r().limits.maxMailboxes) }}
                  />
                </div>
              </div>
            </section>

            <Show when={notice()}>
              <p class="hint page-notice">{notice()}</p>
            </Show>

            <div class="plans">
              <For each={r().tiers}>
                {(tier) => {
                  const current = () => tier.tier === r().tier;
                  return (
                    <section class="card plan-card" classList={{ "plan-current": current() }}>
                      <div class="plan-name">{tier.name}</div>
                      <div class="plan-price">{tier.priceLabel ?? "€0"}</div>
                      <ul class="plan-features">
                        <li>{tier.maxMailboxes} inbox{tier.maxMailboxes === 1 ? "" : "es"}</li>
                        <li>sync every {syncLabel(tier.syncIntervalMs)}</li>
                        <li>{tier.monthlyEmailQuota.toLocaleString()} emails / month</li>
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
