/**
 * Password hashing and strength checking for auth (FR-A / FR-B / §3.1.2).
 *
 * What: scrypt-based password hashing with per-hash params + random salt, and a
 * denylist-aware "is this password acceptable" gate.
 * Why: we store only a salted, memory-hard scrypt digest of the password; the
 * encoded form keeps the cost params next to the hash so they can be tuned per
 * hash without breaking older hashes. Strength gating keeps the trivially
 * common passwords out (FR-B). Uses only `node:crypto` — no extra deps.
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import denylist from "./common-passwords.json" with { type: "json" };

// scrypt cost params — N=2^15, r=8, p=1 (per PRD §3.1.2).
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// Why 2x headroom: scrypt needs 128 * r * N bytes (~32MB at these params),
// which collides with Node's default maxmem. 2x is safe and standard.
const SCRYPT_MAXMEM = 128 * SCRYPT_R * SCRYPT_N * 2;
const KEY_LEN = 32;
const SALT_LEN = 16;

// Lowercased denylist as a Set for O(1), case-insensitive lookup.
const DENYLIST: ReadonlySet<string> = new Set(
  (denylist as string[]).map((p) => p.toLowerCase()),
);

/**
 * Hash a password with scrypt + random salt. Returns the self-describing
 * `scrypt:N:r:p:saltHex:hashHex` string so cost params travel with the hash.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString(
    "hex",
  )}:${hash.toString("hex")}`;
}

/**
 * Verify a password against an encoded `scrypt:N:r:p:salt:hash` string.
 * Returns `false` (never throws) for any malformed input or mismatch.
 */
export function verifyPassword(password: string, encoded: string): boolean {
  try {
    // Why split with limit 6: exactly 5 colons => 6 fields, hex blobs may be
    // empty but the shape must hold.
    const parts = encoded.split(":");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const saltHex = parts[4]!;
    const hashHex = parts[5]!;
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
      return false;
    }
    if (N <= 0 || r <= 0 || p <= 0) return false;
    // Why regex guard: parse + re-encode could accept non-hex; require hex.
    if (!/^[0-9a-fA-F]*$/.test(saltHex) || !/^[0-9a-fA-F]*$/.test(hashHex)) {
      return false;
    }
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    if (expected.length === 0) return false;
    const actual = scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    // Why timingSafeEqual: constant-time comparison to avoid timing leaks.
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A password is acceptable when it is at least 12 chars AND not in the common
 * denylist (case-insensitive).
 */
export function isAcceptablePassword(password: string): boolean {
  if (password.length < 12) return false;
  return !DENYLIST.has(password.toLowerCase());
}
