import type { JSX } from "solid-js";
import type { User } from "@pigeon/shared";
import { GearIcon } from "./visuals";
import ProfileMenu from "./ProfileMenu";

export default function TopBar(props: {
  user: User;
  inboxCount: number;
  onOpenSettings: () => void;
}): JSX.Element {
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <div class="topbar-brand">
          <div class="brand-mark">🕊️</div>
          <span class="brand-name">Pigeon</span>
        </div>

        <div class="topbar-actions">
          <button
            id="settings-trigger"
            type="button"
            class="icon-btn"
            aria-label="Settings"
            title="Settings"
            onClick={() => props.onOpenSettings()}
          >
            <GearIcon />
          </button>
          <ProfileMenu user={props.user} inboxCount={props.inboxCount} />
        </div>
      </div>
    </header>
  );
}
