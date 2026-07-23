/**
 * Confirm-email-change island for `/confirm-email?token=...`.
 *
 * Astro can't read the query string at build time, so this island reads the
 * token on mount, confirms it with the API, and only keeps the confirmed email
 * address for rendering. The token is never stored or rendered.
 */
import type { JSX } from "solid-js";
import { createSignal, Match, onMount, Switch } from "solid-js";
import AuthCard from "./AuthCard";
import { ApiError, profile } from "../lib/api";

type ConfirmState =
  "checking" | "success" | "missing" | "invalid" | "taken" | "failed";

export default function ConfirmEmailChange(): JSX.Element {
  const [state, setState] = createSignal<ConfirmState>("checking");
  const [email, setEmail] = createSignal("");

  onMount(async () => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setState("missing");
      return;
    }

    try {
      const confirmedProfile = await profile.confirmEmailChange({ token });
      setEmail(confirmedProfile.email);
      setState("success");
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "invalid_or_expired_token") {
          setState("invalid");
          return;
        }
        if (error.code === "email_taken") {
          setState("taken");
          return;
        }
      }
      setState("failed");
    }
  });

  return (
    <AuthCard>
      <Switch>
        <Match when={state() === "checking"}>
          <h1 class="auth-title">Confirming your new email…</h1>
          <p class="auth-sub" role="status">
            One moment while we check your confirmation link.
          </p>
        </Match>

        <Match when={state() === "success"}>
          <h1 class="auth-title">Your new email is confirmed</h1>
          <p class="auth-sub">
            Your account now uses <strong>{email()}</strong>.
          </p>
          <p class="auth-switch">
            <a href="/">Go to your dashboard</a> or <a href="/login">log in</a>.
          </p>
        </Match>

        <Match when={state() === "missing"}>
          <h1 class="auth-title">This confirmation link is incomplete</h1>
          <p class="auth-sub">
            The email-change link is missing required information. Please open
            the full link from your email.
          </p>
        </Match>

        <Match when={state() === "invalid"}>
          <h1 class="auth-title">This confirmation link is no longer valid</h1>
          <p class="auth-sub">
            This link may have expired or already been used. Please request a
            new email-change link from Settings.
          </p>
        </Match>

        <Match when={state() === "taken"}>
          <h1 class="auth-title">That email address is already in use</h1>
          <p class="auth-sub">
            Please choose another email address in Settings and request a new
            confirmation link.
          </p>
        </Match>

        <Match when={state() === "failed"}>
          <h1 class="auth-title">We couldn&apos;t confirm your new email</h1>
          <p class="auth-error" role="alert">
            Something went wrong while confirming your email change. Please try
            again.
          </p>
        </Match>
      </Switch>
    </AuthCard>
  );
}
