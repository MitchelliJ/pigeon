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
  ChangePasswordInput,
  RequestEmailChangeInput,
  ConfirmEmailChangeInput,
  ProfileSettings,
  RequestAccountDeletionInput,
  AccountDeletionStatus,
  RequestAccountDeletionResult,
  CancelAccountDeletionResult,
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

// ChangePasswordInput — current + new password are both required.
const _changePasswordComplete: ChangePasswordInput = {
  currentPassword: "current-horse-battery-staple",
  newPassword: "fresh-horse-battery-staple",
};

// @ts-expect-error currentPassword is required
const _changePasswordMissingCurrentPassword: ChangePasswordInput = {
  newPassword: "fresh-horse-battery-staple",
};

// RequestEmailChangeInput — current password + new email.
const _requestEmailChangeComplete: RequestEmailChangeInput = {
  currentPassword: "current-horse-battery-staple",
  newEmail: "ada.next@example.com",
};

// @ts-expect-error newEmail is required
const _requestEmailChangeMissingNewEmail: RequestEmailChangeInput = {
  currentPassword: "current-horse-battery-staple",
};

// ConfirmEmailChangeInput — just the single-use token.
const _confirmEmailChangeComplete: ConfirmEmailChangeInput = {
  token: "change-email-token-abc",
};

// @ts-expect-error token is required
const _confirmEmailChangeMissingToken: ConfirmEmailChangeInput = {};

// ProfileSettings — authenticated settings/profile response shape.
const _profileSettingsComplete: ProfileSettings = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  tier: "pro",
  deletionRequestedAt: null,
  deletesAt: "2026-07-21T09:30:00.000Z",
};

// @ts-expect-error deletionRequestedAt is required even when null
const _profileSettingsMissingDeletionRequestedAt: ProfileSettings = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  tier: "pro",
  deletesAt: null,
};

// RequestAccountDeletionInput — password + exact confirmation phrase.
const _requestAccountDeletionComplete: RequestAccountDeletionInput = {
  password: "current-horse-battery-staple",
  confirm: "delete my account",
};

const _requestAccountDeletionWrongConfirm: RequestAccountDeletionInput = {
  password: "current-horse-battery-staple",
  // @ts-expect-error confirm must be the exact literal
  confirm: "DELETE MY ACCOUNT",
};

// AccountDeletionStatus — nullable when no deletion is scheduled.
const _accountDeletionStatusIdle: AccountDeletionStatus = {
  requestedAt: null,
  deletesAt: null,
};

const _accountDeletionStatusScheduled: AccountDeletionStatus = {
  requestedAt: "2026-07-20T09:30:00.000Z",
  deletesAt: "2026-07-21T09:30:00.000Z",
};

// RequestAccountDeletionResult — request succeeded and deletion is scheduled.
const _requestAccountDeletionResultComplete: RequestAccountDeletionResult = {
  ok: true,
  requestedAt: "2026-07-20T09:30:00.000Z",
  deletesAt: "2026-07-21T09:30:00.000Z",
};

const _requestAccountDeletionResultWrongOk: RequestAccountDeletionResult = {
  // @ts-expect-error ok must be the literal true
  ok: false,
  requestedAt: "2026-07-20T09:30:00.000Z",
  deletesAt: "2026-07-21T09:30:00.000Z",
};

// CancelAccountDeletionResult — successful cancellation only returns ok.
const _cancelAccountDeletionResultComplete: CancelAccountDeletionResult = {
  ok: true,
};

const _cancelAccountDeletionResultWrongOk: CancelAccountDeletionResult = {
  // @ts-expect-error ok must be the literal true
  ok: false,
};
