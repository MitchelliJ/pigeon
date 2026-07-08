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
 * drives the protocol's LOGIN/USER+PASS steps (and, for POP3's
 * `listMessageIds`/`fetchMessages`, later steps too — see pop3.ts); `finish`
 * resolves the overall call once the protocol has seen enough to know
 * success/failure.
 *
 * Generic over the result shape so this same connect/timeout/cert plumbing
 * is reusable for `testConnection` (`TestConnectionResult`) as well as
 * POP3's `listMessageIds`/`fetchMessages` (`ListMessageIdsResult`/
 * `FetchMessagesResult`) — every one of those result types shares the same
 * `{ ok: false; reason: string }` failure shape.
 */
type ConnectorResult = { ok: true } | { ok: false; reason: string };

type Negotiate<TResult extends ConnectorResult> = (
  socket: TLSSocket,
  subscribe: (onLine: (line: string) => void) => void,
  finish: (result: TResult) => void,
) => void;

/**
 * Open a TLS socket to `params.host:params.port` and run `negotiate` once
 * connected. The timeout is an *inactivity* timeout (FR-5): it bounds the
 * initial connect and then any stretch of silence during the protocol
 * exchange, resetting on every received byte. This is deliberately not a
 * single deadline over the whole call — a POP3 `RETR` loop across many
 * messages legitimately takes longer than the connect budget, and a fixed
 * deadline would abort a healthy, actively-transferring connection midway
 * and mislabel it "could not reach host". Never throws: connect errors, TLS
 * certificate-validation failures, and timeouts all resolve
 * `{ ok: false, reason }` instead of rejecting/throwing.
 */
export function testTlsConnection<
  TResult extends ConnectorResult = TestConnectionResult,
>(
  params: TestConnectionParams,
  negotiate: Negotiate<TResult>,
): Promise<TResult> {
  const { host, port } = params;
  const unreachableReason = `could not reach ${host}:${port}`;
  // `{ ok: false, reason }` satisfies every `TResult` this function is used
  // with (see `ConnectorResult` above) — the cast just tells TypeScript what
  // every caller already guarantees structurally.
  const unreachableResult = { ok: false, reason: unreachableReason } as TResult;
  const timeoutMs = params.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (result: TResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    // (Re)arm the inactivity timer — called at connect and again on every
    // inbound chunk, so only a genuine stall (no bytes for `timeoutMs`) trips
    // it, never a slow-but-progressing transfer.
    const armTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(unreachableResult), timeoutMs);
    };
    armTimer();

    const socket = tlsConnect({
      host,
      port,
      // Additive trust: pass the test-only fixture cert alongside (or, on
      // some Node versions, instead of) the system store when provided.
      // `rejectUnauthorized` is left at its secure default (true) in every
      // code path — never disabled, per FR-5.
      ca: params.caCert,
    });

    socket.on("data", armTimer);

    socket.on("error", (err: NodeJS.ErrnoException) => {
      // A cert-validation failure is the operator's only signal that a
      // user's own mail server has a certificate problem, since the client
      // only ever sees the generic `unreachableReason` below (FR-5).
      if (err.code && CERT_ERROR_CODE_PATTERN.test(err.code)) {
        console.error(
          `[mailboxes] TLS certificate validation failed for ${host}:${port}: ${err.code}`,
        );
      }
      settle(unreachableResult);
    });

    socket.on("secureConnect", () => {
      negotiate(socket, (onLine) => readLines(socket, onLine), settle);
    });
  });
}

/**
 * Accumulates lines fed to the returned handler until a lone "." line (POP3's
 * multi-line response terminator — RFC 1939 §3), then calls `onComplete`
 * with the accumulated lines (the terminator itself excluded). Used by
 * pop3.ts's `listMessageIds`/`fetchMessages` for `UIDL`/`TOP`/`RETR`, whose
 * replies are all "one status line, then a dot-terminated block" — unlike
 * `testConnection`'s single-line `+OK`/`-ERR` exchanges, which don't need
 * this.
 */
export function readDotTerminatedBlock(
  onComplete: (lines: string[]) => void,
): (line: string) => void {
  const lines: string[] = [];
  return (line: string): void => {
    if (line === ".") {
      onComplete(lines);
      return;
    }
    lines.push(line);
  };
}
