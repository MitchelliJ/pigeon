import type { JSX } from "solid-js";
import { createResource, Match, onCleanup, onMount, Switch } from "solid-js";
import { ApiError, fetchDashboard } from "../lib/api";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import Hero from "./Hero";
import StatCard from "./StatCard";
import EmailList from "./EmailList";

export default function Dashboard(): JSX.Element {
  const [data, { refetch }] = createResource(async () => {
    try {
      return await fetchDashboard();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 401 &&
        typeof window !== "undefined"
      ) {
        window.location.href = "/login";
      }
      throw err;
    }
  });

  // Keep the feed fresh: syncs and triage happen in the background worker.
  onMount(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refetch();
    }, 30_000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <Switch>
      <Match when={data.loading}>
        <div class="state">
          <div class="spinner" />
          <div class="state-title">Gathering your inboxes…</div>
        </div>
      </Match>

      <Match when={data.error}>
        <div class="state">
          <div class="state-title">Couldn't reach the Pigeon API</div>
          <p>
            Make sure the backend is running: <code>pnpm dev:server</code> (or
            just <code>pnpm dev</code>).
          </p>
        </div>
      </Match>

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
                channels={d().channels}
                digest={d().digest}
                lastSync={d().lastSync}
                onChanged={() => void refetch()}
              />
            </div>
          </>
        )}
      </Match>
    </Switch>
  );
}
