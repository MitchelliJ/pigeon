import type { JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Switch,
  untrack,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { Email, EmailAccount, OnboardingPhase } from "@pigeon/shared";
import { CATEGORY_ORDER } from "@pigeon/shared";
import { fetchEmails } from "../lib/api";
import { emptyStateForPhase, filterbarMetaText } from "../lib/onboarding-ui";
import EmailRow from "./EmailRow";

type Filter = "requires_action" | "important" | "noise";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "requires_action", label: "Requires action" },
  { key: "important", label: "Important" },
  { key: "noise", label: "Noise" },
];

/** Rows per page — matches the backend's default `limit` (FR-13/FR-18). */
const PAGE_SIZE = 10;

/**
 * What we track for each category tab so infinite scroll can page through it
 * independently:
 * - `emails`      — the rows loaded so far, oldest fetch first.
 * - `nextCursor`  — opaque cursor for the next page, or `null` when exhausted.
 * - `initialized` — has this category done its own real fetch yet? Until it
 *   has, we don't know its true `nextCursor`, so the first scroll fetches
 *   page 1 fresh to learn it.
 * - `loading`     — a fetch is in flight; guards against duplicate concurrent
 *   fetches for the same category.
 */
interface CategoryState {
  emails: Email[];
  nextCursor: string | null;
  initialized: boolean;
  loading: boolean;
}

/** A category that hasn't been opened yet. */
function emptyState(): CategoryState {
  return { emails: [], nextCursor: null, initialized: false, loading: false };
}

export default function EmailList(props: {
  emails: Email[];
  accounts: EmailAccount[];
  onboardingPhase: OnboardingPhase;
  timezone: string;
}): JSX.Element {
  const [filter, setFilter] = createSignal<Filter>("requires_action");

  // Per-category cache for the component's lifetime (no cross-reload persistence
  // needed). `requires_action` is the default tab and its first page already
  // arrived in `props.emails` (FR-12), so we seed it and never fetch on initial
  // load (FR-18). If the dashboard returned a full page there may be more, so we
  // leave it uninitialized — the first scroll-to-bottom does one fresh fetch to
  // learn the real cursor. A short page means it's already exhausted, so we mark
  // it initialized and never fetch.
  // One-time snapshot of the first page taken at setup. `untrack` makes the
  // untracked read explicit: this seed deliberately does not react to later
  // `props.emails` changes — re-fetches go through the pagination logic instead.
  const initialEmails = untrack(() => props.emails);
  const [store, setStore] = createStore<Record<Filter, CategoryState>>({
    requires_action: {
      emails: initialEmails,
      nextCursor: null,
      initialized: initialEmails.length < PAGE_SIZE,
      loading: false,
    },
    important: emptyState(),
    noise: emptyState(),
  });

  // Which rows are expanded, tracked here (keyed by email id) rather than
  // inside each EmailRow, so expansion survives the reconcile fold below: a row
  // that stays present keeps its DOM and its expanded state across a poll.
  const [expandedIds, setExpandedIds] = createSignal<Set<string>>(new Set());
  function toggleExpanded(id: string): void {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // The list container, so the fold can tell when the user is actively
  // keyboard-navigating inside it (focus within) and hold off.
  let listEl: HTMLDivElement | undefined;

  // Background dashboard polls hand us a fresh first page via `props.emails`
  // (the dashboard stays mounted across refreshes, so the seed above only ever
  // runs once). Fold each new page into the default tab: reconcile keyed by id
  // leaves unchanged rows' DOM — and their expanded state — untouched.
  //
  // The fold is held off while the user is mid-interaction with this tab, so a
  // poll never yanks the list out from under them:
  //  - a fetch is in flight;
  //  - they've paged deeper (replacing pages 2+ with page 1 would jump scroll);
  //  - a row is expanded (reconcile could remove the very row being read if a
  //    newer email pushed it off the fresh first page);
  //  - focus is inside the list (a keyboard user navigating rows).
  // In all those cases we skip this poll's data and fold the next one instead.
  //
  // Cursor semantics after the swap match the seed's: a full page leaves the
  // tab uninitialized so the first scroll learns the real cursor, a short page
  // means the category is exhausted.
  createEffect(
    on(
      () => props.emails,
      (emails) => {
        const s = store.requires_action;
        if (s.loading || s.emails.length > PAGE_SIZE) return;
        if (expandedIds().size > 0) return;
        if (listEl && listEl.contains(document.activeElement)) return;
        setStore("requires_action", "emails", reconcile(emails, { key: "id" }));
        setStore("requires_action", {
          nextCursor: null,
          initialized: emails.length < PAGE_SIZE,
        });
      },
      { defer: true },
    ),
  );

  const active = (): CategoryState => store[filter()];

  const accountById = createMemo(() => {
    const map = new Map<string, EmailAccount>();
    for (const a of props.accounts) map.set(a.id, a);
    return map;
  });

  // Each fetched page already arrives newest-first from the backend; the sort is
  // kept so display order is unchanged from the previous implementation.
  const visible = createMemo(() =>
    active()
      .emails.slice()
      .sort((a, b) => CATEGORY_ORDER[b.category] - CATEGORY_ORDER[a.category]),
  );

  const phaseEmptyState = createMemo(() =>
    emptyStateForPhase(props.onboardingPhase, visible().length),
  );

  /** Fetch page 1 fresh, reconciling it over whatever the category holds. */
  async function loadFirstPage(category: Filter): Promise<void> {
    if (store[category].loading) return;
    setStore(category, "loading", true);
    try {
      const page = await fetchEmails(category);
      // Reconcile (not replace) by id so rows unchanged since the last fetch
      // keep their DOM and expanded state. This path re-runs on the default tab
      // whenever a full first page re-arms `initialized = false` and the user
      // scrolls to learn the cursor, so a plain array-replace here would wipe
      // row identity across the whole tab on every such refresh.
      setStore(category, "emails", reconcile(page.emails, { key: "id" }));
      setStore(category, {
        nextCursor: page.nextCursor,
        initialized: true,
        loading: false,
      });
    } catch {
      // Keep the existing rows; drop the flag so a later scroll can retry.
      setStore(category, "loading", false);
    }
  }

  /** Fetch the next page and append it. */
  async function loadNextPage(category: Filter): Promise<void> {
    const cursor = store[category].nextCursor;
    if (cursor === null || store[category].loading) return;
    setStore(category, "loading", true);
    try {
      const page = await fetchEmails(category, cursor);
      setStore(category, "emails", (prev) => [...prev, ...page.emails]);
      setStore(category, "nextCursor", page.nextCursor);
      setStore(category, "loading", false);
    } catch {
      setStore(category, "loading", false);
    }
  }

  function switchTo(category: Filter): void {
    setFilter(category);
    const s = store[category];
    // Load page 1 the first time a category with no rows is opened. This never
    // fires for the seeded `requires_action` tab (FR-18: no redundant fetch on
    // initial load), nor when switching back to an already-loaded tab (cache).
    if (!s.initialized && s.emails.length === 0) {
      void loadFirstPage(category);
    }
  }

  function loadMore(): void {
    const category = filter();
    const s = store[category];
    if (s.loading) return;
    if (!s.initialized) {
      // Seeded but cursor unknown (default tab): fetch page 1 to learn it.
      void loadFirstPage(category);
    } else if (s.nextCursor !== null) {
      void loadNextPage(category);
    }
    // Exhausted (`nextCursor === null`, initialized): stop — nothing to fetch.
  }

  // Infinite scroll: observe a sentinel just past the list. When it scrolls into
  // view (with a little lookahead), pull the next page for the active tab.
  let sentinel: HTMLDivElement | undefined;
  onMount(() => {
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) loadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    onCleanup(() => observer.disconnect());
  });

  return (
    <section>
      {/* filter bar */}
      <div class="filterbar">
        <div class="filterbar-tabs" role="tablist" aria-label="Filter emails">
          <For each={FILTERS}>
            {(f) => (
              <button
                class="filter-tab"
                classList={{ active: filter() === f.key }}
                role="tab"
                aria-selected={filter() === f.key}
                onClick={() => switchTo(f.key)}
              >
                {f.label}
              </button>
            )}
          </For>
        </div>
        <span class="filterbar-meta">
          {filterbarMetaText(props.onboardingPhase, visible().length)}
        </span>
      </div>

      {/* table */}
      <div class="email-table" ref={(el) => (listEl = el)}>
        <Switch>
          <Match when={visible().length > 0}>
            <For each={visible()}>
              {(email, i) => (
                <EmailRow
                  email={email}
                  account={accountById().get(email.accountId)}
                  index={i()}
                  timezone={props.timezone}
                  expanded={expandedIds().has(email.id)}
                  onToggle={() => toggleExpanded(email.id)}
                />
              )}
            </For>
          </Match>
          <Match when={active().loading}>
            <div class="state">
              <div class="spinner" />
            </div>
          </Match>
          <Match when={phaseEmptyState()}>
            {(state) => (
              <div class="empty">
                {state().showSpinner && <div class="spinner" />}
                <div class="empty-title">{state().title}</div>
                <p>{state().body}</p>
              </div>
            )}
          </Match>
          <Match when={true}>
            <div class="empty">
              <div class="empty-title">Nothing here ✨</div>
              <p>You've cleared everything in this view.</p>
            </div>
          </Match>
        </Switch>
        <div
          ref={(el) => (sentinel = el)}
          class="scroll-sentinel"
          style={{ height: "1px" }}
          aria-hidden="true"
        />
      </div>
    </section>
  );
}
