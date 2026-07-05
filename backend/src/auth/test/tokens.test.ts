/**
 * Pure unit tests for the auth token/invite crypto helpers (§3.1.2, FR-24).
 *
 * No DB, no harness — just the `node:crypto`-backed helpers in
 * `backend/src/auth/tokens.ts`. Covers the length/charset invariants of the
 * opaque session/verify/reset tokens (base64url of 32 bytes => 43 chars), the
 * sha256 at-rest hash, determinism, and the base32 invite-code generator.
 */
import { describe, it, expect } from "vitest";
import { generateToken, hashToken, generateInviteCode } from "../tokens";

describe("tokens", () => {
  it("generateToken returns a 43-char base64url string ([A-Za-z0-9_-])", () => {
    const t = generateToken();
    expect(t).toHaveLength(43);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("two generateToken calls produce different strings", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });

  it("hashToken returns a 64-char lowercase hex string (sha256)", () => {
    const h = hashToken(generateToken());
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashToken is deterministic: same input => same output", () => {
    const input = "stable-input-value";
    expect(hashToken(input)).toBe(hashToken(input));
  });

  it("generateInviteCode returns ~15 base32 chars ([A-Z2-7]) and two calls differ", () => {
    const a = generateInviteCode();
    const b = generateInviteCode();
    // `randomBytes(9)` => 72 bits => 15 base32 chars (RFC 4648, no padding).
    expect(a).toMatch(/^[A-Z2-7]{15}$/);
    expect(b).toMatch(/^[A-Z2-7]{15}$/);
    expect(a).not.toBe(b);
  });
});
