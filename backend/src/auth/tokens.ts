/**
 * Opaque token and invite-code crypto helpers for auth (§3.1.2, FR-24).
 *
 * What: generate random opaque tokens (session/verify/reset), hash them at rest
 * with sha256, and generate human-friendly base32 invite codes.
 * Why: tokens are random unguessable strings; we never store them verbatim —
 * only their sha256 digest, so a DB leak is useless. Invite codes use the RFC
 * 4648 base32 alphabet so they're easy to type. Only `node:crypto` is used.
 */
import { randomBytes, createHash } from "node:crypto";

// RFC 4648 base32 alphabet (no padding).
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Generate a 43-char base64url token from 32 random bytes. This is the opaque
 * credential handed to the user; only its hash is stored.
 */
export function generateToken(): string {
  // Why base64url: URL-safe, no padding, 32 bytes => exactly 43 chars.
  return randomBytes(32).toString("base64url");
}

/**
 * Hash a token with sha256 for at-rest storage. Returns 64-char lowercase hex.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Generate a 15-char base32 invite code from 9 random bytes (72 bits).
 * Uses the RFC 4648 base32 alphabet (A-Z2-7), uppercase, no padding.
 */
export function generateInviteCode(): string {
  const bytes = randomBytes(9);
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    // Why accumulate bits and emit 5 at a time: base32 packs 5 bits per char.
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const index = (value >>> bits) & 0x1f;
      // noUncheckedIndexedAccess: alphabet[index] is string | undefined.
      const ch = BASE32_ALPHABET[index];
      out += ch ?? "";
      // Why mask off consumed high bits: keeps `value` bounded as we go.
      value &= (1 << bits) - 1;
    }
  }
  // Why a final char: leftover bits (72 % 5 = 2) still encode one symbol.
  if (bits > 0) {
    const index = (value << (5 - bits)) & 0x1f;
    const ch = BASE32_ALPHABET[index];
    out += ch ?? "";
  }
  return out;
}
