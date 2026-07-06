/*
 * Shared TLS connect/timeout/line-reading plumbing for the hand-rolled
 * IMAP/POP3 connectors (PRD "Inbox Connectors & Provider Abstraction"
 * §3.2.2, FR-4/FR-5). Both protocols open an implicit-TLS socket, apply one
 * connect+auth timeout, and read CRLF-terminated responses line by line —
 * this module holds that common plumbing so imap.ts/pop3.ts only implement
 * their own protocol exchange.
 */

import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { TestConnectionParams, TestConnectionResult } from "./types";

// PRD §3.2.2 FR-5's fallback default. The route layer is responsible for
// passing `config.MAILBOX_CONNECT_TIMEOUT_MS` via `connectTimeoutMs`
// outside of tests; this constant only applies when neither is set.
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

// Node's TLS cert-validation error codes vary by cert problem
// (UNABLE_TO_VERIFY_LEAF_SIGNATURE, DEPTH_ZERO_SELF_SIGNED_CERT,
// CERT_HAS_EXPIRED, SELF_SIGNED_CERT_IN_CHAIN, ...). Matching on "CERT" or
// "SELF_SIGNED" catches all of them without an exhaustive, easily-stale list.
const CERT_ERROR_CODE_PATTERN = /CERT|SELF_SIGNED/i;

/** Split incoming bytes on CRLF and hand each complete line to `onLine`. */
function readLines(socket: TLSSocket, onLine: (line: string) => void): void {
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
 * A protocol implementation's exchange, run once the TLS handshake
 * completes. `subscribe` registers the (single, stateful) line handler that
 * drives the protocol's LOGIN/USER+PASS steps; `finish` resolves the overall
 * `testConnection` call once the protocol has seen enough to know
 * success/failure.
 */
type Negotiate = (
  socket: TLSSocket,
  subscribe: (onLine: (line: string) => void) => void,
  finish: (result: TestConnectionResult) => void,
) => void;

/**
 * Open a TLS socket to `params.host:params.port` and run `negotiate` once
 * connected, under a single timeout covering connect *and* the whole
 * protocol exchange (FR-5). Never throws: connect errors, TLS
 * certificate-validation failures, and timeouts all resolve
 * `{ ok: false, reason }` instead of rejecting/throwing.
 */
export function testTlsConnection(
  params: TestConnectionParams,
  negotiate: Negotiate,
): Promise<TestConnectionResult> {
  const { host, port } = params;
  const unreachableReason = `could not reach ${host}:${port}`;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: TestConnectionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, reason: unreachableReason });
    }, params.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    const socket = tlsConnect({
      host,
      port,
      // Additive trust: pass the test-only fixture cert alongside (or, on
      // some Node versions, instead of) the system store when provided.
      // `rejectUnauthorized` is left at its secure default (true) in every
      // code path — never disabled, per FR-5.
      ca: params.caCert,
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      // A cert-validation failure is the operator's only signal that a
      // user's own mail server has a certificate problem, since the client
      // only ever sees the generic `unreachableReason` below (FR-5).
      if (err.code && CERT_ERROR_CODE_PATTERN.test(err.code)) {
        console.error(
          `[mailboxes] TLS certificate validation failed for ${host}:${port}: ${err.code}`,
        );
      }
      settle({ ok: false, reason: unreachableReason });
    });

    socket.on("secureConnect", () => {
      negotiate(socket, (onLine) => readLines(socket, onLine), settle);
    });
  });
}
