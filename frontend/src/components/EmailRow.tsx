import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import type { Email, EmailAccount } from "@pigeon/shared";
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
}): JSX.Element {
  const email = () => props.email;
  const [expanded, setExpanded] = createSignal(false);

  const toggle = () => setExpanded((v) => !v);

  return (
    <article
      class={`email ${email().category} rise`}
      classList={{ expanded: expanded() }}
      style={{ "animation-delay": `${Math.min(props.index * 45, 300)}ms` }}
      role="button"
      tabindex={0}
      aria-expanded={expanded()}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
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
          <div class="email-subject">{email().subject}</div>
          <div class="email-time">{email().receivedAt}</div>
        </div>

        <div class="email-from">
          {email().fromName}
          <Show when={props.account}>
            {(a) => {
              const v = providerVisual(a().provider);
              return (
                <span class="badge" title={a().address}>
                  <span class="badge-dot" style={{ background: v.bg }}>
                    {v.initials}
                  </span>
                  {a().label} · {providerName(a().provider)}
                </span>
              );
            }}
          </Show>
        </div>

        <p class="email-summary">
          <span class="ai-spark">
            <SparklesIcon />
          </span>
          <em>{email().summary}</em>
        </p>

        <Show when={expanded()}>
          <div class="email-full">{email().body}</div>
        </Show>
      </div>
    </article>
  );
}
