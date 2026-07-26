/**
 * PKCE (RFC 7636, S256) helpers for OAuth Provider Connectors.
 */
import { createHash, randomBytes } from "node:crypto";

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function computeCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}
