/**
 * Forgot-password island (Authentication & User Accounts PRD, FR-22).
 *
 * Collects an email, calls `auth.requestReset(email)`, and always shows the
 * same "if that email is registered…" message — the backend deliberately
 * returns 202 regardless of whether the address exists (no user
 * enumeration), so the frontend doesn't try to distinguish outcomes either,
 * beyond a genuine network/API error.
 */
import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import AuthCard from "./AuthCard";
import { ApiError, auth } from "../lib/api";

export default function ForgotPassword(): JSX.Element {
  const [email, setEmail] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [sent, setSent] = createSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.requestReset(email());
      setSent(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Something went wrong — is the API running?",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard>
      <Show
        when={!sent()}
        fallback={
          <>
            <h1 class="auth-title">Check your email</h1>
            <p class="auth-sub">
              If that email is registered, we've sent a reset link.
            </p>
          </>
        }
      >
        <h1 class="auth-title">Forgot your password?</h1>
        <p class="auth-sub">
          Enter your email and we'll send you a reset link.
        </p>

        <form class="modal-form" onSubmit={submit}>
          <div class="field">
            <label class="field-label">Email</label>
            <input
              class="input"
              type="email"
              required
              placeholder="you@example.com"
              autocomplete="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
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
            {busy() ? "One moment…" : "Send reset link"}
          </button>
        </form>
      </Show>

      <p class="auth-switch">
        Remembered it? <a href="/login">Log in</a>
      </p>
    </AuthCard>
  );
}
