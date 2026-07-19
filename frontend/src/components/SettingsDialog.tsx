import type { JSX } from "solid-js";
import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { User } from "@pigeon/shared";
import { ApiError, deliverySettings, profile } from "../lib/api";
import { timezoneOptions } from "../lib/timezones";
import { useNotifications } from "./Notifications";
import { CloseIcon } from "./visuals";

export default function SettingsDialog(props: {
  open: boolean;
  user: User;
  timezone: string;
  onClose: () => void;
  onSaved: (values: { name: string; timezone: string }) => void;
}): JSX.Element {
  const notifications = useNotifications();
  const [name, setName] = createSignal(untrack(() => props.user.name));
  const [timezone, setTimezone] = createSignal(untrack(() => props.timezone));
  const [isSaving, setIsSaving] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  let dialog: HTMLDivElement | undefined;
  let nameInput: HTMLInputElement | undefined;

  createEffect(
    on(
      () => props.open,
      (open, wasOpen) => {
        if (!open || wasOpen) return;
        setName(props.user.name);
        setTimezone(props.timezone);
        setErrorMessage(null);
        queueMicrotask(() => nameInput?.focus());
      },
    ),
  );

  createEffect(() => {
    if (!props.open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    onCleanup(() => {
      document.body.style.overflow = previousOverflow;
    });
  });

  function close(): void {
    if (!isSaving()) props.onClose();
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab" || dialog === undefined) return;

    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    const trimmedName = name().trim();
    if (trimmedName.length === 0 || isSaving()) return;

    setIsSaving(true);
    setErrorMessage(null);
    try {
      const [updatedProfile, updatedDelivery] = await Promise.all([
        profile.update({ name: trimmedName }),
        deliverySettings.update({ timezone: timezone() }),
      ]);
      props.onSaved({
        name: updatedProfile.name,
        timezone: updatedDelivery.settings.timezone,
      });
      notifications.success("Settings saved.");
      props.onClose();
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "Could not save your settings. Please try again.";
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  }

  const hasChanges = () =>
    name().trim() !== props.user.name || timezone() !== props.timezone;

  return (
    <Show when={props.open}>
      <Portal>
        <div class="modal-overlay" onClick={close}>
          <div
            ref={dialog}
            class="modal settings-modal rise"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
            aria-busy={isSaving()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            <div class="modal-head">
              <div>
                <div class="modal-eyebrow">Preferences</div>
                <h2 id="settings-dialog-title" class="modal-title">
                  Settings
                </h2>
              </div>
              <button
                type="button"
                class="icon-btn"
                aria-label="Close settings"
                disabled={isSaving()}
                onClick={close}
              >
                <CloseIcon />
              </button>
            </div>

            <form class="modal-form" onSubmit={save}>
              <section class="settings-section" aria-labelledby="account-title">
                <div>
                  <h3 id="account-title" class="settings-section-title">
                    Account
                  </h3>
                  <p class="hint">Your identity across Pigeon.</p>
                </div>

                <div class="field">
                  <label class="field-label" for="settings-name">
                    Name
                  </label>
                  <input
                    ref={nameInput}
                    id="settings-name"
                    class="input"
                    value={name()}
                    maxlength={100}
                    required
                    disabled={isSaving()}
                    onInput={(event) => setName(event.currentTarget.value)}
                  />
                </div>

                <div class="field">
                  <label class="field-label" for="settings-email">
                    Email
                  </label>
                  <input
                    id="settings-email"
                    class="input"
                    value={props.user.email}
                    readOnly
                  />
                </div>
              </section>

              <section
                class="settings-section"
                aria-labelledby="regional-title"
              >
                <div>
                  <h3 id="regional-title" class="settings-section-title">
                    Regional preferences
                  </h3>
                  <p class="hint">Controls when scheduled deliveries arrive.</p>
                </div>

                <div class="field">
                  <label class="field-label" for="settings-timezone">
                    Timezone
                  </label>
                  <select
                    id="settings-timezone"
                    class="select"
                    value={timezone()}
                    disabled={isSaving()}
                    onInput={(event) => setTimezone(event.currentTarget.value)}
                  >
                    <For each={timezoneOptions(props.timezone)}>
                      {(zone) => <option value={zone}>{zone}</option>}
                    </For>
                  </select>
                  <p class="hint">
                    Digest times and weekdays automatically follow
                    daylight-saving changes.
                  </p>
                </div>
              </section>

              <Show when={errorMessage()}>
                {(message) => (
                  <p class="auth-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>

              <div class="modal-actions settings-actions">
                <button
                  type="button"
                  class="btn"
                  disabled={isSaving()}
                  onClick={close}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  disabled={
                    isSaving() || name().trim().length === 0 || !hasChanges()
                  }
                >
                  {isSaving() ? "Saving…" : "Save settings"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
