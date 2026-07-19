import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import { ApiError, privacy } from "../lib/api";
import { NotificationProvider } from "./Notifications";

export default function PrivacyPanel(): JSX.Element {
  return (
    <NotificationProvider>
      <PrivacyPanelContent />
    </NotificationProvider>
  );
}

function PrivacyPanelContent(): JSX.Element {
  const [password, setPassword] = createSignal("");
  const [confirmText, setConfirmText] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function erase(e: Event) {
    e.preventDefault();
    if (confirmText() !== "delete my account") {
      setError('Type exactly: "delete my account"');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await privacy.erase(password());
      window.location.href = "/login";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div class="page-wrap">
      <a class="page-back" href="/">
        ← Back to dashboard
      </a>
      <h1 class="page-title">Privacy &amp; data</h1>

      <section class="card page-card">
        <div class="card-head">
          <span class="card-title">Where your data lives</span>
        </div>
        <p class="hint">
          Pigeon is EU-hosted (Hetzner, Germany/Finland). Summaries are made by
          Mistral AI (France); payments run through Mollie (Netherlands). Pigeon
          stores sender, subject, a truncated plain-text body and the AI summary
          — never attachments. Emails are deleted automatically after 90 days.
          Mailbox credentials are encrypted with AES-256-GCM and are never
          exported or logged.
        </p>
      </section>

      <section class="card page-card">
        <div class="card-head">
          <span class="card-title">Export your data</span>
        </div>
        <p class="hint">
          One JSON file with everything Pigeon holds about you: account,
          mailboxes, triaged emails, channels, settings, consents and usage.
        </p>
        <a
          class="btn"
          href={privacy.exportUrl}
          style={{ "margin-top": "10px" }}
        >
          Download my data
        </a>
      </section>

      <section class="card page-card page-danger">
        <div class="card-head">
          <span class="card-title">Delete my account</span>
        </div>
        <p class="hint">
          Irreversible. Your account, mailboxes, emails, channels and billing
          data are erased within seconds. Only an anonymous hash remains in the
          audit log.
        </p>
        <form
          class="modal-form"
          onSubmit={erase}
          style={{ "margin-top": "10px" }}
        >
          <div class="field">
            <label class="field-label">Your password</label>
            <input
              class="input"
              type="password"
              autocomplete="current-password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </div>
          <div class="field">
            <label class="field-label">Type "delete my account"</label>
            <input
              class="input"
              placeholder="delete my account"
              value={confirmText()}
              onInput={(e) => setConfirmText(e.currentTarget.value)}
            />
          </div>
          <Show when={error()}>
            <p class="auth-error">{error()}</p>
          </Show>
          <button class="btn btn-danger" type="submit" disabled={busy()}>
            {busy() ? "Erasing…" : "Permanently delete everything"}
          </button>
        </form>
      </section>
    </div>
  );
}
