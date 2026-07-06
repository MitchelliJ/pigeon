/*
 * Hand-rolled POP3 connector (PRD "Inbox Connectors & Provider Abstraction"
 * §3.2.2, FR-4/FR-5; extended by PRD "Incremental Sync Engine & Watermarks"
 * §3.2, FR-1/FR-3/FR-4/FR-8/FR-9). No POP3 library dependency: opens an
 * implicit-TLS socket and logs in via USER/PASS, then either quits right away
 * (`testConnection`, just confirming the credentials work) or issues
 * `UIDL`/`TOP`/`RETR` to list and fetch messages.
 */

import type { TLSSocket } from "node:tls";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import type {
  FetchedMessage,
  FetchMessagesResult,
  ListMessageIdsResult,
  MailboxConnector,
  TestConnectionParams,
  TestConnectionResult,
} from "./types";
import { readDotTerminatedBlock, testTlsConnection } from "./shared";

/** Every result type `withPop3Login` is instantiated with shares this shape. */
type LoginResult = { ok: true } | { ok: false; reason: string };

/** Swaps out the (single, stateful) line handler driving the POP3 exchange. */
type SetLineHandler = (handler: (line: string) => void) => void;

/**
 * Logs in via POP3's strict greeting -> `USER` -> `PASS` sequence, reusing
 * `testTlsConnection` for the shared TLS connect/timeout/cert-validation
 * plumbing, then hands control to `afterLogin`. POP3 responses carry no tag
 * ("+OK"/"-ERR" alone), so exactly one line handler drives the whole
 * exchange at any given moment — `setLineHandler` lets `afterLogin` swap in
 * its own handler(s) for whatever it does next (`QUIT`, `UIDL`, ...).
 */
function withPop3Login<TResult extends LoginResult>(
  params: TestConnectionParams,
  afterLogin: (
    socket: TLSSocket,
    setLineHandler: SetLineHandler,
    finish: (result: TResult) => void,
  ) => void,
): Promise<TResult> {
  return testTlsConnection<TResult>(params, (socket, subscribe, finish) => {
    // `subscribe` may only be called once per connection (each call attaches
    // its own "data" listener) — so the whole login+afterLogin exchange runs
    // through this one indirection, reassigning `handleLine` as steps
    // progress instead of subscribing again.
    let handleLine: (line: string) => void = () => {
      // Greeting line: content is ignored, just kicks off USER.
      handleLine = (userReply) => {
        if (userReply.startsWith("-ERR")) {
          finish({ ok: false, reason: "authentication failed" } as TResult);
          return;
        }
        handleLine = (passReply) => {
          if (passReply.startsWith("+OK")) {
            afterLogin(
              socket,
              (next) => {
                handleLine = next;
              },
              finish,
            );
          } else {
            finish({ ok: false, reason: "authentication failed" } as TResult);
          }
        };
        socket.write(`PASS ${params.password}\r\n`);
      };
      socket.write(`USER ${params.username}\r\n`);
    };

    subscribe((line) => handleLine(line));
  });
}

/**
 * Sends a POP3 command whose successful ("+OK") reply is followed by a
 * dot-terminated multi-line block (`UIDL`, `TOP`, `RETR`). Resolves
 * `{ ok: false, statusLine }` instead if the server replies "-ERR" — no
 * block follows in that case.
 */
function sendBlockCommand(
  socket: TLSSocket,
  setLineHandler: SetLineHandler,
  command: string,
): Promise<{ ok: true; lines: string[] } | { ok: false; statusLine: string }> {
  return new Promise((resolve) => {
    setLineHandler((statusLine) => {
      if (statusLine.startsWith("-ERR")) {
        resolve({ ok: false, statusLine });
        return;
      }
      setLineHandler(
        readDotTerminatedBlock((lines) => resolve({ ok: true, lines })),
      );
    });
    socket.write(`${command}\r\n`);
  });
}

/** Parses one `UIDL` response line ("<msgnum> <uidl>") into its parts. */
function parseUidlLine(
  line: string,
): { msgnum: number; uidl: string } | undefined {
  const match = /^(\d+)\s+(\S+)$/.exec(line);
  const msgnum = match?.[1];
  const uidl = match?.[2];
  if (!msgnum || !uidl) return undefined;
  return { msgnum: Number(msgnum), uidl };
}

/**
 * Scans a `TOP <n> 0` response's header lines for `Date:` and parses it, for
 * the FR-8 first-sync peek-and-filter (cheaper than a full `mailparser` pass
 * just to read one header).
 */
function parseDateHeader(headerLines: string[]): Date | undefined {
  const dateLine = headerLines.find((line) => /^date:/i.test(line));
  if (!dateLine) return undefined;
  const value = dateLine.slice(dateLine.indexOf(":") + 1).trim();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Builds a `uidl -> msgnum` map from a successful `UIDL` response's lines. */
function buildMsgnumByUidl(lines: string[]): Map<string, number> {
  const msgnumByUidl = new Map<string, number>();
  for (const line of lines) {
    const parsed = parseUidlLine(line);
    if (parsed) msgnumByUidl.set(parsed.uidl, parsed.msgnum);
  }
  return msgnumByUidl;
}

/**
 * Parses a raw `RETR` message with `mailparser` into a `FetchedMessage`.
 * Falls back to `html-to-text`'s plain-text conversion when the message has
 * no `text/plain` part (FR-9). `seen` is always `false`: POP3 has no
 * read/unread flag.
 */
async function parseFetchedMessage(
  providerUid: string,
  rawMessage: string,
): Promise<FetchedMessage> {
  const parsed = await simpleParser(rawMessage);
  const from = parsed.from?.value[0];
  const body =
    parsed.text && parsed.text.length > 0
      ? parsed.text
      : convert(parsed.html || "");

  return {
    providerUid,
    fromName: from?.name ?? "",
    fromAddress: from?.address ?? "",
    subject: parsed.subject ?? "",
    body,
    receivedAt: parsed.date ?? new Date(0),
    seen: false,
  };
}

export const pop3Connector: MailboxConnector = {
  testConnection(params) {
    return withPop3Login<TestConnectionResult>(
      params,
      (socket, _setLineHandler, finish) => {
        socket.write("QUIT\r\n");
        finish({ ok: true });
      },
    );
  },

  listMessageIds(params) {
    // `since` (first-sync history cap, FR-8) is ignored here — POP3 has no
    // server-side date filter, so `fetchMessages` applies it instead.
    return withPop3Login<ListMessageIdsResult>(
      params,
      async (socket, setLineHandler, finish) => {
        try {
          const uidlResult = await sendBlockCommand(
            socket,
            setLineHandler,
            "UIDL",
          );
          if (!uidlResult.ok) {
            finish({ ok: false, reason: "uidl_not_supported" });
            return;
          }
          const ids = uidlResult.lines
            .map(parseUidlLine)
            .filter(
              (entry): entry is { msgnum: number; uidl: string } =>
                entry !== undefined,
            )
            .map((entry) => entry.uidl);
          finish({ ok: true, ids });
        } catch (err) {
          // Never throw out of a connector call — same convention as
          // `testConnection` (FR-1).
          finish({
            ok: false,
            reason: `listMessageIds failed: ${String(err)}`,
          });
        }
      },
    );
  },

  fetchMessages(params, ids, opts) {
    return withPop3Login<FetchMessagesResult>(
      params,
      async (socket, setLineHandler, finish) => {
        try {
          // RETR/TOP address messages by sequence number, not UIDL, so a
          // `uidl -> msgnum` map is built up front from one `UIDL` call.
          const uidlResult = await sendBlockCommand(
            socket,
            setLineHandler,
            "UIDL",
          );
          if (!uidlResult.ok) {
            finish({ ok: false, reason: "uidl_not_supported" });
            return;
          }
          const msgnumByUidl = buildMsgnumByUidl(uidlResult.lines);

          const messages: FetchedMessage[] = [];
          for (const providerUid of ids) {
            const msgnum = msgnumByUidl.get(providerUid);
            // Requested id no longer exists on the server (deleted between
            // `listMessageIds` and `fetchMessages`) — silently skip it
            // rather than erroring the whole batch.
            if (msgnum === undefined) continue;

            if (opts?.since) {
              const topResult = await sendBlockCommand(
                socket,
                setLineHandler,
                `TOP ${msgnum} 0`,
              );
              if (topResult.ok) {
                const headerDate = parseDateHeader(topResult.lines);
                if (headerDate && headerDate < opts.since) {
                  // Excluded before ever issuing RETR for it (FR-8).
                  continue;
                }
              }
              // If TOP isn't supported either (rare), fall through to
              // RETR-then-filter below — an accepted one-time inefficiency
              // for the first sync only (FR-8).
            }

            const retrResult = await sendBlockCommand(
              socket,
              setLineHandler,
              `RETR ${msgnum}`,
            );
            if (!retrResult.ok) {
              finish({ ok: false, reason: retrResult.statusLine });
              return;
            }

            const message = await parseFetchedMessage(
              providerUid,
              retrResult.lines.join("\r\n"),
            );
            if (opts?.since && message.receivedAt < opts.since) {
              // TOP was unsupported above; only known here after paying for
              // the full RETR (FR-8's documented fallback).
              continue;
            }
            messages.push(message);
          }

          socket.write("QUIT\r\n");
          finish({ ok: true, messages });
        } catch (err) {
          // Never throw out of a connector call — same convention as
          // `testConnection` (FR-1).
          finish({ ok: false, reason: `fetchMessages failed: ${String(err)}` });
        }
      },
    );
  },
};
