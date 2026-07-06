/*
 * Hand-rolled IMAP connector (PRD "Inbox Connectors & Provider Abstraction"
 * §3.2.2, FR-4/FR-5). No IMAP library dependency: opens an implicit-TLS
 * socket, logs in, and logs back out just to confirm the credentials work —
 * Pigeon never keeps this connection open or syncs mail through it.
 */

import type { MailboxConnector } from "./types";
import { testTlsConnection } from "./shared";

const LOGIN_TAG = "a1";
const LOGOUT_TAG = "a2";

export const imapConnector: MailboxConnector = {
  testConnection(params) {
    return testTlsConnection(params, (socket, subscribe, finish) => {
      socket.write(
        `${LOGIN_TAG} LOGIN ${params.username} ${params.password}\r\n`,
      );

      subscribe((line) => {
        // The server's untagged greeting ("* OK ...") doesn't start with the
        // tag, so it's ignored here — only the tagged LOGIN response drives
        // the state machine.
        if (line.startsWith(`${LOGIN_TAG} OK`)) {
          socket.write(`${LOGOUT_TAG} LOGOUT\r\n`);
          finish({ ok: true });
          return;
        }
        if (
          line.startsWith(`${LOGIN_TAG} NO`) ||
          line.startsWith(`${LOGIN_TAG} BAD`)
        ) {
          finish({ ok: false, reason: "authentication failed" });
        }
      });
    });
  },
};
