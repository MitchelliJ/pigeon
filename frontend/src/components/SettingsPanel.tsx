import type { JSX } from "solid-js";
import { createResource, createSignal, For, Show } from "solid-js";
import { ApiError, deliverySettings, profile } from "../lib/api";
import { timezoneOptions } from "../lib/timezones";
import { NotificationProvider, useNotifications } from "./Notifications";

export default function SettingsPanel(): JSX.Element {
  return (
    <NotificationProvider>
      <SettingsPanelContent />
    </NotificationProvider>
  );
}

function SettingsPanelContent(): JSX.Element {
  const notifications = useNotifications();
  const [data, { refetch }] = createResource(async () => {
    const [profileSettings, delivery] = await Promise.all([
      profile.get(),
      deliverySettings.get(),
    ]);
    return { profile: profileSettings, delivery: delivery.settings };
  });
  const [name, setName] = createSignal<string | null>(null);
  const [timezone, setTimezone] = createSignal<string | null>(null);
  const [isSavingProfile, setIsSavingProfile] = createSignal(false);
  const [isSavingTimezone, setIsSavingTimezone] = createSignal(false);

  // A failed Solid resource throws when its accessor is read. Check `.error`
  // first so the error state can render instead of leaving the prior spinner.
  const loadedData = () => (data.error ? undefined : data());

  async function saveProfile(event: Event): Promise<void> {
    event.preventDefault();
    setIsSavingProfile(true);
    try {
      await profile.update({ name: name() ?? undefined });
      notifications.success("Profile settings saved.");
    } catch (error) {
      notifications.error(
        error instanceof ApiError
          ? error.message
          : "Could not save your profile settings.",
      );
    } finally {
      setIsSavingProfile(false);
    }
  }

  async function saveTimezone(event: Event): Promise<void> {
    event.preventDefault();
    const selected = timezone() ?? data()?.delivery.timezone;
    if (selected === undefined) return;

    setIsSavingTimezone(true);
    try {
      const result = await deliverySettings.update({ timezone: selected });
      setTimezone(result.settings.timezone);
      notifications.success(`Timezone changed to ${result.settings.timezone}.`);
    } catch (error) {
      notifications.error(
        error instanceof ApiError
          ? error.message
          : "Could not save your timezone.",
      );
    } finally {
      setIsSavingTimezone(false);
    }
  }

  return (
    <div class="page-wrap">
      <a class="page-back" href="/">
        ← Back to dashboard
      </a>
      <h1 class="page-title">Settings</h1>

      <Show
        when={loadedData()}
        fallback={
          <Show
            when={data.error}
            fallback={
              <div class="state">
                <div class="spinner" />
              </div>
            }
          >
            <div class="state">
              <div class="state-title">Couldn’t load settings</div>
              <button class="btn" onClick={() => void refetch()}>
                Try again
              </button>
            </div>
          </Show>
        }
      >
        {(settings) => (
          <>
            <form class="card page-card modal-form" onSubmit={saveProfile}>
              <div class="card-head">
                <span class="card-title">Account</span>
              </div>

              <div class="field">
                <label class="field-label" for="settings-name">
                  Name
                </label>
                <input
                  id="settings-name"
                  class="input"
                  value={name() ?? settings().profile.name}
                  disabled={isSavingProfile()}
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
                  value={settings().profile.email}
                  disabled
                />
              </div>

              <div class="modal-actions">
                <button
                  class="btn btn-primary"
                  type="submit"
                  disabled={isSavingProfile()}
                >
                  {isSavingProfile() ? "Saving…" : "Save account"}
                </button>
              </div>
            </form>

            <form class="card page-card modal-form" onSubmit={saveTimezone}>
              <div class="card-head">
                <span class="card-title">Regional preferences</span>
              </div>

              <div class="field">
                <label class="field-label" for="settings-timezone">
                  Timezone
                </label>
                <select
                  id="settings-timezone"
                  class="select"
                  value={timezone() ?? settings().delivery.timezone}
                  disabled={isSavingTimezone()}
                  onInput={(event) => setTimezone(event.currentTarget.value)}
                >
                  <For
                    each={timezoneOptions(
                      timezone() ?? settings().delivery.timezone,
                    )}
                  >
                    {(zone) => <option value={zone}>{zone}</option>}
                  </For>
                </select>
                <p class="hint">
                  Digest times and selected weekdays use this timezone and
                  automatically follow daylight-saving changes.
                </p>
              </div>

              <div class="modal-actions">
                <button
                  class="btn btn-primary"
                  type="submit"
                  disabled={isSavingTimezone()}
                >
                  {isSavingTimezone() ? "Saving…" : "Save timezone"}
                </button>
              </div>
            </form>
          </>
        )}
      </Show>
    </div>
  );
}
