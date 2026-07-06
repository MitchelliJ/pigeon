/*
 * Vault module — AES-256-GCM sealing of secrets at rest (PRD "Inbox
 * Connectors & Provider Abstraction" §3.1, FR-1..FR-3). Provider credentials
 * (IMAP passwords, OAuth tokens, webhook secrets) must never touch the
 * database in plaintext (see coding guidelines §2 "Secrets & config"), so
 * every module that persists such a value seals it through `createVault`
 * first and opens it again just before use.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const SEALED_PREFIX = "gcm";

/** A sealed secret + the ability to open it again, bound to one master key. */
export interface Vault {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

/**
 * Build a `Vault` from a base64-encoded 32-byte AES-256 key.
 *
 * The key is validated immediately (fail fast, per coding guidelines §3 error
 * handling) rather than on first use, so a misconfigured key crashes at
 * startup instead of surfacing as a mysterious runtime error the first time a
 * secret is sealed or opened.
 */
export function createVault(masterKeyBase64: string): Vault {
  const key = decodeMasterKey(masterKeyBase64);

  return {
    seal(plaintext: string): string {
      const iv = randomBytes(IV_LENGTH_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      return [
        SEALED_PREFIX,
        iv.toString("base64"),
        authTag.toString("base64"),
        ciphertext.toString("base64"),
      ].join(":");
    },

    open(sealed: string): string {
      const parts = sealed.split(":");
      if (parts.length !== 4 || parts[0] !== SEALED_PREFIX) {
        throw new Error(
          `vault.open: expected format "${SEALED_PREFIX}:<iv>:<authTag>:<ciphertext>"`,
        );
      }
      const [, ivBase64, authTagBase64, ciphertextBase64] = parts;
      const iv = Buffer.from(ivBase64 ?? "", "base64");
      const authTag = Buffer.from(authTagBase64 ?? "", "base64");
      const ciphertext = Buffer.from(ciphertextBase64 ?? "", "base64");

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    },
  };
}

// `Buffer.from(str, "base64")` silently ignores characters outside the
// base64 alphabet instead of throwing, so malformed input has to be rejected
// with an explicit format check before decoding.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode + validate a base64-encoded master key, throwing if it isn't
 * valid base64 or doesn't decode to exactly 32 bytes (AES-256 key length).
 *
 * Exported so `backend/src/config/index.ts` can validate `VAULT_MASTER_KEY`
 * at startup using the exact same rules `createVault` enforces later,
 * without duplicating the base64/length checks.
 */
export function decodeMasterKey(masterKeyBase64: string): Buffer {
  if (
    masterKeyBase64.length % 4 !== 0 ||
    !BASE64_PATTERN.test(masterKeyBase64)
  ) {
    throw new Error("createVault: masterKeyBase64 is not valid base64");
  }

  const key = Buffer.from(masterKeyBase64, "base64");

  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `createVault: masterKeyBase64 must decode to exactly ${KEY_LENGTH_BYTES} bytes (AES-256 key), got ${key.length}`,
    );
  }

  return key;
}
