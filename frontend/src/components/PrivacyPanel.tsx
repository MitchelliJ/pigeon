/**
 * Privacy panel for truthful data-hosting copy and account-deletion controls.
 * Loads the user's deletion schedule on mount so the UI can switch between
 * the destructive form and the grace-period state.
 */
import type { JSX } from "solid-js";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { ApiError, privacy, profile } from "../lib/api";
import { NotificationProvider } from "./Notifications";

const DELETE_CONFIRMATION = "delete my account";
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "short",
});

interface DeletionSchedule {
  requestedAt: string;
  deletesAt: string;
}

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
  const [schedule, setSchedule] = createSignal<DeletionSchedule | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<string | null>(null);
  const [eraseBusy, setEraseBusy] = createSignal(false);
  const [cancelBusy, setCancelBusy] = createSignal(false);

  const canCancel = createMemo(() => {
    const deletesAt = schedule()?.deletesAt;
    if (!deletesAt) return false;
    return (
      Number.isFinite(Date.parse(deletesAt)) &&
      Date.now() < Date.parse(deletesAt)
    );
  });

  onMount(async () => {
    try {
      const settings = await profile.get();
      if (settings.deletionRequestedAt && settings.deletesAt) {
        setSchedule({
          requestedAt: settings.deletionRequestedAt,
          deletesAt: settings.deletesAt,
        });
      }
    } catch (err) {
      setLoadError(
        err instanceof ApiError
          ? err.message
          : "Could not load privacy settings.",
      );
    } finally {
      setLoading(false);
    }
  });

  async function erase(e: Event) {
    e.preventDefault();
    setFormError(null);
    setStatus(null);

    if (confirmText().trim() !== DELETE_CONFIRMATION) {
      setFormError(`Type exactly: "${DELETE_CONFIRMATION}"`);
      return;
    }

    setEraseBusy(true);
    try {
      const result = await privacy.erase({
        password: password(),
        confirm: DELETE_CONFIRMATION,
      });
      setSchedule({
        requestedAt: result.requestedAt,
        deletesAt: result.deletesAt,
      });
      setPassword("");
      setConfirmText("");
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.message
          : "Could not schedule account deletion.",
      );
    } finally {
      setEraseBusy(false);
    }
  }

  async function cancelErase() {
    setFormError(null);
    setStatus(null);
    setCancelBusy(true);
    try {
      await privacy.cancelErase();
      setSchedule(null);
      setStatus("Account deletion cancelled.");
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.message
          : "Could not cancel account deletion.",
      );
    } finally {
      setCancelBusy(false);
    }
  }

  function formatDeadline(value: string): string {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? dateTimeFormat.format(new Date(timestamp))
      : value;
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
          Pigeon is EU-hosted on Hetzner. Summaries are made by Mistral AI.
          Mailbox credentials are encrypted before storage.
        </p>
      </section>

      <Show
        when={!loading()}
        fallback={
          <div class="state">
            <div class="spinner" />
          </div>
        }
      >
        <section class="card page-card page-danger">
          <div class="card-head">
            <span class="card-title">
              {schedule() ? "Account deletion scheduled" : "Delete my account"}
            </span>
          </div>

          <Show when={loadError()}>
            <p class="auth-error" role="alert">
              {loadError()}
            </p>
          </Show>

          <Show when={!loadError()}>
            <Show
              when={schedule()}
              fallback={
                <>
                  <p class="hint">
                    This schedules permanent account deletion after a 24-hour
                    grace period.
                  </p>
                  <form
                    class="modal-form"
                    onSubmit={erase}
                    style={{ "margin-top": "10px" }}
                  >
                    <div class="field">
                      <label class="field-label" for="privacy-password">
                        Your password
                      </label>
                      <input
                        id="privacy-password"
                        class="input"
                        type="password"
                        autocomplete="current-password"
                        required
                        value={password()}
                        onInput={(e) => setPassword(e.currentTarget.value)}
                        disabled={eraseBusy() || cancelBusy()}
                      />
                    </div>
                    <div class="field">
                      <label class="field-label" for="privacy-confirm-phrase">
                        Type &quot;delete my account&quot;
                      </label>
                      <input
                        id="privacy-confirm-phrase"
                        class="input"
                        placeholder={DELETE_CONFIRMATION}
                        required
                        value={confirmText()}
                        onInput={(e) => setConfirmText(e.currentTarget.value)}
                        disabled={eraseBusy() || cancelBusy()}
                      />
                    </div>
                    <Show when={formError()}>
                      <p class="auth-error" role="alert">
                        {formError()}
                      </p>
                    </Show>
                    <Show when={status()}>
                      <p class="hint" role="status">
                        {status()}
                      </p>
                    </Show>
                    <button
                      class="btn btn-danger"
                      type="submit"
                      disabled={eraseBusy() || cancelBusy()}
                      aria-busy={eraseBusy()}
                    >
                      {eraseBusy()
                        ? "Scheduling deletion…"
                        : "Schedule account deletion"}
                    </button>
                  </form>
                </>
              }
            >
              {(pendingSchedule) => (
                <div>
                  <p class="hint page-notice">
                    Your account is scheduled for deletion after a 24-hour grace
                    period.
                  </p>
                  <p class="hint page-notice">
                    Deletion will run on{" "}
                    <time dateTime={pendingSchedule().deletesAt}>
                      {formatDeadline(pendingSchedule().deletesAt)}
                    </time>
                    .
                  </p>
                  <p class="hint">
                    During the grace period, mailbox sync, classification,
                    digests, and heartbeats are paused while your data and
                    current sessions remain intact.
                  </p>
                  <Show when={formError()}>
                    <p class="auth-error" role="alert">
                      {formError()}
                    </p>
                  </Show>
                  <Show when={status()}>
                    <p class="hint" role="status">
                      {status()}
                    </p>
                  </Show>
                  <Show
                    when={canCancel()}
                    fallback={
                      <p class="hint page-notice">
                        The deletion deadline has passed, so cancellation is no
                        longer available.
                      </p>
                    }
                  >
                    <button
                      class="btn"
                      type="button"
                      style={{ "margin-top": "10px" }}
                      onClick={() => void cancelErase()}
                      disabled={cancelBusy() || eraseBusy()}
                      aria-busy={cancelBusy()}
                    >
                      {cancelBusy() ? "Cancelling…" : "Cancel deletion"}
                    </button>
                  </Show>
                </div>
              )}
            </Show>
          </Show>
        </section>
      </Show>
    </div>
  );
}
