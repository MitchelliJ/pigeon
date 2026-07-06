/*
 * Integration tests for the hand-rolled POP3 connection-testing connector
 * (PRD "Inbox Connectors & Provider Abstraction" §3.2.2 FR-4/FR-5, §3.5
 * FR-19). IMAP's equivalent `testConnection` coverage against a real fake TLS
 * server has been relocated: per PRD "Incremental Sync Engine & Watermarks"
 * §3.2 FR-2, IMAP is rewritten on `imapflow` behind an injectable client
 * interface, so it is now tested against an in-memory fake client instead
 * (`./imap.test.ts`) rather than a real socket — this file is POP3-only.
 *
 * RED note: `backend/src/mailboxes/connectors/{types,pop3,index}.ts` do
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
  startFakePop3Server,
  startFakePop3ServerThatNeverResponds,
  fakeServerCertPem,
  POP3_FIXTURE_UIDLS,
} from "./fixtures";

const USERNAME = "alice";
const PASSWORD = "s3cret";

describe("pop3 connector — testConnection", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("resolves { ok: true } for correct credentials against the fake server", async () => {
    const server = await startFakePop3Server({
      username: USERNAME,
      password: PASSWORD,
    });
    try {
      const connector = getConnector("pop3");
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
    const server = await startFakePop3Server({
      username: USERNAME,
      password: PASSWORD,
    });
    try {
      const connector = getConnector("pop3");
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
    const connector = getConnector("pop3");
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
    const server = await startFakePop3ServerThatNeverResponds();
    try {
      const connector = getConnector("pop3");
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
    const server = await startFakePop3Server({
      username: USERNAME,
      password: PASSWORD,
    });
    try {
      const connector = getConnector("pop3");
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
});

/*
 * RED note: `pop3Connector`/`MailboxConnector` (`../connectors/{types,pop3}`)
 * don't have `listMessageIds`/`fetchMessages` yet (PRD "Incremental Sync
 * Engine & Watermarks" §3.2 FR-1/FR-3) — this either fails to typecheck
 * (`Property 'listMessageIds' does not exist on type 'MailboxConnector'`) or,
 * once the type is widened, fails at runtime because the method is
 * unimplemented. Both are the expected RED for this not-yet-built behavior;
 * the GREEN step implements `listMessageIds`/`fetchMessages` on the POP3
 * connector via `LIST`/`UIDL`/`TOP`/`RETR` to match the fixture in
 * `./fixtures.ts`.
 */
describe("pop3 connector — listMessageIds/fetchMessages", () => {
  it("resolves { ok: true, ids } containing exactly the 3 scripted UIDLs from the fixture server", async () => {
    const server = await startFakePop3Server({
      username: USERNAME,
      password: PASSWORD,
    });
    try {
      const connector = getConnector("pop3");
      const result = await connector.listMessageIds({
        host: "localhost",
        port: server.port,
        tls: true,
        username: USERNAME,
        password: PASSWORD,
        caCert: fakeServerCertPem,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.ids.slice().sort()).toEqual(
          POP3_FIXTURE_UIDLS.slice().sort(),
        );
      }
    } finally {
      await server.close();
    }
  });

  it("resolves { ok: false, reason: 'uidl_not_supported' } when the server rejects a bare UIDL", async () => {
    const server = await startFakePop3Server({
      username: USERNAME,
      password: PASSWORD,
      supportsUidl: false,
    });
    try {
      const connector = getConnector("pop3");
      const result = await connector.listMessageIds({
        host: "localhost",
        port: server.port,
        tls: true,
        username: USERNAME,
        password: PASSWORD,
        caCert: fakeServerCertPem,
      });
      expect(result).toEqual({ ok: false, reason: "uidl_not_supported" });
    } finally {
      await server.close();
    }
  });

  it("fetchMessages resolves correct providerUid/fromName/fromAddress/subject/receivedAt/seen for requested ids", async () => {
    const server = await startFakePop3Server({
      username: USERNAME,
      password: PASSWORD,
    });
    try {
      const connector = getConnector("pop3");
      const fixtureMsg1 = server.messages.find((m) => m.uidl === "uid-1");
      const fixtureMsg2 = server.messages.find((m) => m.uidl === "uid-2");
      if (!fixtureMsg1 || !fixtureMsg2) {
        throw new Error("expected fixture messages uid-1/uid-2 to exist");
      }

      const result = await connector.fetchMessages(
        {
          host: "localhost",
          port: server.port,
          tls: true,
          username: USERNAME,
          password: PASSWORD,
          caCert: fakeServerCertPem,
        },
        ["uid-1", "uid-2"],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const fetched1 = result.messages.find((m) => m.providerUid === "uid-1");
      const fetched2 = result.messages.find((m) => m.providerUid === "uid-2");
      expect(fetched1).toBeDefined();
      expect(fetched2).toBeDefined();

      expect(fetched1).toMatchObject({
        providerUid: "uid-1",
        fromName: fixtureMsg1.fromName,
        fromAddress: fixtureMsg1.fromAddress,
        subject: fixtureMsg1.subject,
        seen: false,
      });
      expect(fetched1?.receivedAt.getTime()).toBe(fixtureMsg1.date.getTime());

      expect(fetched2).toMatchObject({
        providerUid: "uid-2",
        fromName: fixtureMsg2.fromName,
        fromAddress: fixtureMsg2.fromAddress,
        subject: fixtureMsg2.subject,
        seen: false,
      });
      expect(fetched2?.receivedAt.getTime()).toBe(fixtureMsg2.date.getTime());
    } finally {
      await server.close();
    }
  });

  it("fetchMessages returns non-empty, HTML-stripped plain text for the HTML-only message (uid-2)", async () => {
    const server = await startFakePop3Server({
      username: USERNAME,
      password: PASSWORD,
    });
    try {
      const connector = getConnector("pop3");
      const result = await connector.fetchMessages(
        {
          host: "localhost",
          port: server.port,
          tls: true,
          username: USERNAME,
          password: PASSWORD,
          caCert: fakeServerCertPem,
        },
        ["uid-2"],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const fetched = result.messages.find((m) => m.providerUid === "uid-2");
      expect(fetched).toBeDefined();
      expect(fetched?.body.length).toBeGreaterThan(0);
      // Proxy for "HTML was stripped/converted to plain text": no raw tag
      // characters left in the body.
      expect(fetched?.body).not.toMatch(/<[a-z][\s\S]*>/i);
    } finally {
      await server.close();
    }
  });

  it("fetchMessages with opts.since TOP-peeks headers and excludes ids older than since from the result", async () => {
    const server = await startFakePop3Server({
      username: USERNAME,
      password: PASSWORD,
    });
    try {
      const connector = getConnector("pop3");
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const result = await connector.fetchMessages(
        {
          host: "localhost",
          port: server.port,
          tls: true,
          username: USERNAME,
          password: PASSWORD,
          caCert: fakeServerCertPem,
        },
        ["uid-1", "uid-2", "uid-3"],
        { since: sevenDaysAgo },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const ids = result.messages.map((m) => m.providerUid).sort();
      // uid-3 (30 days ago) is outside the 7-day window and must be
      // silently excluded, not returned as an error.
      expect(ids).toEqual(["uid-1", "uid-2"]);
    } finally {
      await server.close();
    }
  });
});
