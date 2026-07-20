/* Unit tests for deterministic canonical message identity. */
import { describe, expect, it } from "vitest";
import { messageIdentityKey } from "../identity";

const base = {
  fromAddress: " Sender@Example.com ",
  subject: "  A   Subject ",
  body: "body\nexactly",
  receivedAt: new Date("2026-01-02T03:04:05.999Z"),
};

describe("messageIdentityKey", () => {
  it("normalizes RFC Message-ID", () => {
    expect(
      messageIdentityKey({ ...base, rfcMessageId: " <ABC@Example.COM> " }),
    ).toBe("rfc:abc@example.com");
  });

  it("uses normalized sender and subject, second precision, and exact body", () => {
    const key = messageIdentityKey(base);
    expect(
      messageIdentityKey({
        ...base,
        fromAddress: "sender@example.com",
        subject: "a subject",
        receivedAt: new Date("2026-01-02T03:04:05.001Z"),
      }),
    ).toBe(key);
    expect(messageIdentityKey({ ...base, body: "body\nexactly " })).not.toBe(
      key,
    );
    expect(key.startsWith("fallback:")).toBe(true);
  });
});
