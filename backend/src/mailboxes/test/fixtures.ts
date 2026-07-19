/*
 * Test-only fixtures for the mailbox connector tests (PRD "Inbox Connectors &
 * Provider Abstraction" §3.5, FR-19). NOT production code.
 *
 * Spins up minimal, real in-process TLS servers on `localhost` (`node:tls`,
 * implicit TLS, no STARTTLS) that speak just enough IMAP/POP3 to exercise the
 * hand-rolled connectors in `../connectors/`: a correct-login/wrong-login
 * flow for the happy-path fixtures, and a "never responds" variant (accepts
 * the handshake, then goes silent forever) for exercising client-side
 * connect/auth timeouts.
 *
 * Uses the committed self-signed fixture certificate (`./fixtures/test-cert.pem`
 * / `test-key.pem`, CN=localhost, 10-year expiry — see
 * `backend/src/mailboxes/test/fixtures/README.md`) — never a real cert.
 */
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const CERT_PATH = join(import.meta.dirname, "fixtures", "test-cert.pem");
const KEY_PATH = join(import.meta.dirname, "fixtures", "test-key.pem");

const cert = readFileSync(CERT_PATH);
const key = readFileSync(KEY_PATH);

/**
 * The fixture's self-signed certificate, PEM-encoded — exported so tests can
 * pass it as a test-only trust anchor (e.g. a `caCert` override) to the
 * connector under test without weakening the connector's production TLS
 * validation path.
 */
export const fakeServerCertPem = cert.toString("utf8");

export type FakeServerHandle = {
  port: number;
  close(): Promise<void>;
};

/** Boot a TLS server on a free `localhost` port using the fixture cert/key. */
function createTlsFakeServer(
  onConnection: (socket: TLSSocket) => void,
): Promise<FakeServerHandle> {
  const sockets = new Set<TLSSocket>();
  const server = createTlsServer({ cert, key }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            // Force-close any still-open sockets (the "never responds"
            // fixture deliberately never ends its socket) so server.close()
            // doesn't hang waiting for connections to drain.
            for (const socket of sockets) socket.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

/** Split incoming bytes on CRLF and hand each complete line to `onLine`. */
function lineReader(socket: TLSSocket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      onLine(line);
    }
  });
}

/**
 * Fake IMAP server: greets, then accepts `<tag> LOGIN <user> <pass>` (OK/NO)
 * followed by `<tag> LOGOUT` (BYE + OK, then closes).
 */
export function startFakeImapServer(opts: {
  username: string;
  password: string;
}): Promise<FakeServerHandle> {
  return createTlsFakeServer((socket) => {
    socket.write("* OK IMAP4rev1 fake ready\r\n");

    lineReader(socket, (line) => {
      const loginMatch = /^(\S+)\s+LOGIN\s+(\S+)\s+(\S+)\s*$/i.exec(line);
      if (loginMatch) {
        const [, tag, username, password] = loginMatch;
        if (username === opts.username && password === opts.password) {
          socket.write(`${tag} OK LOGIN completed\r\n`);
        } else {
          socket.write(`${tag} NO authentication failed\r\n`);
        }
        return;
      }

      const logoutMatch = /^(\S+)\s+LOGOUT\s*$/i.exec(line);
      if (logoutMatch) {
        const [, tag] = logoutMatch;
        socket.write("* BYE\r\n");
        socket.write(`${tag} OK LOGOUT completed\r\n`);
        socket.end();
      }
    });
  });
}

/**
 * Fake IMAP server that completes the TLS handshake but never writes a
 * greeting and never closes the socket — used to exercise client-side
 * connect/auth timeout behavior.
 */
export function startFakeImapServerThatNeverResponds(): Promise<FakeServerHandle> {
  return createTlsFakeServer(() => {
    // Intentionally silent.
  });
}

/**
 * Metadata for one scripted POP3 fixture message (PRD "Incremental Sync
 * Engine & Watermarks" §3.6 FR-16). Dates are computed relative to "now" at
 * server-start time (not baked in at module-load time) so the "within the
 * last 7 days" / "older than 7 days" fixture messages stay correct no matter
 * when the test suite actually runs.
 */
export type Pop3FixtureMessage = {
  uidl: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  date: Date;
  /** CRLF-joined header lines, no leading/trailing blank line. */
  headers: string;
  /**
   * CRLF-joined body lines. Deliberately free of any line starting with a
   * literal "." so the fixture never needs real POP3 byte-stuffing/
   * dot-un-stuffing (production code isn't expected to handle it either,
   * since these fixtures are the only POP3 "wire" it's tested against).
   */
  body: string;
};

/** Stable UIDLs the fixture below always reports, in message-number order. */
export const POP3_FIXTURE_UIDLS = ["uid-1", "uid-2", "uid-3"];

/**
 * Builds the 3 scripted fixture messages: a recent plain-text message, a
 * recent HTML-only message (no `text/plain` part at all), and a plain-text
 * message older than the 7-day first-sync cap (FR-8).
 */
function buildPop3FixtureMessages(): Pop3FixtureMessage[] {
  const now = Date.now();
  const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  // `Date` headers round-trip through `toUTCString()`, which only has
  // second-level precision — zero out milliseconds here so a test can
  // compare a parsed `receivedAt` back against this exact `Date` object
  // with `.getTime()` equality instead of a fuzzy tolerance.
  oneDayAgo.setMilliseconds(0);
  thirtyDaysAgo.setMilliseconds(0);

  return [
    {
      uidl: POP3_FIXTURE_UIDLS[0]!,
      fromName: "Alice",
      fromAddress: "alice@example.com",
      subject: "Hello there",
      date: oneDayAgo,
      headers: [
        "From: Alice <alice@example.com>",
        "Subject: Hello there",
        `Date: ${oneDayAgo.toUTCString()}`,
        "Content-Type: text/plain",
      ].join("\r\n"),
      body: ["Hi Bob,", "", "Just checking in.", "", "Alice"].join("\r\n"),
    },
    {
      uidl: POP3_FIXTURE_UIDLS[1]!,
      fromName: "Carol",
      fromAddress: "carol@example.com",
      subject: "HTML update",
      date: oneDayAgo,
      headers: [
        "From: Carol <carol@example.com>",
        "Subject: HTML update",
        `Date: ${oneDayAgo.toUTCString()}`,
        "Content-Type: text/html",
      ].join("\r\n"),
      body: "<html><body><p>Hello from Carol</p></body></html>",
    },
    {
      uidl: POP3_FIXTURE_UIDLS[2]!,
      fromName: "Dave",
      fromAddress: "dave@example.com",
      subject: "Old news",
      date: thirtyDaysAgo,
      headers: [
        "From: Dave <dave@example.com>",
        "Subject: Old news",
        `Date: ${thirtyDaysAgo.toUTCString()}`,
        "Content-Type: text/plain",
      ].join("\r\n"),
      body: "This is old news from a month ago.",
    },
  ];
}

/**
 * A `FakeServerHandle` plus the exact scripted fixture message metadata
 * (with their `date`s already computed) so tests can assert against them
 * (e.g. exact `receivedAt` equality) without recomputing "now" separately
 * and risking an off-by-a-few-milliseconds mismatch.
 */
export type FakePop3ServerHandle = FakeServerHandle & {
  messages: Pop3FixtureMessage[];
  /**
   * Running log of every raw command line received by this server instance
   * (one entry per CRLF-terminated line, captured before dispatch) — tests
   * assert on it to verify which wire commands a connector did/didn't issue
   * (PRD "Sync Backfill Date Alignment" FR-6: POP3 must no longer send
   * `TOP <n> 0` once it stops filtering in-connector).
   */
  commands: string[];
};

/**
 * Fake POP3 server: greets, accepts `USER <name>` (always `+OK`, per POP3),
 * then `PASS <pass>` (`+OK`/`-ERR` depending on both matching), then `QUIT`
 * (`+OK Goodbye`, then closes). Once logged in, also answers `LIST`/`UIDL`
 * (for `listMessageIds`) and `TOP <n> 0`/`RETR <n>` (for `fetchMessages`)
 * against 3 scripted fixture messages (PRD "Incremental Sync Engine &
 * Watermarks" §3.2/§3.6, FR-1/FR-3/FR-4/FR-8/FR-16).
 *
 * `supportsUidl: false` simulates a server that doesn't implement `UIDL` at
 * all (some real-world POP3 servers reply `-ERR` to the bare command) —
 * FR-4's `uidl_not_supported` case.
 */
export function startFakePop3Server(opts: {
  username: string;
  password: string;
  supportsUidl?: boolean;
}): Promise<FakePop3ServerHandle> {
  const supportsUidl = opts.supportsUidl ?? true;
  const messages = buildPop3FixtureMessages();

  const messageSize = (m: Pop3FixtureMessage): number =>
    m.headers.length + 4 + m.body.length;

  /** Running log of raw command lines received by this server instance. */
  const commands: string[] = [];

  const serverPromise = createTlsFakeServer((socket) => {
    socket.write("+OK POP3 fake ready\r\n");
    let userMatched = false;
    let loggedIn = false;

    lineReader(socket, (line) => {
      // Record every raw command line before dispatching, so tests can
      // assert on the exact wire-level command sequence (e.g. "no TOP was
      // issued").
      commands.push(line);

      const userMatch = /^USER\s+(\S+)\s*$/i.exec(line);
      if (userMatch) {
        userMatched = userMatch[1] === opts.username;
        socket.write("+OK\r\n");
        return;
      }

      const passMatch = /^PASS\s+(\S+)\s*$/i.exec(line);
      if (passMatch) {
        const passwordMatched = passMatch[1] === opts.password;
        if (userMatched && passwordMatched) {
          loggedIn = true;
          socket.write("+OK Logged in\r\n");
        } else {
          socket.write("-ERR authentication failed\r\n");
        }
        return;
      }

      if (/^QUIT\s*$/i.test(line)) {
        socket.write("+OK Goodbye\r\n");
        socket.end();
        return;
      }

      // Everything below requires a completed login, same as a real server.
      if (!loggedIn) return;

      if (/^LIST\s*$/i.test(line)) {
        const totalOctets = messages.reduce(
          (sum, m) => sum + messageSize(m),
          0,
        );
        socket.write(
          `+OK ${messages.length} messages (${totalOctets} octets)\r\n`,
        );
        messages.forEach((m, i) => {
          socket.write(`${i + 1} ${messageSize(m)}\r\n`);
        });
        socket.write(".\r\n");
        return;
      }

      if (/^UIDL\s*$/i.test(line)) {
        if (!supportsUidl) {
          socket.write("-ERR\r\n");
          return;
        }
        socket.write("+OK\r\n");
        messages.forEach((m, i) => {
          socket.write(`${i + 1} ${m.uidl}\r\n`);
        });
        socket.write(".\r\n");
        return;
      }

      const topMatch = /^TOP\s+(\d+)\s+(\d+)\s*$/i.exec(line);
      if (topMatch) {
        const message = messages[Number(topMatch[1]) - 1];
        if (!message) {
          socket.write("-ERR no such message\r\n");
          return;
        }
        socket.write("+OK\r\n");
        socket.write(`${message.headers}\r\n`);
        socket.write("\r\n");
        socket.write(".\r\n");
        return;
      }

      const retrMatch = /^RETR\s+(\d+)\s*$/i.exec(line);
      if (retrMatch) {
        const message = messages[Number(retrMatch[1]) - 1];
        if (!message) {
          socket.write("-ERR no such message\r\n");
          return;
        }
        socket.write(`+OK ${messageSize(message)} octets\r\n`);
        socket.write(`${message.headers}\r\n`);
        socket.write("\r\n");
        socket.write(`${message.body}\r\n`);
        socket.write(".\r\n");
        return;
      }
    });
  });

  return serverPromise.then((handle) => ({ ...handle, messages, commands }));
}

/**
 * Fake POP3 server that completes the TLS handshake but never writes a
 * greeting and never closes the socket — used to exercise client-side
 * connect/auth timeout behavior.
 */
export function startFakePop3ServerThatNeverResponds(): Promise<FakeServerHandle> {
  return createTlsFakeServer(() => {
    // Intentionally silent.
  });
}
