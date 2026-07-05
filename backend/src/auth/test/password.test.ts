/**
 * Pure unit tests for the auth password crypto helpers (FR-A / FR-B / §3.1.2).
 *
 * No DB, no harness — just the `node:crypto`-backed helpers in
 * `backend/src/auth/password.ts`. These run fast and exercise the wire format
 * of the scrypt-encoded hash, the random-salt property, the strength/denylist
 * rules, and the safe-degradation of `verifyPassword` on malformed input.
 */
import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  isAcceptablePassword,
} from "../password";
// `resolveJsonModule` is on in tsconfig.base; the denylist file is created in
// GREEN. Importing it now makes this test RED until that file lands.
import denylist from "../common-passwords.json" with { type: "json" };

describe("password hashing", () => {
  it("hashPassword returns a scrypt:-prefixed string with 5 colons", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt:")).toBe(true);
    // Format `scrypt:N:r:p:saltHex:hashHex` => exactly 5 colons.
    const colonCount = (hash.match(/:/g) ?? []).length;
    expect(colonCount).toBe(5);
  });

  it("verifyPassword returns true for the correct password and false for a wrong one", () => {
    const pw = "aVerySecretPass!";
    const hash = hashPassword(pw);
    expect(verifyPassword(pw, hash)).toBe(true);
    expect(verifyPassword("wrongPassword!!!", hash)).toBe(false);
  });

  it("two hashPassword calls with the same password produce different hashes (random salt)", () => {
    const pw = "samePasswordHere1";
    const a = hashPassword(pw);
    const b = hashPassword(pw);
    expect(a).not.toBe(b);
  });

  it("verifyPassword with a garbage hash returns false and does not throw", () => {
    expect(() => verifyPassword("anything", "not-a-hash")).not.toThrow();
    expect(verifyPassword("anything", "not-a-hash")).toBe(false);
  });

  it("verifyPassword with an empty/corrupt scrypt:-prefixed string returns false without throwing", () => {
    expect(() => verifyPassword("anything", "scrypt:bad:data")).not.toThrow();
    expect(verifyPassword("anything", "scrypt:bad:data")).toBe(false);
  });
});

describe("isAcceptablePassword", () => {
  it("accepts a 12-character password", () => {
    expect(isAcceptablePassword("twelvechars1")).toBe(true);
  });

  it("rejects an 11-character password (too short)", () => {
    expect(isAcceptablePassword("elevenchars")).toBe(false);
  });

  it("rejects a denylist entry, case-insensitively", () => {
    // `noUncheckedIndexedAccess` is on — guard the first entry.
    const first = denylist[0];
    if (first === undefined) {
      throw new Error("common-passwords.json must contain at least one entry");
    }
    expect(isAcceptablePassword(first)).toBe(false);
    // Denylist match is case-insensitive (FR-B).
    expect(isAcceptablePassword(first.toUpperCase())).toBe(false);
  });

  it("accepts a non-denylist 12-character password", () => {
    expect(isAcceptablePassword("xK9!mQ2vR7#p")).toBe(true);
  });
});
