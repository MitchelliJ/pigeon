/*
 * Email templates for the auth flow.
 *
 * Two emails, each rendered as plain text + minimal HTML:
 *   - verificationEmail: link `${baseUrl}/verify?token=${token}`
 *   - resetEmail:        link `${baseUrl}/reset-password?token=${token}`
 *
 * The action link appears in BOTH `html` and `text` so the email is usable in
 * plain-text-only clients. Per FR-29, tokens live only in the URL — never
 * stored anywhere in plaintext.
 */

export interface MailTemplate {
  subject: string;
  html: string;
  text: string;
}

interface TemplateInput {
  to: string;
  baseUrl: string;
  token: string;
}

/** Build the verification email for the verify-email flow (PRD FR-5). */
export function verificationEmail(input: TemplateInput): MailTemplate {
  const link = `${input.baseUrl}/verify?token=${input.token}`;
  return {
    subject: "Verify your Pigeon account",
    html: [
      "<p>Welcome to Pigeon!</p>",
      `<p>Confirm your email address by clicking the link below:</p>`,
      `<p><a href="${link}">${link}</a></p>`,
      "<p>If you didn't create an account, you can ignore this email.</p>",
    ].join("\n"),
    text: [
      "Welcome to Pigeon!",
      "",
      "Confirm your email address by opening the link below:",
      link,
      "",
      "If you didn't create an account, you can ignore this email.",
    ].join("\n"),
  };
}

/** Build the password-reset email for the forgot-password flow (PRD FR-21). */
export function resetEmail(input: TemplateInput): MailTemplate {
  const link = `${input.baseUrl}/reset-password?token=${input.token}`;
  return {
    subject: "Reset your Pigeon password",
    html: [
      "<p>We received a request to reset your Pigeon password.</p>",
      `<p>Set a new password by clicking the link below:</p>`,
      `<p><a href="${link}">${link}</a></p>`,
      "<p>If you didn't request this, you can ignore this email.</p>",
    ].join("\n"),
    text: [
      "We received a request to reset your Pigeon password.",
      "",
      "Set a new password by opening the link below:",
      link,
      "",
      "If you didn't request this, you can ignore this email.",
    ].join("\n"),
  };
}

/** Build the new-email confirmation email for the change-email flow. */
export function changeEmailConfirmation(input: TemplateInput): MailTemplate {
  const link = `${input.baseUrl}/confirm-email?token=${input.token}`;
  return {
    subject: "Confirm your new email",
    html: [
      "<p>We received a request to change your Pigeon email address.</p>",
      "<p>Confirm your new email by clicking the link below:</p>",
      `<p><a href="${link}">${link}</a></p>`,
      "<p>If you didn't request this, you can ignore this email.</p>",
    ].join("\n"),
    text: [
      "We received a request to change your Pigeon email address.",
      "",
      "Confirm your new email by opening the link below:",
      link,
      "",
      "If you didn't request this, you can ignore this email.",
    ].join("\n"),
  };
}

/** Build the old-email notice for the change-email flow. */
export function emailChangeNotice(_input: TemplateInput): MailTemplate {
  return {
    subject: "Request to change your email address",
    html: [
      "<p>We received a request to change your Pigeon account email address.</p>",
      "<p>If you didn't request this, you can ignore this email.</p>",
    ].join("\n"),
    text: [
      "We received a request to change your Pigeon account email address.",
      "",
      "If you didn't request this, you can ignore this email.",
    ].join("\n"),
  };
}
