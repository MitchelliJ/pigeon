import type { JSX } from "solid-js";
import { Show } from "solid-js";
import type { Email, EmailAccount } from "@pigeon/shared";
import { formatDateTime } from "../lib/format";
import {
  avatarColor,
  initialsOf,
  providerName,
  providerVisual,
  SparklesIcon,
} from "./visuals";

export default function EmailRow(props: {
  email: Email;
  account: EmailAccount | undefined;
  index: number;
  timezone: string;
  // Expansion is controlled by the parent (keyed by email id) so it survives
  // the list's background reconcile — see EmailList's `expandedIds`.
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const email = () => props.email;

  return (
    <article
      class={`email ${email().category} rise`}
      classList={{ expanded: props.expanded }}
      style={{ "animation-delay": `${Math.min(props.index * 45, 300)}ms` }}
      role="button"
      tabindex={0}
      aria-expanded={props.expanded}
      onClick={() => props.onToggle()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onToggle();
        }
      }}
    >
      <div
        class="avatar"
        style={{ background: avatarColor(email().fromName) }}
        aria-hidden="true"
      >
        {initialsOf(email().fromName)}
      </div>

      <div class="email-body">
        <div class="email-row">
          <p class="email-summary">
            <span class="ai-spark">
              <SparklesIcon />
            </span>
            <span>{email().summary}</span>
          </p>
        </div>

        <div class="email-from">
          <div class="email-meta-main">
            <span class="email-subject" title={email().subject}>
              <span class="email-meta-label">Subject:</span> {email().subject}
            </span>
            <span>
              <span class="email-meta-label">Sender:</span> {email().fromName}
            </span>
            <span>{formatDateTime(email().receivedAt, props.timezone)}</span>
          </div>
          <Show when={props.account}>
            {(a) => {
              const v = providerVisual(a().provider);
              return (
                <span class="badge email-mailbox" title={a().address}>
                  <span class="badge-dot" style={{ background: v.bg }}>
                    {v.initials}
                  </span>
                  {a().label} · {providerName(a().provider)}
                </span>
              );
            }}
          </Show>
        </div>

        <Show when={props.expanded}>
          <div class="email-full">{email().body}</div>
        </Show>
      </div>
    </article>
  );
}
