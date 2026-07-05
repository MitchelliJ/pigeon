import type { JSX } from "solid-js";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { ChannelKind, Priority } from "@pigeon/shared";
import { ApiError, channels as channelsApi } from "../lib/api";
import { channelVisual, CloseIcon } from "./visuals";

const CHANNELS: {
  kind: ChannelKind;
  name: string;
  hint: string;
  configKey: "webhookUrl" | "phoneNumber";
  placeholder: string;
  label: string;
}[] = [
  {
    kind: "discord",
    name: "Discord",
    hint: "In your server: Settings → Integrations → Webhooks → Copy URL.",
    configKey: "webhookUrl",
    placeholder: "https://discord.com/api/webhooks/…",
    label: "Webhook URL",
  },
  {
    kind: "whatsapp",
    name: "WhatsApp",
    hint: "Your WhatsApp number in international format. Requires WhatsApp to be enabled on this Pigeon server.",
    configKey: "phoneNumber",
    placeholder: "+31612345678",
    label: "Phone number",
  },
  {
    kind: "signal",
    name: "Signal",
    hint: "Your Signal number in international format. Requires Signal to be enabled on this Pigeon server.",
    configKey: "phoneNumber",
    placeholder: "+31612345678",
    label: "Phone number",
  },
];

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "urgent", label: "Urgent only" },
  { value: "important", label: "Important & urgent" },
  { value: "everything", label: "Everything" },
];

export default function AddChannelDialog(props: {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}): JSX.Element {
  const [step, setStep] = createSignal<1 | 2>(1);
  const [kind, setKind] = createSignal<ChannelKind>("discord");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [form, setForm] = createSignal({
    label: "",
    value: "",
    minPriority: "urgent" as Priority,
  });

  const [supported] = createResource(() =>
    channelsApi.supported().catch(() => ["discord"]),
  );
  const meta = () => CHANNELS.find((c) => c.kind === kind())!;

  createEffect(() => {
    if (!props.open) return;
    setStep(1);
    setKind("discord");
    setBusy(false);
    setError(null);
    setForm({ label: "", value: "", minPriority: "urgent" });
  });

  function pick(k: ChannelKind) {
    const c = CHANNELS.find((x) => x.kind === k)!;
    setKind(k);
    setError(null);
    setForm({ label: c.name, value: "", minPriority: "urgent" });
    setStep(2);
  }

  async function submit(e: Event) {
    e.preventDefault();
    const f = form();
    if (!f.value.trim() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await channelsApi.create({
        kind: kind(),
        label: f.label.trim() || meta().name,
        config: { [meta().configKey]: f.value.trim() },
        minPriority: f.minPriority,
      });
      props.onConnected();
      props.onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not reach the Pigeon API.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div class="modal-overlay" onClick={() => props.onClose()}>
          <div
            class="modal rise"
            role="dialog"
            aria-modal="true"
            aria-label="Add a channel"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="modal-head">
              <div>
                <div class="modal-eyebrow">Step {step()} of 2</div>
                <h2 class="modal-title">
                  <Show when={step() === 1} fallback={`Connect ${meta().name}`}>
                    Add a channel
                  </Show>
                </h2>
              </div>
              <button
                class="icon-btn"
                aria-label="Close"
                onClick={() => props.onClose()}
              >
                <CloseIcon />
              </button>
            </div>

            {/* Step 1 — channel grid */}
            <Show when={step() === 1}>
              <p class="modal-sub">
                Where should Pigeon reach you? Notifications respect the
                priority threshold you pick.
              </p>
              <div class="provider-grid">
                <For each={CHANNELS}>
                  {(c) => {
                    const v = channelVisual(c.kind);
                    const enabled = () =>
                      (supported() ?? ["discord"]).includes(c.kind);
                    return (
                      <button
                        class="provider-tile"
                        disabled={!enabled()}
                        title={
                          enabled() ? "" : "Not enabled on this server yet"
                        }
                        style={
                          enabled()
                            ? {}
                            : { opacity: "0.45", cursor: "not-allowed" }
                        }
                        onClick={() => enabled() && pick(c.kind)}
                      >
                        <span
                          class="provider-mark"
                          style={{ background: v.color }}
                        >
                          {v.glyph}
                        </span>
                        <span class="provider-name">{c.name}</span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* Step 2 — config form */}
            <Show when={step() === 2}>
              <form class="modal-form" onSubmit={submit}>
                <p class="hint provider-note">{meta().hint}</p>

                <div class="field">
                  <label class="field-label">Label</label>
                  <input
                    class="input"
                    placeholder={meta().name}
                    value={form().label}
                    onInput={(e) =>
                      setForm({ ...form(), label: e.currentTarget.value })
                    }
                  />
                </div>

                <div class="field">
                  <label class="field-label">{meta().label}</label>
                  <input
                    class="input webhook-input"
                    placeholder={meta().placeholder}
                    value={form().value}
                    onInput={(e) =>
                      setForm({ ...form(), value: e.currentTarget.value })
                    }
                  />
                </div>

                <div class="field">
                  <label class="field-label">Notify me about</label>
                  <div class="field-pair">
                    <For each={PRIORITIES}>
                      {(p) => (
                        <button
                          type="button"
                          class="btn"
                          classList={{
                            "btn-primary": form().minPriority === p.value,
                          }}
                          style={{ flex: 1 }}
                          onClick={() =>
                            setForm({ ...form(), minPriority: p.value })
                          }
                        >
                          {p.label}
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <Show when={error()}>
                  <p class="auth-error">{error()}</p>
                </Show>

                <div class="modal-actions">
                  <button type="button" class="btn" onClick={() => setStep(1)}>
                    Back
                  </button>
                  <button
                    type="submit"
                    class="btn btn-primary"
                    style={{ flex: 1 }}
                    disabled={busy()}
                  >
                    {busy() ? "Connecting…" : "Connect channel"}
                  </button>
                </div>
              </form>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
