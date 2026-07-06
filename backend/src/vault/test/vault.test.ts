/*
 * Unit tests for the vault module — AES-256-GCM sealing/opening of secrets at
 * rest (PRD "Inbox Connectors & Provider Abstraction" §3.1, FR-1..FR-3).
 *
 * Pure unit tests: no DB, no harness, just `createVault(masterKeyBase64)`
 * from `../index` exercised against `node:crypto`-generated keys. Covers the
 * round-trip, the random-IV property, the wire format, tamper detection on
 * both the ciphertext and auth-tag segments, cross-key failure, and the
 * fail-fast validation of the master key itself.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { createVault } from "../index";

function validKey(): string {
  return randomBytes(32).toString("base64");
}

describe("vault seal/open", () => {
  it("round-trips a plaintext through seal then open", () => {
    const vault = createVault(validKey());
    const sealed = vault.seal("hello");
    expect(vault.open(sealed)).toBe("hello");
  });

  it("produces a different sealed string each time (random IV) but both open back to the original", () => {
    const vault = createVault(validKey());
    const a = vault.seal("hello");
    const b = vault.seal("hello");
    expect(a).not.toBe(b);
    expect(vault.open(a)).toBe("hello");
    expect(vault.open(b)).toBe("hello");
  });

  it("sealed format is gcm:<iv>:<authTag>:<ciphertext> with exactly 4 colon-separated segments", () => {
    const vault = createVault(validKey());
    const sealed = vault.seal("hello");
    expect(sealed.startsWith("gcm:")).toBe(true);
    expect(sealed.split(":")).toHaveLength(4);
  });

  it("throws on open when the ciphertext segment has been tampered with", () => {
    const vault = createVault(validKey());
    const sealed = vault.seal("hello");
    const parts = sealed.split(":");
    const ciphertext = parts[3] ?? "";
    const flippedChar = ciphertext[0] === "A" ? "B" : "A";
    const tamperedCiphertext = flippedChar + ciphertext.slice(1);
    const tampered = [parts[0], parts[1], parts[2], tamperedCiphertext].join(
      ":",
    );
    expect(() => vault.open(tampered)).toThrow();
  });

  it("throws on open when the auth-tag segment has been tampered with", () => {
    const vault = createVault(validKey());
    const sealed = vault.seal("hello");
    const parts = sealed.split(":");
    const authTag = parts[2] ?? "";
    const flippedChar = authTag[0] === "A" ? "B" : "A";
    const tamperedAuthTag = flippedChar + authTag.slice(1);
    const tampered = [parts[0], parts[1], tamperedAuthTag, parts[3]].join(":");
    expect(() => vault.open(tampered)).toThrow();
  });

  it("throws when opening a value sealed under a different key", () => {
    const vaultA = createVault(validKey());
    const vaultB = createVault(validKey());
    const sealed = vaultA.seal("hello");
    expect(() => vaultB.open(sealed)).toThrow();
  });

  it("throws immediately at createVault() call time when the key is not valid base64", () => {
    expect(() => createVault("not-valid-base64!!!")).toThrow();
  });

  it("throws immediately at createVault() call time when the key does not decode to exactly 32 bytes", () => {
    const tooShort = randomBytes(16).toString("base64");
    const tooLong = randomBytes(33).toString("base64");
    expect(() => createVault(tooShort)).toThrow();
    expect(() => createVault(tooLong)).toThrow();
  });
});
