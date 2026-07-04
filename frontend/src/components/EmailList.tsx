import type { JSX } from "solid-js";
import { createMemo, createSignal, For } from "solid-js";
import type { Email, EmailAccount } from "@pigeon/shared";
import { PRIORITY_ORDER } from "@pigeon/shared";
import EmailRow from "./EmailRow";

type Filter = "urgent" | "important" | "everything";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "urgent", label: "Urgent" },
  { key: "important", label: "Important" },
  { key: "everything", label: "Everything else" },
];

export default function EmailList(props: {
  emails: Email[];
  accounts: EmailAccount[];
}): JSX.Element {
  const [filter, setFilter] = createSignal<Filter>("urgent");

  const accountById = createMemo(() => {
    const map = new Map<string, EmailAccount>();
    for (const a of props.accounts) map.set(a.id, a);
    return map;
  });

  const visible = createMemo(() => {
    const f = filter();
    return props.emails
      .filter((e) => e.priority === f)
      .sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);
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
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            )}
          </For>
        </div>
        <span class="filterbar-meta">{visible().length} messages</span>
      </div>

      {/* table */}
      <div class="email-table">
        <For
          each={visible()}
          fallback={
            <div class="empty">
              <div class="empty-title">Nothing here ✨</div>
              <p>You've cleared everything in this view.</p>
            </div>
          }
        >
          {(email, i) => (
            <EmailRow
              email={email}
              account={accountById().get(email.accountId)}
              index={i()}
            />
          )}
        </For>
      </div>
    </section>
  );
}
