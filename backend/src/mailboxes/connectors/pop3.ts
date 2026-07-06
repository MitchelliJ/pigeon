/*
 * Hand-rolled POP3 connector (PRD "Inbox Connectors & Provider Abstraction"
 * §3.2.2, FR-4/FR-5). No POP3 library dependency: opens an implicit-TLS
 * socket, logs in via USER/PASS, and quits just to confirm the credentials
 * work — Pigeon never keeps this connection open or fetches mail through it.
 */

import type { MailboxConnector } from "./types";
import { testTlsConnection } from "./shared";

export const pop3Connector: MailboxConnector = {
  testConnection(params) {
    return testTlsConnection(params, (socket, subscribe, finish) => {
      // Unlike IMAP, POP3 responses carry no tag ("+OK"/"-ERR" alone), so
      // the client has to consume exactly one line per step — the server's
      // greeting, then USER's reply, then PASS's — in that order, rather
      // than matching on response content.
      let step: "greeting" | "user" | "pass" = "greeting";

      subscribe((line) => {
        if (step === "greeting") {
          step = "user";
          socket.write(`USER ${params.username}\r\n`);
          return;
        }

        if (step === "user") {
          if (line.startsWith("-ERR")) {
            finish({ ok: false, reason: "authentication failed" });
            return;
          }
          step = "pass";
          socket.write(`PASS ${params.password}\r\n`);
          return;
        }

        // step === "pass"
        if (line.startsWith("+OK")) {
          socket.write("QUIT\r\n");
          finish({ ok: true });
        } else if (line.startsWith("-ERR")) {
          finish({ ok: false, reason: "authentication failed" });
        }
      });
    });
  },
};
