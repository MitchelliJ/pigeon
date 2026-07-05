/**
 * Verify-email island (Authentication & User Accounts PRD, FR-8/FR-9).
 *
 * The verification link mailed on sign-up points at `/verify?token=...`.
 * Astro's static output can't read query params server-side, so this island
 * reads `location.search` on mount, calls `auth.verifyEmail(token)`, and:
 *   - on success (backend mints a session), redirects to `/`
 *   - on failure, shows an error with a resend-email fallback
 */
import type { JSX } from "solid-js";
import { createSignal, Match, onMount, Show, Switch } from "solid-js";
import AuthCard from "./AuthCard";
import { ApiError, auth } from "../lib/api";

type VerifyState = "checking" | "no_token" | "failed" | "resent";

export default function VerifyEmail(): JSX.Element {
  const [state, setState] = createSignal<VerifyState>("checking");
  const [error, setError] = createSignal<string | null>(null);
  const [resendEmail, setResendEmail] = createSignal("");
  const [resendBusy, setResendBusy] = createSignal(false);

  onMount(async () => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setState("no_token");
      return;
    }
    try {
      await auth.verifyEmail(token);
      window.location.href = "/";
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "This link is invalid or has expired.",
      );
      setState("failed");
    }
  });

  async function resend(e: Event) {
    e.preventDefault();
    setResendBusy(true);
    try {
      await auth.resendVerify(resendEmail());
      setState("resent");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Something went wrong — is the API running?",
      );
    } finally {
      setResendBusy(false);
    }
  }

  return (
    <AuthCard>
      <Switch>
        <Match when={state() === "checking"}>
          <h1 class="auth-title">Verifying your email…</h1>
          <p class="auth-sub">One moment.</p>
        </Match>

        <Match when={state() === "resent"}>
          <h1 class="auth-title">Check your email</h1>
          <p class="auth-sub">
            If that address needs verifying, we've sent a fresh link to{" "}
            {resendEmail()}.
          </p>
        </Match>

        <Match when={state() === "no_token" || state() === "failed"}>
          <h1 class="auth-title">This link is invalid or has expired</h1>
          <p class="auth-sub">Request a new verification email below.</p>

          <form class="modal-form" onSubmit={resend}>
            <div class="field">
              <label class="field-label">Email</label>
              <input
                class="input"
                type="email"
                required
                placeholder="you@example.com"
                autocomplete="email"
                value={resendEmail()}
                onInput={(e) => setResendEmail(e.currentTarget.value)}
              />
            </div>

            <Show when={error()}>
              <p class="auth-error">{error()}</p>
            </Show>

            <button
              type="submit"
              class="btn btn-primary"
              disabled={resendBusy()}
              style={{ width: "100%" }}
            >
              {resendBusy() ? "One moment…" : "Resend verification email"}
            </button>
          </form>
        </Match>
      </Switch>

      <p class="auth-switch">
        Already verified? <a href="/login">Log in</a>
      </p>
    </AuthCard>
  );
}
