import type { JSX } from "solid-js";
import { createResource, createSignal, Show } from "solid-js";
import { ApiError, profile } from "../lib/api";

export default function SettingsPanel(): JSX.Element {
  const [data] = createResource(() =>
    profile.get().catch((err) => {
      if (err instanceof ApiError && err.status === 401 && typeof window !== "undefined") {
        window.location.href = "/login";
      }
      throw err;
    }),
  );
  const [name, setName] = createSignal<string | null>(null);
  const [instructions, setInstructions] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  async function save(e: Event) {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    try {
      await profile.update({
        name: name() ?? undefined,
        llmInstructions: instructions() ?? undefined,
      });
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="page-wrap">
      <a class="page-back" href="/">← Back to dashboard</a>
      <h1 class="page-title">Settings</h1>

      <Show when={data()} fallback={<div class="state"><div class="spinner" /></div>}>
        {(p) => (
          <form class="card page-card modal-form" onSubmit={save}>
            <div class="field">
              <label class="field-label">Name</label>
              <input
                class="input"
                value={name() ?? p().name}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </div>

            <div class="field">
              <label class="field-label">Email</label>
              <input class="input" value={p().email} disabled />
            </div>

            <div class="field">
              <label class="field-label">Your triage instructions</label>
              <textarea
                class="input page-textarea"
                rows={6}
                placeholder={
                  "Tell Pigeon's AI how YOU triage. For example:\n" +
                  "Anything from my bank is urgent. Newsletters from substack are important, not noise. Recruiter emails are unimportant."
                }
                value={instructions() ?? p().llmInstructions}
                onInput={(e) => setInstructions(e.currentTarget.value)}
              />
              <p class="hint">
                These override Pigeon's default rules when emails are
                classified. Plain language works.
              </p>
            </div>

            <div class="modal-actions">
              <button class="btn btn-primary" type="submit" disabled={busy()}>
                {busy() ? "Saving…" : "Save settings"}
              </button>
              <Show when={saved()}>
                <span class="hint" style={{ "align-self": "center" }}>Saved ✓</span>
              </Show>
            </div>
          </form>
        )}
      </Show>
    </div>
  );
}
