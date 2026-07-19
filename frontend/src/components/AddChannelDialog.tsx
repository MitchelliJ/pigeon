import type { JSX } from "solid-js";
import { createEffect, createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { ApiError, channels as channelsApi } from "../lib/api";
import { CloseIcon } from "./visuals";
import { useNotifications } from "./Notifications";

function connectionError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Could not reach the Pigeon API.";
  }

  switch (error.code) {
    case "invalid_channel_config":
      return "Enter a valid Discord webhook URL.";
    case "channel_test_failed":
      return "Discord could not verify this webhook. Check the URL and try again.";
    case "channel_exists":
      return "A channel is already connected.";
    default:
      return "Could not connect Discord. Please try again.";
  }
}

export default function AddChannelDialog(props: {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}): JSX.Element {
  const notifications = useNotifications();
  const [webhookUrl, setWebhookUrl] = createSignal("");
  const [isConnecting, setIsConnecting] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  createEffect(() => {
    if (!props.open) return;
    setWebhookUrl("");
    setIsConnecting(false);
    setErrorMessage(null);
  });

  function close() {
    if (!isConnecting()) props.onClose();
  }

  async function submit(event: Event) {
    event.preventDefault();
    const trimmedWebhookUrl = webhookUrl().trim();
    if (!trimmedWebhookUrl || isConnecting()) return;

    setIsConnecting(true);
    setErrorMessage(null);
    try {
      await channelsApi.create({
        kind: "discord",
        config: { webhookUrl: trimmedWebhookUrl },
      });
      props.onConnected();
      props.onClose();
      notifications.success("Discord connected.");
    } catch (caught) {
      setErrorMessage(connectionError(caught));
    } finally {
      setIsConnecting(false);
    }
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div class="modal-overlay" onClick={close}>
          <div
            class="modal rise"
            role="dialog"
            aria-modal="true"
            aria-label="Connect Discord"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="modal-head">
              <div>
                <div class="modal-eyebrow">Discord</div>
                <h2 class="modal-title">Connect Discord</h2>
              </div>
              <button
                class="icon-btn"
                type="button"
                aria-label="Close"
                disabled={isConnecting()}
                onClick={close}
              >
                <CloseIcon />
              </button>
            </div>

            <form class="modal-form" onSubmit={submit}>
              <p class="hint provider-note">
                In your server, open Settings → Integrations → Webhooks and copy
                the webhook URL. Pigeon will send a test message before saving
                it.
              </p>

              <div class="field">
                <label class="field-label" for="discord-webhook-url">
                  Webhook URL
                </label>
                <input
                  id="discord-webhook-url"
                  class="input webhook-input"
                  type="url"
                  required
                  autocomplete="off"
                  placeholder="https://discord.com/api/webhooks/…"
                  value={webhookUrl()}
                  disabled={isConnecting()}
                  onInput={(event) => setWebhookUrl(event.currentTarget.value)}
                />
              </div>

              <Show when={errorMessage()}>
                {(message) => (
                  <p class="auth-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>

              <div class="modal-actions">
                <button
                  type="button"
                  class="btn"
                  disabled={isConnecting()}
                  onClick={close}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={isConnecting() || !webhookUrl().trim()}
                >
                  {isConnecting()
                    ? "Testing and connecting…"
                    : "Connect Discord"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
