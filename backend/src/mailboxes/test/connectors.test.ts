/*
 * Integration tests for the hand-rolled IMAP/POP3 connection-testing
 * connectors (PRD "Inbox Connectors & Provider Abstraction" §3.2.2 FR-4/FR-5,
 * §3.5 FR-19).
 *
 * RED note: `backend/src/mailboxes/connectors/{types,imap,pop3,index}.ts` do
 * not exist yet — this file's only production import, `getConnector` from
 * `../connectors/index`, fails to resolve, so every test below fails at
 * import time. That is the expected RED; the GREEN step implements the
 * connector module to match the shape exercised here.
 *
 * Test-only connector params (documented here so the GREEN step matches
 * exactly): alongside the public `{ host, port, tls, username, password }`
 * shape from FR-4, `testConnection` also accepts two fields that are NOT part
 * of the public `POST /api/mailboxes` request shape:
 *   - `caCert?: string` — a PEM-encoded CA certificate to trust in addition
 *     to the system trust store, so tests can validate TLS against the fixture
 *     server's self-signed cert without disabling certificate validation
 *     (`rejectUnauthorized` stays `true` in every code path per FR-5).
 *   - `connectTimeoutMs?: number` — overrides the default
 *     `MAILBOX_CONNECT_TIMEOUT_MS`-derived timeout for a single call, so the
 *     "never responds" timeout test doesn't have to wait out the real
 *     10-second default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getConnector } from "../connectors/index";
import {
  startFakeImapServer,
  startFakeImapServerThatNeverResponds,
  startFakePop3Server,
  startFakePop3ServerThatNeverResponds,
  fakeServerCertPem,
  type FakeServerHandle,
} from "./fixtures";

const USERNAME = "alice";
const PASSWORD = "s3cret";

const protocols: Array<{
  protocol: "imap" | "pop3";
  startServer: (opts: {
    username: string;
    password: string;
  }) => Promise<FakeServerHandle>;
  startNeverResponds: () => Promise<FakeServerHandle>;
}> = [
  {
    protocol: "imap",
    startServer: startFakeImapServer,
    startNeverResponds: startFakeImapServerThatNeverResponds,
  },
  {
    protocol: "pop3",
    startServer: startFakePop3Server,
    startNeverResponds: startFakePop3ServerThatNeverResponds,
  },
];

describe.each(protocols)(
  "$protocol connector — testConnection",
  ({ protocol, startServer, startNeverResponds }) => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    it("resolves { ok: true } for correct credentials against the fake server", async () => {
      const server = await startServer({
        username: USERNAME,
        password: PASSWORD,
      });
      try {
        const connector = getConnector(protocol);
        const result = await connector.testConnection({
          host: "localhost",
          port: server.port,
          tls: true,
          username: USERNAME,
          password: PASSWORD,
          caCert: fakeServerCertPem,
        });
        expect(result).toEqual({ ok: true });
      } finally {
        await server.close();
      }
    });

    it("resolves { ok: false, reason: 'authentication failed' } for a wrong password, without throwing", async () => {
      const server = await startServer({
        username: USERNAME,
        password: PASSWORD,
      });
      try {
        const connector = getConnector(protocol);
        const result = await connector.testConnection({
          host: "localhost",
          port: server.port,
          tls: true,
          username: USERNAME,
          password: "wrong-password",
          caCert: fakeServerCertPem,
        });
        expect(result).toEqual({ ok: false, reason: "authentication failed" });
      } finally {
        await server.close();
      }
    });

    it("resolves { ok: false } without throwing when nothing is listening (connection refused)", async () => {
      const connector = getConnector(protocol);
      const result = await connector.testConnection({
        host: "localhost",
        port: 1,
        tls: true,
        username: USERNAME,
        password: PASSWORD,
        caCert: fakeServerCertPem,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // No raw stack trace leaked in the client-facing reason.
        expect(result.reason).not.toMatch(/\n\s*at\s/);
      }
    });

    it("resolves { ok: false } within well under 1s against a server that never responds, using a short test-only timeout", async () => {
      const server = await startNeverResponds();
      try {
        const connector = getConnector(protocol);
        const start = Date.now();
        const result = await connector.testConnection({
          host: "localhost",
          port: server.port,
          tls: true,
          username: USERNAME,
          password: PASSWORD,
          caCert: fakeServerCertPem,
          connectTimeoutMs: 200,
        });
        const elapsedMs = Date.now() - start;
        expect(result.ok).toBe(false);
        expect(elapsedMs).toBeLessThan(900);
      } finally {
        await server.close();
      }
    });

    it("resolves { ok: false } and logs a cert-related error when the fixture's self-signed cert isn't trusted", async () => {
      const server = await startServer({
        username: USERNAME,
        password: PASSWORD,
      });
      try {
        const connector = getConnector(protocol);
        // No `caCert` override here: strict validation must reject the
        // fixture's self-signed certificate, same as it would in production.
        const result = await connector.testConnection({
          host: "localhost",
          port: server.port,
          tls: true,
          username: USERNAME,
          password: PASSWORD,
        });
        expect(result.ok).toBe(false);
        expect(errorSpy).toHaveBeenCalled();
        const loggedCertFailure = errorSpy.mock.calls.some((args) => {
          const joined = args.map((a) => String(a)).join(" ");
          return (
            joined.includes("localhost") &&
            /cert|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|DEPTH_ZERO_SELF_SIGNED_CERT/i.test(
              joined,
            )
          );
        });
        expect(loggedCertFailure).toBe(true);
      } finally {
        await server.close();
      }
    });
  },
);
