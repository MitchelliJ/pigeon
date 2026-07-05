/**
 * Reset-password island (Authentication & User Accounts PRD, FR-23).
 *
 * Reads `?token=` from the URL (Astro's static output can't do this
 * server-side, so it happens client-side on mount, same as VerifyEmail),
 * collects a new password, and calls `auth.resetPassword`. Success does NOT
 * auto-login — the PRD requires the user to log in again with the new
 * password — so we redirect to /login rather than /.
 */
import type { JSX } from "solid-js";
import { createSignal, onMount, Show } from "solid-js";
import AuthCard from "./AuthCard";
import { ApiError, auth } from "../lib/api";

export default function ResetPassword(): JSX.Element {
  const [token, setToken] = createSignal<string | null>(null);
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  });

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    const t = token();
    if (!t) {
      setError("This link is invalid or has expired.");
      return;
    }
    setBusy(true);
    try {
      await auth.resetPassword({ token: t, newPassword: password() });
      window.location.href = "/login";
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Something went wrong — is the API running?",
      );
      setBusy(false);
    }
  }

  return (
    <AuthCard>
      <h1 class="auth-title">Choose a new password</h1>
      <p class="auth-sub">Pick something you haven't used before.</p>

      <form class="modal-form" onSubmit={submit}>
        <div class="field">
          <label class="field-label">New password</label>
          <input
            class="input"
            type="password"
            required
            minLength={12}
            placeholder="At least 12 characters"
            autocomplete="new-password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </div>

        <Show when={error()}>
          <p class="auth-error">{error()}</p>
        </Show>

        <button
          type="submit"
          class="btn btn-primary"
          disabled={busy()}
          style={{ width: "100%" }}
        >
          {busy() ? "One moment…" : "Reset password"}
        </button>
      </form>

      <p class="auth-switch">
        Remembered it after all? <a href="/login">Log in</a>
      </p>
    </AuthCard>
  );
}
