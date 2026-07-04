import type { JSX } from "solid-js";
import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { Provider } from "@pigeon/shared";
import { ApiError, mailboxes, oauth } from "../lib/api";
import { PROVIDERS, providerConfig } from "../lib/providers";
import { CloseIcon, providerVisual } from "./visuals";

export interface AddInboxPreset {
  provider: Provider;
  address?: string;
  label?: string;
  protocol?: "imap" | "pop3";
}

export default function AddInboxDialog(props: {
  open: boolean;
  /** When set, skips the provider grid and opens straight on the form. */
  preset?: AddInboxPreset | null;
  onClose: () => void;
  /** Fired after the backend accepted the mailbox. */
  onConnected: () => void;
}): JSX.Element {
  const [step, setStep] = createSignal<1 | 2>(1);
  const [provider, setProvider] = createSignal<Provider>("gmail");
  const [protocol, setProtocol] = createSignal<"imap" | "pop3">("imap");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [form, setForm] = createSignal({
    label: "",
    address: "",
    password: "",
    host: "",
    port: 993,
  });

  // OAuth buttons appear only when the server has credentials configured.
  const [oauthProviders] = createResource(() => oauth.providers().catch(() => []));

  // (Re)initialise whenever the dialog opens.
  createEffect(() => {
    if (!props.open) return;
    setError(null);
    setBusy(false);
    const preset = props.preset;
    if (preset) {
      pick(preset.provider, preset);
    } else {
      setStep(1);
      setProvider("gmail");
      const cfg = providerConfig("gmail");
      setForm({
        label: "",
        address: "",
        password: "",
        host: cfg.host,
        port: cfg.port,
      });
    }
  });

  function pick(id: Provider, preset?: AddInboxPreset) {
    const cfg = providerConfig(id);
    const wantPop3 = preset?.protocol === "pop3" && cfg.pop3 !== null;
    const defaults = wantPop3 ? cfg.pop3! : { host: cfg.host, port: cfg.port };
    setProvider(id);
    setProtocol(wantPop3 ? "pop3" : "imap");
    setError(null);
    setForm({
      label: preset?.label ?? "",
      address: preset?.address ?? "",
      password: "",
      host: defaults.host,
      port: defaults.port,
    });
    setStep(2);
  }

  /** Switch IMAP ↔ POP3, swapping in that protocol's default host/port. */
  function pickProtocol(next: "imap" | "pop3") {
    if (next === protocol()) return;
    const cfg = providerConfig(provider());
    const defaults = next === "pop3" ? cfg.pop3 : { host: cfg.host, port: cfg.port };
    if (!defaults) return; // provider has no POP3
    setProtocol(next);
    setForm({ ...form(), host: defaults.host, port: defaults.port });
  }

  async function submit(e: Event) {
    e.preventDefault();
    const f = form();
    if (!f.address || !f.password || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await mailboxes.create({
        provider: provider(),
        protocol: provider() === "mock" ? "mock" : protocol(),
        label: f.label || "New inbox",
        address: f.address,
        host: f.host || "mock",
        port: f.port,
        tls: provider() !== "mock",
        username: f.address,
        password: f.password,
      });
      props.onConnected();
      props.onClose();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not reach the Pigeon API.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div class="modal-overlay" onClick={props.onClose}>
          <div
            class="modal rise"
            role="dialog"
            aria-modal="true"
            aria-label="Add an inbox"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="modal-head">
              <div>
                <div class="modal-eyebrow">
                  Step {step()} of 2
                </div>
                <h2 class="modal-title">
                  <Show
                    when={step() === 1}
                    fallback={`Connect ${providerConfig(provider()).name}`}
                  >
                    Add an inbox
                  </Show>
                </h2>
              </div>
              <button
                class="icon-btn"
                aria-label="Close"
                onClick={props.onClose}
              >
                <CloseIcon />
              </button>
            </div>

            {/* Step 1 — provider grid */}
            <Show when={step() === 1}>
              <p class="modal-sub">
                Pick your email provider. Pigeon connects over IMAP with an
                app-specific password — it never sees your real login.
              </p>
              <div class="provider-grid">
                <For each={PROVIDERS}>
                  {(p) => {
                    const v = providerVisual(p.id);
                    return (
                      <button class="provider-tile" onClick={() => pick(p.id)}>
                        <span
                          class="provider-mark"
                          style={{ background: v.bg }}
                        >
                          {v.initials}
                        </span>
                        <span class="provider-name">{p.name}</span>
                      </button>
                    );
                  }}
                </For>
              </div>

              <Show when={(oauthProviders() ?? []).length > 0}>
                <p class="modal-sub" style={{ "margin-top": "12px" }}>
                  Or connect without a password:
                </p>
                <For each={oauthProviders()}>
                  {(p) => (
                    <a class="btn" style={{ width: "100%", "margin-top": "6px" }} href={oauth.startUrl(p.id)}>
                      Continue with {p.displayName}
                    </a>
                  )}
                </For>
              </Show>
            </Show>

            {/* Step 2 — credential form */}
            <Show when={step() === 2}>
              <form class="modal-form" onSubmit={submit}>
                <p class="hint provider-note">{providerConfig(provider()).note}</p>

                <Show when={provider() !== "mock"}>
                  <div class="field">
                    <label class="field-label">Protocol</label>
                    <div class="field-pair">
                      <button
                        type="button"
                        class="btn"
                        classList={{ "btn-primary": protocol() === "imap" }}
                        style={{ flex: 1 }}
                        onClick={() => pickProtocol("imap")}
                      >
                        IMAP (recommended)
                      </button>
                      <button
                        type="button"
                        class="btn"
                        classList={{ "btn-primary": protocol() === "pop3" }}
                        style={{ flex: 1 }}
                        disabled={providerConfig(provider()).pop3 === null}
                        title={
                          providerConfig(provider()).pop3 === null
                            ? `${providerConfig(provider()).name} does not offer POP3`
                            : ""
                        }
                        onClick={() => pickProtocol("pop3")}
                      >
                        POP3
                      </button>
                    </div>
                  </div>
                </Show>

                <div class="field">
                  <label class="field-label">Label</label>
                  <input
                    class="input"
                    placeholder="Personal, Work…"
                    value={form().label}
                    onInput={(e) =>
                      setForm({ ...form(), label: e.currentTarget.value })
                    }
                  />
                </div>

                <div class="field">
                  <label class="field-label">Email address</label>
                  <input
                    class="input"
                    type="email"
                    placeholder="you@example.com"
                    value={form().address}
                    onInput={(e) =>
                      setForm({ ...form(), address: e.currentTarget.value })
                    }
                  />
                </div>

                <div class="field">
                  <label class="field-label">App password</label>
                  <input
                    class="input"
                    type="password"
                    placeholder="xxxx xxxx xxxx xxxx"
                    value={form().password}
                    onInput={(e) =>
                      setForm({ ...form(), password: e.currentTarget.value })
                    }
                  />
                </div>

                <Show when={provider() !== "mock"}>
                  <div class="field-pair">
                    <div class="field" style={{ flex: "2" }}>
                      <label class="field-label">
                        {protocol() === "pop3" ? "POP3 server" : "IMAP server"}
                      </label>
                      <input
                        class="input webhook-input"
                        placeholder={protocol() === "pop3" ? "pop.example.com" : "imap.example.com"}
                        value={form().host}
                        onInput={(e) =>
                          setForm({ ...form(), host: e.currentTarget.value })
                        }
                      />
                    </div>
                    <div class="field" style={{ flex: "1" }}>
                      <label class="field-label">Port</label>
                      <input
                        class="input webhook-input"
                        type="number"
                        value={form().port}
                        onInput={(e) =>
                          setForm({
                            ...form(),
                            port: Number(e.currentTarget.value),
                          })
                        }
                      />
                    </div>
                  </div>
                </Show>

                <Show when={error()}>
                  <p class="auth-error">{error()}</p>
                </Show>

                <div class="modal-actions">
                  <Show when={!props.preset}>
                    <button
                      type="button"
                      class="btn"
                      onClick={() => setStep(1)}
                    >
                      Back
                    </button>
                  </Show>
                  <button
                    type="submit"
                    class="btn btn-primary"
                    style={{ flex: 1 }}
                    disabled={busy()}
                  >
                    {busy() ? "Testing connection…" : "Connect inbox"}
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
