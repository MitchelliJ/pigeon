/**
 * Password hashing with node:crypto scrypt — no native dependencies.
 * Format: scrypt:N:r:p:salt_b64:hash_b64 (parameters stored per-hash so we
 * can raise them later without breaking existing hashes).
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// promisify(scrypt)'s types drop the options overload; wrap it explicitly.
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });
}

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scryptAsync(password, salt, KEYLEN, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  }));
  return `scrypt:${N}:${r}:${p}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(hashB64!, "base64");
  const actual = (await scryptAsync(password, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
    maxmem: 64 * 1024 * 1024,
  }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
