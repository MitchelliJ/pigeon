/*
 * Unit tests for the mail templates (verification + password reset).
 *
 * Templates must render the action link in BOTH html and text so the email
 * is usable in plain-text-only clients. Links are built from baseUrl + token.
 */

import { describe, it, expect } from "vitest";
import { verificationEmail, resetEmail } from "../templates";

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
});
