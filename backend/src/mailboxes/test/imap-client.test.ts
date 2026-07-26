/*
 * Unit tests for `defaultImapFlowFactory`'s credential-to-`auth` mapping
 * (Feature 13 "OAuth Provider Connectors"). `imapflow` is mocked so
 * constructing an `ImapFlow` never touches a real socket; the constructor
 * options passed to the mock are the assertion surface.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn(),
}));

import { ImapFlow } from "imapflow";
import { defaultImapFlowFactory } from "../connectors/imap-client";

const MockImapFlow = ImapFlow as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => MockImapFlow.mockClear());

describe("defaultImapFlowFactory auth mapping", () => {
  it("uses password auth when params carry a password", () => {
    defaultImapFlowFactory({
      host: "h",
      port: 993,
      tls: true,
      username: "alice",
      password: "s3cret",
    } as never);

    const auth = MockImapFlow.mock.calls[0]![0].auth;
    expect(auth).toEqual({ user: "alice", pass: "s3cret" });
    expect(auth.accessToken).toBeUndefined();
  });

  it("uses XOAUTH2 access-token auth when params carry an accessToken", () => {
    defaultImapFlowFactory({
      host: "h",
      port: 993,
      tls: true,
      username: "alice",
      accessToken: "at-xyz",
    } as never);

    const auth = MockImapFlow.mock.calls[0]![0].auth;
    expect(auth).toEqual({ user: "alice", accessToken: "at-xyz" });
    expect(auth.pass).toBeUndefined();
  });
});
