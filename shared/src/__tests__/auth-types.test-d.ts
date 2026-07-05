// Pure compile-time contract test for the auth-related shared types.
//
// This is a `.test-d.ts` file (NOT a `.test.ts` file): the root Vitest config
// only includes the shared test glob (see root vitest.config), so this file
// is never executed. It is type-checked by `pnpm --filter @pigeon/shared
// typecheck` because `shared/tsconfig.json` has `include: ["src"]`. No
// `vitest` import, no runtime, no `describe`/`it` — just assignments and
// `@ts-expect-error` directives that prove each interface has exactly the
// required shape.

import type {
  SessionUser,
  SignupInput,
  LoginInput,
  VerifyEmailInput,
  ResetRequestInput,
  ResetPasswordInput,
} from "../index";

// SessionUser — the signed-in person surfaced to the client after auth.
const _sessionUserComplete: SessionUser = {
  id: "user_123",
  email: "ada@example.com",
  name: "Ada Lovelace",
  tier: "pro",
};

// @ts-expect-error SessionUser must not exist on wrong shape
const _sessionUserMissingTier: SessionUser = {
  id: "user_123",
  email: "ada@example.com",
  name: "Ada Lovelace",
};

// SignupInput — `name` is required (not optional).
const _signupComplete: SignupInput = {
  inviteCode: "PIGEON-INVITE",
  email: "ada@example.com",
  password: "correct-horse-battery-staple",
  name: "Ada Lovelace",
};

// @ts-expect-error name is required
const _signupMissingName: SignupInput = {
  inviteCode: "PIGEON-INVITE",
  email: "ada@example.com",
  password: "correct-horse-battery-staple",
};

// @ts-expect-error inviteCode is required
const _signupMissingInviteCode: SignupInput = {
  email: "ada@example.com",
  password: "correct-horse-battery-staple",
  name: "Ada Lovelace",
};

// LoginInput — only email + password.
const _loginComplete: LoginInput = {
  email: "ada@example.com",
  password: "correct-horse-battery-staple",
};

// @ts-expect-error password is required
const _loginMissingPassword: LoginInput = {
  email: "ada@example.com",
};

// VerifyEmailInput — just the token.
const _verifyEmailComplete: VerifyEmailInput = {
  token: "verify-token-abc",
};

// @ts-expect-error token is required
const _verifyEmailMissingToken: VerifyEmailInput = {};

// ResetRequestInput — just the email.
const _resetRequestComplete: ResetRequestInput = {
  email: "ada@example.com",
};

// @ts-expect-error email is required
const _resetRequestMissingEmail: ResetRequestInput = {};

// ResetPasswordInput — token + new password.
const _resetPasswordComplete: ResetPasswordInput = {
  token: "reset-token-abc",
  newPassword: "fresh-horse-battery-staple",
};

// @ts-expect-error newPassword is required
const _resetPasswordMissingNewPassword: ResetPasswordInput = {
  token: "reset-token-abc",
};
