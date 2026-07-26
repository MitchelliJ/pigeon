/**
 * Unit tests for the PKCE helper (OAuth Provider Connectors PRD): code
 * verifier/challenge generation (RFC 7636, S256) and state generation.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  generateCodeVerifier,
  computeCodeChallenge,
  generateState,
} from "../pkce";

const URL_SAFE = /^[A-Za-z0-9\-_]+$/;

describe("pkce", () => {
  describe("generateCodeVerifier", () => {
    it("returns a URL-safe string within the RFC 7636 length range", () => {
      const verifier = generateCodeVerifier();

      expect(verifier).toMatch(URL_SAFE);
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
    });

    it("produces a different value on each call", () => {
      expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
    });
  });

  describe("computeCodeChallenge", () => {
    it("matches the manually computed S256 base64url digest for fixed samples", () => {
      const samples = [
        "abc123abc123abc123abc123abc123abc123abc123",
        "the-quick-brown-fox-jumps-over-the-lazy-dog-1234567890",
      ];

      for (const verifier of samples) {
        const expected = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        expect(computeCodeChallenge(verifier)).toBe(expected);
      }
    });

    it("matches the manually computed digest for a generated verifier", () => {
      const verifier = generateCodeVerifier();
      const expected = createHash("sha256")
        .update(verifier)
        .digest("base64url");

      expect(computeCodeChallenge(verifier)).toBe(expected);
    });

    it("is URL-safe with no padding", () => {
      const challenge = computeCodeChallenge(generateCodeVerifier());

      expect(challenge).toMatch(URL_SAFE);
      expect(challenge).not.toContain("=");
    });
  });

  describe("generateState", () => {
    it("returns a URL-safe string", () => {
      expect(generateState()).toMatch(URL_SAFE);
    });

    it("produces a different value on each call", () => {
      expect(generateState()).not.toBe(generateState());
    });
  });
});
