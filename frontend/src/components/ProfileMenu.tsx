import type { JSX } from "solid-js";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { User } from "@pigeon/shared";
import { auth } from "../lib/api";
import { HelpIcon, initialsOf, LogOutIcon, SparklesIcon } from "./visuals";

/**
 * The account popover behind the top-right avatar. Shows who you are, the
 * plan you're on (with renewal + inbox usage), and account actions.
 * General settings are opened from the dedicated top-bar cog.
 */
export default function ProfileMenu(props: {
  user: User;
  /** How many inboxes are currently connected, for the usage line. */
  inboxCount: number;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);

  const plan = () => props.user.plan;
  const limit = () => plan().inboxLimit;
  const usedFraction = () => {
    const max = limit();
    if (max == null || max === 0) return 0;
    return Math.min(1, props.inboxCount / max);
  };

  function close() {
    setOpen(false);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
  // Register on the client only — Astro server-renders this component, where
  // `document` doesn't exist.
  onMount(() => {
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <div class="profile">
      <button
        class="avatar avatar-me"
        aria-label="Your account"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
      >
        {initialsOf(props.user.name)}
      </button>

      <Show when={open()}>
        {/* transparent catch-all so any outside click dismisses the menu */}
        <div class="menu-backdrop" onClick={close} />

        <div class="profile-pop rise" role="menu">
          {/* identity */}
          <div class="profile-head">
            <div class="avatar avatar-me profile-avatar">
              {initialsOf(props.user.name)}
            </div>
            <div class="profile-id">
              <div class="profile-name">{props.user.name}</div>
              <div class="profile-email">{props.user.email}</div>
            </div>
          </div>

          {/* plan */}
          <div class="profile-plan">
            <div class="profile-plan-row">
              <span class="profile-plan-name">{plan().name} plan</span>
              <Show when={plan().price}>
                <span class="profile-plan-price">{plan().price}</span>
              </Show>
            </div>

            <Show when={plan().nextBillingDate}>
              <div class="profile-plan-meta">
                Renews {plan().nextBillingDate}
              </div>
            </Show>

            <Show when={limit() != null}>
              <div class="usage">
                <div class="usage-track">
                  <div
                    class="usage-fill"
                    style={{ width: `${usedFraction() * 100}%` }}
                  />
                </div>
                <div class="usage-label">
                  {props.inboxCount} of {limit()} inboxes
                </div>
              </div>
            </Show>

            <Show when={plan().canUpgrade}>
              <a
                class="btn btn-primary upgrade-btn"
                href="/billing"
                onClick={close}
              >
                <SparklesIcon />
                Upgrade plan
              </a>
            </Show>
          </div>

          {/* actions */}
          <div class="profile-menu">
            <a
              class="profile-item"
              role="menuitem"
              href="/billing"
              onClick={close}
            >
              <SparklesIcon />
              Plan &amp; billing
            </a>
            <a
              class="profile-item"
              role="menuitem"
              href="/privacy"
              onClick={close}
            >
              <HelpIcon />
              Privacy &amp; data
            </a>
            <button
              class="profile-item danger"
              role="menuitem"
              onClick={() =>
                void auth.logout().finally(() => {
                  window.location.href = "/login";
                })
              }
            >
              <LogOutIcon />
              Log out
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
