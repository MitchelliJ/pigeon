import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import AuthCard from "./AuthCard";
import { ApiError, auth } from "../lib/api";

export default function AuthForm(props: {
  mode: "login" | "signup";
}): JSX.Element {
  const [form, setForm] = createSignal({
    name: "",
    email: "",
    password: "",
    inviteCode: "",
  });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Signup no longer returns a session (the real backend sends a verification
  // email instead, per FR-9) — flip this instead of redirecting.
  const [signupDone, setSignupDone] = createSignal(false);

  const isSignup = () => props.mode === "signup";

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const f = form();
      if (isSignup()) {
        await auth.signup({
          email: f.email,
          password: f.password,
          name: f.name,
          inviteCode: f.inviteCode,
        });
        setSignupDone(true);
        setBusy(false);
        return;
      }
      await auth.login({ email: f.email, password: f.password });
      window.location.href = "/";
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
      <Show
        when={!signupDone()}
        fallback={
          <>
            <h1 class="auth-title">Check your email</h1>
            <p class="auth-sub">
              We've sent a verification link to {form().email}. Follow it to
              activate your account.
            </p>
          </>
        }
      >
        <h1 class="auth-title">
          {isSignup() ? "Give your inbox a rest" : "Welcome back"}
        </h1>
        <p class="auth-sub">
          {isSignup()
            ? "Create an account — by signing up you accept the terms and privacy policy."
            : "Log in to your calm dashboard."}
        </p>

        <form class="modal-form" onSubmit={submit}>
          <Show when={isSignup()}>
            <div class="field">
              <label class="field-label">Name</label>
              <input
                class="input"
                required
                placeholder="Your name"
                autocomplete="name"
                value={form().name}
                onInput={(e) =>
                  setForm({ ...form(), name: e.currentTarget.value })
                }
              />
            </div>

            <div class="field">
              <label class="field-label">Invite code</label>
              <input
                class="input"
                required
                placeholder="Your invite code"
                autocomplete="off"
                value={form().inviteCode}
                onInput={(e) =>
                  setForm({ ...form(), inviteCode: e.currentTarget.value })
                }
              />
            </div>
          </Show>

          <div class="field">
            <label class="field-label">Email</label>
            <input
              class="input"
              type="email"
              required
              placeholder="you@example.com"
              autocomplete="email"
              value={form().email}
              onInput={(e) =>
                setForm({ ...form(), email: e.currentTarget.value })
              }
            />
          </div>

          <div class="field">
            <label class="field-label">Password</label>
            <input
              class="input"
              type="password"
              required
              minLength={12}
              placeholder={
                isSignup() ? "At least 12 characters" : "Your password"
              }
              autocomplete={isSignup() ? "new-password" : "current-password"}
              value={form().password}
              onInput={(e) =>
                setForm({ ...form(), password: e.currentTarget.value })
              }
            />
          </div>

          <Show when={!isSignup()}>
            <p
              class="auth-switch"
              style={{ margin: "-8px 0 0", "text-align": "right" }}
            >
              <a href="/forgot-password">Forgot password?</a>
            </p>
          </Show>

          <Show when={error()}>
            <p class="auth-error">{error()}</p>
          </Show>

          <button
            type="submit"
            class="btn btn-primary"
            disabled={busy()}
            style={{ width: "100%" }}
          >
            {busy() ? "One moment…" : isSignup() ? "Create account" : "Log in"}
          </button>
        </form>
      </Show>

      <p class="auth-switch">
        {isSignup() ? (
          <>
            Already have an account? <a href="/login">Log in</a>
          </>
        ) : (
          <>
            New here? <a href="/signup">Create an account</a>
          </>
        )}
      </p>
    </AuthCard>
  );
}
