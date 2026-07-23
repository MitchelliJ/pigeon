/*
 * Unit tests for the mail templates (verification + password reset).
 *
 * Templates must render the action link in BOTH html and text so the email
 * is usable in plain-text-only clients. Links are built from baseUrl + token.
 */

import { describe, it, expect } from "vitest";
import {
  verificationEmail,
  resetEmail,
  changeEmailConfirmation,
  emailChangeNotice,
} from "../templates";

describe("mail templates", () => {
  it("verificationEmail renders the verify link in html and text", () => {
    const mail = verificationEmail({
      to: "ada@x",
      baseUrl: "https://app.pigeon.email",
      token: "tok123",
    });
    expect(typeof mail.subject).toBe("string");
    expect(mail.subject.length).toBeGreaterThan(0);
    const link = "https://app.pigeon.email/verify?token=tok123";
    expect(mail.html).toContain(link);
    expect(mail.text).toContain(link);
  });

  it("resetEmail renders the reset link in html and text", () => {
    const mail = resetEmail({
      to: "ada@x",
      baseUrl: "https://app.pigeon.email",
      token: "rtok456",
    });
    expect(typeof mail.subject).toBe("string");
    expect(mail.subject.length).toBeGreaterThan(0);
    const link = "https://app.pigeon.email/reset-password?token=rtok456";
    expect(mail.html).toContain(link);
    expect(mail.text).toContain(link);
  });

  it("changeEmailConfirmation targets confirming the new email without leaking the token outside the action URL", () => {
    const token = "change-tok-789";
    const link = `https://app.pigeon.email/confirm-email?token=${token}`;
    const mail = changeEmailConfirmation({
      to: "new-address@x",
      baseUrl: "https://app.pigeon.email",
      token,
    });

    expect(mail.subject).toMatch(/confirm.*email/i);
    expect(mail.html).toContain(link);
    expect(mail.text).toContain(link);
    expect(`${mail.subject}\n${mail.html}\n${mail.text}`).toMatch(/new email/i);
    expect(mail.html.split(link).join("")).not.toContain(token);
    expect(mail.text.split(link).join("")).not.toContain(token);
  });

  it("emailChangeNotice tells the old address an email-change request was made without including a confirmation token", () => {
    const token = "old-address-change-tok";
    const mail = emailChangeNotice({
      to: "old-address@x",
      baseUrl: "https://app.pigeon.email",
      token,
    });

    expect(`${mail.subject}\n${mail.html}\n${mail.text}`).toMatch(
      /request to change.*email address/i,
    );
    expect(`${mail.subject}\n${mail.html}\n${mail.text}`).not.toContain(token);
  });
});
