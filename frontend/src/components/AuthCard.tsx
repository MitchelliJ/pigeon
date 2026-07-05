/**
 * Shared shell for the auth islands (AuthForm, VerifyEmail, ForgotPassword,
 * ResetPassword) — the centered card with the Pigeon brand mark. Pulled out
 * because all four repeated this markup verbatim.
 */
import type { JSX } from "solid-js";

export default function AuthCard(props: {
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class="auth-wrap">
      <div class="auth-card rise">
        <div class="auth-brand">
          <span class="brand-mark">🕊️</span>
          <span class="brand-name">Pigeon</span>
        </div>
        {props.children}
      </div>
    </div>
  );
}
