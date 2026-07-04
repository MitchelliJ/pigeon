import type { JSX } from "solid-js";
import { Show } from "solid-js";
import type { User } from "@pigeon/shared";
import { BellIcon } from "./visuals";
import ProfileMenu from "./ProfileMenu";

export default function TopBar(props: {
  user: User;
  alerts: number;
  inboxCount: number;
}): JSX.Element {
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <div class="topbar-brand">
          <div class="brand-mark">🕊️</div>
          <span class="brand-name">Pigeon</span>
        </div>

        <div class="topbar-actions">
          <button class="icon-btn" aria-label="Notifications">
            <BellIcon />
            <Show when={props.alerts > 0}>
              <span class="icon-badge">{props.alerts}</span>
            </Show>
          </button>
          <ProfileMenu user={props.user} inboxCount={props.inboxCount} />
        </div>
      </div>
    </header>
  );
}
