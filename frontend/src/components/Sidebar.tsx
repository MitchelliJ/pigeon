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
  channelVisual,
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
  channels: Channel[];
  digest: Digest;
  lastSync: string;
  /** Called after any successful mutation so the dashboard refetches. */
  onChanged: () => void;
}): JSX.Element {
  const [addOpen, setAddOpen] = createSignal(false);
  const [addPreset, setAddPreset] = createSignal<AddInboxPreset | null>(null);
  const [scheduleOpen, setScheduleOpen] = createSignal(false);
  const [channelOpen, setChannelOpen] = createSignal(false);
  const [busyId, setBusyId] = createSignal<string | null>(null);

  function openAdd() {
    setAddPreset(null);
    setAddOpen(true);
  }

  function openReconnect(acc: EmailAccount) {
    setAddPreset({
      provider: acc.provider,
      address: acc.address,
      label: acc.label,
      protocol: acc.protocol === "pop3" ? "pop3" : "imap",
    });
    setAddOpen(true);
  }

  async function syncInbox(acc: EmailAccount) {
    if (busyId() === acc.id) return;
    setBusyId(acc.id);
    try {
      await mailboxes.syncNow(acc.id);
      props.onChanged();
    } catch {
      // Swallow: a failed sync-now (offline mailbox, 5xx, network drop, or the
      // endpoint not being live yet) must not become an unhandled rejection.
      // The next dashboard poll reflects the real mailbox state regardless.
    } finally {
      setBusyId(null);
    }
  }

  async function toggleChannel(ch: Channel) {
    setBusyId(ch.id);
    try {
      await channelsApi.update(ch.id, { enabled: !ch.enabled });
      props.onChanged();
    } catch {
      // leave state as-is; next refetch shows the truth
    } finally {
      setBusyId(null);
    }
  }

  async function saveSchedule(time: string, days: Digest["days"]) {
    await deliverySettings.update({ digestTime: time, digestDays: days });
    props.onChanged();
  }

  async function setDigestMode(enabled: boolean) {
    await deliverySettings.update({ digestEnabled: enabled });
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
                disabled={busyId() === acc.id}
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

        <For each={props.channels}>
          {(ch) => {
            const v = channelVisual(ch.kind);
            return (
              <button
                type="button"
                class="inbox"
                disabled={busyId() === ch.id}
                title={ch.enabled ? "Click to pause" : "Click to enable"}
                onClick={() => void toggleChannel(ch)}
              >
                <div class="inbox-avatar" style={{ background: v.color }}>
                  {v.glyph}
                </div>
                <div class="inbox-meta">
                  <div class="inbox-label">{ch.label}</div>
                  <div class="inbox-addr">{ch.webhookUrl}</div>
                </div>
                <span
                  class={`inbox-state ${ch.enabled ? "connected" : "disconnected"}`}
                >
                  {ch.enabled ? "On" : "Paused"}
                </span>
              </button>
            );
          }}
        </For>

        <button
          type="button"
          class="inbox inbox-add"
          onClick={() => setChannelOpen(true)}
        >
          <div class="inbox-avatar inbox-add-avatar">
            <PlusIcon />
          </div>
          <div class="inbox-meta">
            <div class="inbox-label">Add new channel</div>
          </div>
        </button>
      </section>

      {/* ---- Smart digest card ------------------------------------- */}
      <section class="digest">
        <div class="digest-toggle">
          <button
            type="button"
            class="digest-mode"
            classList={{ active: props.digest.enabled }}
            onClick={() => void setDigestMode(true)}
          >
            <CalendarIcon /> Daily digest
          </button>
          <button
            type="button"
            class="digest-mode"
            classList={{ active: !props.digest.enabled }}
            onClick={() => void setDigestMode(false)}
          >
            <MoonIcon /> Quiet mode
          </button>
        </div>

        <div class="digest-panel">
          <Show
            when={props.digest.enabled}
            fallback={
              <>
                <h3 class="digest-headline">
                  <span class="digest-icon">
                    <ZapIcon />
                  </span>
                  Quiet mode
                </h3>
                <p class="digest-sub">
                  Only urgent emails reach your channels. No daily digest.
                </p>
              </>
            }
          >
            <h3 class="digest-headline">
              <span class="digest-icon">
                <SendIcon />
              </span>
              Daily digest at {formatTime(props.digest.time)}
            </h3>
            <p class="digest-sub">
              Last sent {props.digest.lastSent}. Urgent mail still reaches you
              instantly.
            </p>
            <button class="digest-edit" onClick={() => setScheduleOpen(true)}>
              Edit schedule <ArrowUpRightIcon />
            </button>
          </Show>
        </div>
      </section>

      {/* ---- Dialogs ----------------------------------------------- */}
      <AddInboxDialog
        open={addOpen()}
        preset={addPreset()}
        onClose={() => setAddOpen(false)}
        onConnected={props.onChanged}
      />
      <AddChannelDialog
        open={channelOpen()}
        onClose={() => setChannelOpen(false)}
        onConnected={props.onChanged}
      />
      <EditScheduleDialog
        open={scheduleOpen()}
        time={props.digest.time}
        days={props.digest.days}
        onClose={() => setScheduleOpen(false)}
        onSave={(time, days) => void saveSchedule(time, days)}
      />
    </aside>
  );
}
