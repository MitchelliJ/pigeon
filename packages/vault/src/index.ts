/**
 * Secrets vault: encryption-at-rest for mailbox credentials, OAuth tokens,
 * and channel webhooks. AES-256-GCM under a master key from the environment.
 *
 * Sealed format: `v1.<keyId>.<iv_b64url>.<ciphertext_b64url>.<tag_b64url>`
 * The key id is baked into the token and authenticated as AAD, so master-key
 * rotation works by keeping old keys available for `open` while sealing with
 * the newest.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export interface Vault {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

/**
 * @param keys keyId -> base64-encoded 32-byte key. `sealKeyId` (default:
 * lexicographically greatest id) is used for new seals; all keys can open.
 */
export function createVault(
  keys: Record<string, string>,
  sealKeyId?: string,
): Vault {
  const parsed = new Map<string, Buffer>();
  for (const [id, b64] of Object.entries(keys)) {
    if (/[.]/.test(id)) throw new VaultError(`key id "${id}" must not contain "."`);
    const buf = Buffer.from(b64, "base64");
    if (buf.length !== 32) {
      throw new VaultError(`vault key "${id}" must be 32 bytes (base64)`);
    }
    parsed.set(id, buf);
  }
  if (parsed.size === 0) throw new VaultError("vault needs at least one key");
  const activeId = sealKeyId ?? [...parsed.keys()].sort().at(-1)!;
  if (!parsed.has(activeId)) throw new VaultError(`unknown seal key "${activeId}"`);

  return {
    seal(plaintext: string): string {
      const key = parsed.get(activeId)!;
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALG, key, iv);
      cipher.setAAD(Buffer.from(`v1.${activeId}`));
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        "v1",
        activeId,
        iv.toString("base64url"),
        ct.toString("base64url"),
        tag.toString("base64url"),
      ].join(".");
    },

    open(sealed: string): string {
      const parts = sealed.split(".");
      if (parts.length !== 5 || parts[0] !== "v1") {
        throw new VaultError("malformed sealed secret");
      }
      const [, keyId, ivB64, ctB64, tagB64] = parts;
      const key = parsed.get(keyId!);
      if (!key) throw new VaultError(`sealed with unknown key "${keyId}"`);
      const decipher = createDecipheriv(ALG, key, Buffer.from(ivB64!, "base64url"));
      decipher.setAAD(Buffer.from(`v1.${keyId}`));
      decipher.setAuthTag(Buffer.from(tagB64!, "base64url"));
      try {
        return Buffer.concat([
          decipher.update(Buffer.from(ctB64!, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new VaultError("failed to open sealed secret (tampered or wrong key)");
      }
    },
  };
}

/** Convenience for the common single-key setup from VAULT_MASTER_KEY. */
export function createVaultFromMasterKey(masterKeyB64: string): Vault {
  return createVault({ k1: masterKeyB64 });
}
