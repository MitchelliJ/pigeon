import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import type { Channel, Digest, EmailAccount } from "@pigeon/shared";
import {
  channels as channelsApi,
  deliverySettings,
  mailboxes,
} from "../lib/api";
import { formatTime } from "../lib/format";
import {
  ArrowUpRightIcon,
  CalendarIcon,
  MoonIcon,
  PlusIcon,
  providerVisual,
  SendIcon,
  ZapIcon,
} from "./visuals";
import AddInboxDialog, { type AddInboxPreset } from "./AddInboxDialog";
import AddChannelDialog from "./AddChannelDialog";
import EditScheduleDialog from "./EditScheduleDialog";

export default function Sidebar(props: {
  accounts: EmailAccount[];
  channel: Channel | null;
  digest: Digest;
  lastSync: string;
  /** Called after any successful mutation so the dashboard refetches. */
  onChanged: () => void;
}): JSX.Element {
  const [isInboxDialogOpen, setIsInboxDialogOpen] = createSignal(false);
  const [inboxPreset, setInboxPreset] = createSignal<AddInboxPreset | null>(
    null,
  );
  const [isScheduleDialogOpen, setIsScheduleDialogOpen] = createSignal(false);
  const [isChannelDialogOpen, setIsChannelDialogOpen] = createSignal(false);
  const [syncingInboxId, setSyncingInboxId] = createSignal<string | null>(null);
  const [channelAction, setChannelAction] = createSignal<
    "test" | "remove" | null
  >(null);
  const [channelErrorMessage, setChannelErrorMessage] = createSignal<
    string | null
  >(null);

  function openAdd() {
    setInboxPreset(null);
    setIsInboxDialogOpen(true);
  }

  function openReconnect(acc: EmailAccount) {
    setInboxPreset({
      provider: acc.provider,
      address: acc.address,
      label: acc.label,
      protocol: acc.protocol === "pop3" ? "pop3" : "imap",
    });
    setIsInboxDialogOpen(true);
  }

  async function syncInbox(acc: EmailAccount) {
    if (syncingInboxId() === acc.id) return;
    setSyncingInboxId(acc.id);
    try {
      await mailboxes.syncNow(acc.id);
      props.onChanged();
    } catch {
      // Swallow: a failed sync-now (offline mailbox, 5xx, network drop, or the
      // endpoint not being live yet) must not become an unhandled rejection.
      // The next dashboard poll reflects the real mailbox state regardless.
    } finally {
      setSyncingInboxId(null);
    }
  }

  function channelStatusLabel(channel: Channel): string {
    return channel.status === "active"
      ? "Active"
      : "Error: Discord connection failed.";
  }

  async function testChannel(ch: Channel): Promise<void> {
    if (channelAction() !== null) return;
    setChannelAction("test");
    setChannelErrorMessage(null);
    try {
      await channelsApi.test(ch.id);
      props.onChanged();
    } catch {
      setChannelErrorMessage(
        "Could not send a Discord test. Please try again.",
      );
    } finally {
      setChannelAction(null);
    }
  }

  async function disconnectChannel(ch: Channel): Promise<void> {
    if (channelAction() !== null) return;
    setChannelAction("remove");
    setChannelErrorMessage(null);
    try {
      await channelsApi.remove(ch.id);
      props.onChanged();
    } catch {
      setChannelErrorMessage("Could not disconnect Discord. Please try again.");
    } finally {
      setChannelAction(null);
    }
  }

  async function saveSchedule(
    time: string,
    days: Digest["digestDays"],
    timezone: string,
  ): Promise<void> {
    await deliverySettings.update({
      digestTime: time,
      digestDays: days,
      timezone,
    });
    props.onChanged();
  }

  async function setDigestMode(mode: Digest["mode"]): Promise<void> {
    await deliverySettings.update({ mode });
    props.onChanged();
  }

  return (
    <aside class="sidebar">
      {/* ---- Inboxes card ------------------------------------------ */}
      <section class="card">
        <div class="card-head">
          <span class="card-title">Inboxes</span>
          <span class="card-sync">Synced {props.lastSync}</span>
        </div>

        <For each={props.accounts}>
          {(acc) => {
            const v = providerVisual(acc.provider);
            const connected = () =>
              acc.status === "connected" || acc.status === "syncing";
            return (
              <button
                type="button"
                class="inbox"
                disabled={syncingInboxId() === acc.id}
                title={connected() ? "Sync now" : "Reconnect"}
                onClick={() => {
                  if (connected()) {
                    void syncInbox(acc);
                  } else {
                    openReconnect(acc);
                  }
                }}
              >
                <div class="inbox-avatar" style={{ background: v.bg }}>
                  {v.initials}
                </div>
                <div class="inbox-meta">
                  <div class="inbox-label">{acc.label}</div>
                  <div class="inbox-addr">{acc.address}</div>
                </div>
                <span
                  class={`inbox-state ${
                    connected() ? "connected" : "disconnected"
                  }`}
                >
                  {acc.status === "syncing"
                    ? "Syncing…"
                    : connected()
                      ? "Connected"
                      : acc.status === "error"
                        ? "Error"
                        : "Disconnected"}
                </span>
              </button>
            );
          }}
        </For>

        <button type="button" class="inbox inbox-add" onClick={openAdd}>
          <div class="inbox-avatar inbox-add-avatar">
            <PlusIcon />
          </div>
          <div class="inbox-meta">
            <div class="inbox-label">Add new inbox</div>
          </div>
        </button>
      </section>

      {/* ---- Notify me on card ------------------------------------- */}
      <section class="card">
        <div class="card-head">
          <span class="card-title">Notify me on</span>
        </div>

        <For each={props.channel ? [props.channel] : []}>
          {(ch) => {
            const isActive = () => ch.status === "active";
            return (
              <div class="channel">
                <div class="inbox channel-summary">
                  <div
                    class="inbox-avatar"
                    style={{ background: "var(--discord)" }}
                  >
                    ◎
                  </div>
                  <div class="inbox-meta">
                    <div class="inbox-label">Discord</div>
                    <div class="inbox-addr">{channelStatusLabel(ch)}</div>
                  </div>
                  <span
                    class={`inbox-state ${isActive() ? "connected" : "disconnected"}`}
                  >
                    {isActive() ? "Active" : "Reconnect needed"}
                  </span>
                </div>
                <div class="channel-actions">
                  <button
                    type="button"
                    class="channel-action"
                    disabled={channelAction() !== null}
                    onClick={() => void testChannel(ch)}
                  >
                    {channelAction() === "test" ? "Testing…" : "Test again"}
                  </button>
                  <button
                    type="button"
                    class="channel-action channel-disconnect"
                    disabled={channelAction() !== null}
                    onClick={() => void disconnectChannel(ch)}
                  >
                    {channelAction() === "remove"
                      ? "Disconnecting…"
                      : "Disconnect"}
                  </button>
                </div>
                <Show when={channelErrorMessage()}>
                  {(message) => (
                    <p class="channel-error" role="alert">
                      {message()}
                    </p>
                  )}
                </Show>
              </div>
            );
          }}
        </For>

        <Show when={!props.channel}>
          <button
            type="button"
            class="inbox inbox-add"
            onClick={() => setIsChannelDialogOpen(true)}
          >
            <div class="inbox-avatar inbox-add-avatar">
              <PlusIcon />
            </div>
            <div class="inbox-meta">
              <div class="inbox-label">Add new channel</div>
            </div>
          </button>
        </Show>
      </section>

      {/* ---- Smart digest card ------------------------------------- */}
      <section class="digest">
        <div class="digest-toggle">
          <button
            type="button"
            class="digest-mode"
            classList={{ active: props.digest.mode === "daily" }}
            onClick={() => void setDigestMode("daily")}
          >
            <CalendarIcon /> Daily digest
          </button>
          <button
            type="button"
            class="digest-mode"
            classList={{ active: props.digest.mode === "quiet" }}
            onClick={() => void setDigestMode("quiet")}
          >
            <MoonIcon /> Quiet mode
          </button>
        </div>

        <div class="digest-panel">
          <Show
            when={props.digest.mode === "daily"}
            fallback={
              <>
                <h3 class="digest-headline">
                  <span class="digest-icon">
                    <ZapIcon />
                  </span>
                  Quiet mode
                </h3>
                <p class="digest-sub">
                  New requires-action emails are sent immediately. During quiet
                  stretches, Pigeon sends reassurance at{" "}
                  {formatTime(props.digest.digestTime)} in{" "}
                  {props.digest.timezone} on your selected days.
                </p>
                <button
                  class="digest-edit"
                  onClick={() => setIsScheduleDialogOpen(true)}
                >
                  Edit reassurance schedule <ArrowUpRightIcon />
                </button>
              </>
            }
          >
            <h3 class="digest-headline">
              <span class="digest-icon">
                <SendIcon />
              </span>
              Daily digest at {formatTime(props.digest.digestTime)} in{" "}
              {props.digest.timezone}
            </h3>
            <p class="digest-sub">
              Only scheduled digests are sent. Last sent{" "}
              {props.digest.lastSuccessfulDigestAt ?? "Never"}.
            </p>
            <button
              class="digest-edit"
              onClick={() => setIsScheduleDialogOpen(true)}
            >
              Edit schedule <ArrowUpRightIcon />
            </button>
          </Show>
        </div>
      </section>

      {/* ---- Dialogs ----------------------------------------------- */}
      <AddInboxDialog
        open={isInboxDialogOpen()}
        preset={inboxPreset()}
        onClose={() => setIsInboxDialogOpen(false)}
        onConnected={props.onChanged}
      />
      <AddChannelDialog
        open={isChannelDialogOpen()}
        onClose={() => setIsChannelDialogOpen(false)}
        onConnected={props.onChanged}
      />
      <EditScheduleDialog
        open={isScheduleDialogOpen()}
        time={props.digest.digestTime}
        days={props.digest.digestDays}
        timezone={props.digest.timezone}
        onClose={() => setIsScheduleDialogOpen(false)}
        onSave={(time, days, timezone) =>
          void saveSchedule(time, days, timezone)
        }
      />
    </aside>
  );
}
