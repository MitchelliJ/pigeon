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
 * Fake POP3 server: greets, accepts `USER <name>` (always `+OK`, per POP3),
 * then `PASS <pass>` (`+OK`/`-ERR` depending on both matching), then `QUIT`
 * (`+OK Goodbye`, then closes).
 */
export function startFakePop3Server(opts: {
  username: string;
  password: string;
}): Promise<FakeServerHandle> {
  return createTlsFakeServer((socket) => {
    socket.write("+OK POP3 fake ready\r\n");
    let userMatched = false;

    lineReader(socket, (line) => {
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
          socket.write("+OK Logged in\r\n");
        } else {
          socket.write("-ERR authentication failed\r\n");
        }
        return;
      }

      if (/^QUIT\s*$/i.test(line)) {
        socket.write("+OK Goodbye\r\n");
        socket.end();
      }
    });
  });
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
