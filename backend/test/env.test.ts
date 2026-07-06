/*
 * Unit tests for `backend/src/env.ts`'s `parseEnvFile` — the pure parsing
 * logic behind the repo-root `.env` loader (no dotenv dependency). Only
 * `parseEnvFile` is exercised here (a string-in, object-out pure function);
 * `loadDotEnv`'s filesystem/process.env side effects are intentionally not
 * unit tested — it's a thin wrapper, and it's never called from anything a
 * test imports (see `env.ts`'s module comment).
 */
import { describe, it, expect } from "vitest";
import { parseEnvFile } from "../src/env";

describe("parseEnvFile", () => {
  it("parses simple KEY=value lines", () => {
    expect(parseEnvFile("PORT=8788\nHOST=0.0.0.0")).toEqual({
      PORT: "8788",
      HOST: "0.0.0.0",
    });
  });

  it("skips blank lines and full-line comments", () => {
    expect(
      parseEnvFile(
        "# a comment\n\nPORT=8788\n   \n# another comment\nHOST=0.0.0.0",
      ),
    ).toEqual({ PORT: "8788", HOST: "0.0.0.0" });
  });

  it("skips a commented-out KEY=value line entirely", () => {
    expect(parseEnvFile("# DATABASE_URL=postgres://x\nPORT=8788")).toEqual({
      PORT: "8788",
    });
  });

  it("strips matching surrounding double or single quotes from a value", () => {
    expect(
      parseEnvFile(
        `MAIL_FROM="Pigeon <noreply@pigeon.email>"\nLABEL='Work Inbox'`,
      ),
    ).toEqual({
      MAIL_FROM: "Pigeon <noreply@pigeon.email>",
      LABEL: "Work Inbox",
    });
  });

  it("trims surrounding whitespace around keys and unquoted values", () => {
    expect(parseEnvFile("  PORT   =   8788  ")).toEqual({ PORT: "8788" });
  });

  it("keeps the first '=' as the delimiter, so values may contain '='", () => {
    expect(parseEnvFile("VAULT_MASTER_KEY=abc=def==")).toEqual({
      VAULT_MASTER_KEY: "abc=def==",
    });
  });

  it("ignores a line with no '=' at all", () => {
    expect(parseEnvFile("not-a-valid-line\nPORT=8788")).toEqual({
      PORT: "8788",
    });
  });

  it("returns an empty object for empty input", () => {
    expect(parseEnvFile("")).toEqual({});
  });
});
