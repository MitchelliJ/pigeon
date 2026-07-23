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
  const [profileBusy, setProfileBusy] = createSignal(false);
  const [profileError, setProfileError] = createSignal<string | null>(null);
  const [profileSuccess, setProfileSuccess] = createSignal<string | null>(null);
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [passwordBusy, setPasswordBusy] = createSignal(false);
  const [passwordError, setPasswordError] = createSignal<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = createSignal<string | null>(
    null,
  );
  const [newEmail, setNewEmail] = createSignal("");
  const [emailPassword, setEmailPassword] = createSignal("");
  const [emailBusy, setEmailBusy] = createSignal(false);
  const [emailError, setEmailError] = createSignal<string | null>(null);
  const [emailSuccess, setEmailSuccess] = createSignal<string | null>(null);
  let dialog: HTMLDivElement | undefined;
  let nameInput: HTMLInputElement | undefined;

  const isBusy = () => profileBusy() || passwordBusy() || emailBusy();

  createEffect(
    on(
      () => props.open,
      (open, wasOpen) => {
        if (!open || wasOpen) return;
        setName(props.user.name);
        setTimezone(props.timezone);
        setProfileError(null);
        setProfileSuccess(null);
        setCurrentPassword("");
        setNewPassword("");
        setPasswordError(null);
        setPasswordSuccess(null);
        setNewEmail("");
        setEmailPassword("");
        setEmailError(null);
        setEmailSuccess(null);
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
    if (!isBusy()) props.onClose();
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

  function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof ApiError ? error.message : fallback;
  }

  async function saveProfile(event: Event): Promise<void> {
    event.preventDefault();
    const trimmedName = name().trim();
    if (trimmedName.length === 0 || profileBusy()) return;

    setProfileBusy(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      const [updatedProfile, updatedDelivery] = await Promise.all([
        profile.update({ name: trimmedName }),
        deliverySettings.update({ timezone: timezone() }),
      ]);
      props.onSaved({
        name: updatedProfile.name,
        timezone: updatedDelivery.settings.timezone,
      });
      setProfileSuccess("Settings saved.");
      notifications.success("Settings saved.");
    } catch (error) {
      setProfileError(
        getErrorMessage(
          error,
          "Could not save your settings. Please try again.",
        ),
      );
    } finally {
      setProfileBusy(false);
    }
  }

  async function savePassword(event: Event): Promise<void> {
    event.preventDefault();
    if (
      passwordBusy() ||
      currentPassword().length === 0 ||
      newPassword().length === 0
    ) {
      return;
    }

    setPasswordBusy(true);
    setPasswordError(null);
    setPasswordSuccess(null);
    try {
      await profile.changePassword({
        currentPassword: currentPassword(),
        newPassword: newPassword(),
      });
      setCurrentPassword("");
      setNewPassword("");
      setPasswordSuccess("Password updated.");
      notifications.success("Password updated.");
    } catch (error) {
      setPasswordError(
        getErrorMessage(
          error,
          "Could not update your password. Please try again.",
        ),
      );
    } finally {
      setPasswordBusy(false);
    }
  }

  async function saveEmailChange(event: Event): Promise<void> {
    event.preventDefault();
    const requestedEmail = newEmail().trim();
    if (
      emailBusy() ||
      requestedEmail.length === 0 ||
      emailPassword().length === 0
    ) {
      return;
    }

    setEmailBusy(true);
    setEmailError(null);
    setEmailSuccess(null);
    try {
      await profile.requestEmailChange({
        newEmail: requestedEmail,
        currentPassword: emailPassword(),
      });
      setNewEmail(requestedEmail);
      setEmailPassword("");
      setEmailSuccess(
        `A confirmation link was sent to ${requestedEmail}. ${props.user.email} remains active until you confirm the change.`,
      );
      notifications.success("Confirmation link sent.");
    } catch (error) {
      setEmailError(
        getErrorMessage(
          error,
          "Could not start your email change. Please try again.",
        ),
      );
    } finally {
      setEmailBusy(false);
    }
  }

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
            aria-busy={isBusy()}
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
                disabled={isBusy()}
                onClick={close}
              >
                <CloseIcon />
              </button>
            </div>

            <form class="modal-form" onSubmit={saveProfile}>
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
                    disabled={profileBusy()}
                    onInput={(event) => setName(event.currentTarget.value)}
                  />
                </div>

                <div class="field">
                  <label class="field-label" for="settings-email">
                    Current email
                  </label>
                  <input
                    id="settings-email"
                    class="input"
                    type="email"
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
                    disabled={profileBusy()}
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

              <Show when={profileError()}>
                {(message) => (
                  <p class="auth-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>

              <Show when={profileSuccess()}>
                {(message) => (
                  <p class="hint" role="status">
                    {message()}
                  </p>
                )}
              </Show>

              <div class="modal-actions settings-actions">
                <button
                  type="submit"
                  class="btn btn-primary"
                  disabled={profileBusy() || name().trim().length === 0}
                >
                  {profileBusy() ? "Saving…" : "Save settings"}
                </button>
              </div>
            </form>

            <form class="modal-form" onSubmit={savePassword}>
              <section
                class="settings-section"
                aria-labelledby="password-title"
              >
                <div>
                  <h3 id="password-title" class="settings-section-title">
                    Password
                  </h3>
                  <p class="hint">Change your password for future sign-ins.</p>
                </div>

                <div class="field">
                  <label class="field-label" for="settings-current-password">
                    Current password
                  </label>
                  <input
                    id="settings-current-password"
                    class="input"
                    type="password"
                    value={currentPassword()}
                    autocomplete="current-password"
                    required
                    disabled={passwordBusy()}
                    onInput={(event) =>
                      setCurrentPassword(event.currentTarget.value)
                    }
                  />
                </div>

                <div class="field">
                  <label class="field-label" for="settings-new-password">
                    New password
                  </label>
                  <input
                    id="settings-new-password"
                    class="input"
                    type="password"
                    value={newPassword()}
                    autocomplete="new-password"
                    required
                    disabled={passwordBusy()}
                    onInput={(event) =>
                      setNewPassword(event.currentTarget.value)
                    }
                  />
                </div>
              </section>

              <Show when={passwordError()}>
                {(message) => (
                  <p class="auth-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>

              <Show when={passwordSuccess()}>
                {(message) => (
                  <p class="hint" role="status">
                    {message()}
                  </p>
                )}
              </Show>

              <div class="modal-actions settings-actions">
                <button
                  type="submit"
                  class="btn btn-primary"
                  disabled={
                    passwordBusy() ||
                    currentPassword().length === 0 ||
                    newPassword().length === 0
                  }
                >
                  {passwordBusy() ? "Saving…" : "Update password"}
                </button>
              </div>
            </form>

            <form class="modal-form" onSubmit={saveEmailChange}>
              <section
                class="settings-section"
                aria-labelledby="email-change-title"
              >
                <div>
                  <h3 id="email-change-title" class="settings-section-title">
                    Change email
                  </h3>
                  <p class="hint">
                    Send a confirmation link to a new email address.
                  </p>
                </div>

                <div class="field">
                  <label class="field-label" for="settings-new-email">
                    New email
                  </label>
                  <input
                    id="settings-new-email"
                    class="input"
                    type="email"
                    value={newEmail()}
                    autocomplete="email"
                    required
                    disabled={emailBusy()}
                    onInput={(event) => setNewEmail(event.currentTarget.value)}
                  />
                </div>

                <div class="field">
                  <label class="field-label" for="settings-email-password">
                    Current password
                  </label>
                  <input
                    id="settings-email-password"
                    class="input"
                    type="password"
                    value={emailPassword()}
                    autocomplete="current-password"
                    required
                    disabled={emailBusy()}
                    onInput={(event) =>
                      setEmailPassword(event.currentTarget.value)
                    }
                  />
                </div>
              </section>

              <Show when={emailError()}>
                {(message) => (
                  <p class="auth-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>

              <Show when={emailSuccess()}>
                {(message) => (
                  <p class="hint" role="status">
                    {message()}
                  </p>
                )}
              </Show>

              <div class="modal-actions settings-actions">
                <button
                  type="submit"
                  class="btn btn-primary"
                  disabled={
                    emailBusy() ||
                    newEmail().trim().length === 0 ||
                    emailPassword().length === 0
                  }
                >
                  {emailBusy() ? "Saving…" : "Change email"}
                </button>
              </div>
            </form>

            <div class="modal-actions settings-actions">
              <button
                type="button"
                class="btn"
                disabled={isBusy()}
                onClick={close}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
