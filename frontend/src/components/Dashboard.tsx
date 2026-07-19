import type { JSX } from "solid-js";
import { createSignal, Match, onCleanup, onMount, Switch } from "solid-js";
import type { DashboardData } from "@pigeon/shared";
import { ApiError, fetchDashboard } from "../lib/api";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import Hero from "./Hero";
import StatCard from "./StatCard";
import EmailList from "./EmailList";

export default function Dashboard(): JSX.Element {
  const [data, setData] = createSignal<DashboardData | null>(null);
  const [failed, setFailed] = createSignal(false);
  let inFlight = false;

  // Refreshes swap data in beneath the mounted dashboard: no loading screen,
  // so open dialogs, expanded rows, and scroll position all survive a poll.
  // A failed background refresh keeps the stale view and retries on the next
  // tick; only a failed *first* load shows the error screen. On 401 api.ts
  // has already started the redirect to /login, so we just stay quiet.
  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      setData(await fetchDashboard());
      setFailed(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      if (data() === null) setFailed(true);
    } finally {
      inFlight = false;
    }
  }

  // Keep the feed fresh: syncs and triage happen in the background worker.
  // A self-rescheduling timer (rather than a fixed setInterval) lets a
  // visibility-triggered refresh reset the 30s window, so returning to the tab
  // just as a tick was due doesn't fire two refreshes back to back. Polls are
  // skipped while the tab is hidden and resume on the next visible tick.
  onMount(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      timer = setTimeout(tick, 30_000);
    };
    const tick = () => {
      if (!document.hidden) void refresh();
      scheduleNext();
    };
    const onVisibility = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      void refresh();
      scheduleNext();
    };

    void refresh();
    scheduleNext();
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    });
  });

  return (
    <Switch>
      <Match when={data()}>
        {(d) => (
          <>
            <TopBar
              user={d().user}
              alerts={d().stats.requires_action}
              inboxCount={d().accounts.length}
            />
            <div class="app">
              <main class="main">
                <Hero name={d().user.name} stats={d().stats} />

                <section class="stats">
                  <StatCard
                    tone="requires_action"
                    label="Requires action"
                    count={d().stats.requires_action}
                    desc="Needs you now"
                    delay={80}
                  />
                  <StatCard
                    tone="important"
                    label="Important"
                    count={d().stats.important}
                    desc="Worth a look today"
                    delay={140}
                  />
                  <StatCard
                    tone="noise"
                    label="Noise"
                    count={d().stats.noise}
                    desc="Newsletters & receipts"
                    delay={200}
                  />
                </section>

                <EmailList emails={d().emails} accounts={d().accounts} />
              </main>

              <Sidebar
                accounts={d().accounts}
                channel={d().channel}
                digest={d().digest}
                lastSync={d().lastSync}
                onChanged={() => void refresh()}
              />
            </div>
          </>
        )}
      </Match>

      <Match when={failed()}>
        <div class="state">
          <div class="state-title">Couldn't reach the Pigeon API</div>
          <p>
            Make sure the backend is running: <code>pnpm dev:server</code> (or
            just <code>pnpm dev</code>).
          </p>
        </div>
      </Match>

      <Match when={true}>
        <div class="state">
          <div class="spinner" />
          <div class="state-title">Gathering your inboxes…</div>
        </div>
      </Match>
    </Switch>
  );
}
