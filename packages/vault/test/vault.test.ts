import { describe, expect, it } from "vitest";
import { createVault, createVaultFromMasterKey, VaultError } from "../src/index.js";

const keyA = Buffer.alloc(32, 1).toString("base64");
const keyB = Buffer.alloc(32, 2).toString("base64");

describe("vault", () => {
  it("round-trips secrets", () => {
    const vault = createVaultFromMasterKey(keyA);
    const secret = "imap password: hunter2 🕊️";
    const sealed = vault.seal(secret);
    expect(sealed).not.toContain("hunter2");
    expect(vault.open(sealed)).toBe(secret);
  });

  it("produces a different token every seal (random IV)", () => {
    const vault = createVaultFromMasterKey(keyA);
    expect(vault.seal("x")).not.toBe(vault.seal("x"));
  });

  it("rejects tampered ciphertext", () => {
    const vault = createVaultFromMasterKey(keyA);
    const sealed = vault.seal("secret");
    const parts = sealed.split(".");
    parts[3] = parts[3]!.slice(0, -2) + "AA";
    expect(() => vault.open(parts.join("."))).toThrow(VaultError);
  });

  it("rejects wrong key", () => {
    const sealed = createVaultFromMasterKey(keyA).seal("secret");
    expect(() => createVaultFromMasterKey(keyB).open(sealed)).toThrow(VaultError);
  });

  it("supports rotation: seals with newest, opens old", () => {
    const old = createVault({ k1: keyA });
    const sealedOld = old.seal("legacy secret");
    const rotated = createVault({ k1: keyA, k2: keyB });
    expect(rotated.open(sealedOld)).toBe("legacy secret");
    const sealedNew = rotated.seal("new secret");
    expect(sealedNew.split(".")[1]).toBe("k2");
    expect(rotated.open(sealedNew)).toBe("new secret");
  });

  it("rejects short keys", () => {
    expect(() => createVaultFromMasterKey("dG9vc2hvcnQ=")).toThrow(VaultError);
  });
});
