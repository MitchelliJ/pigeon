/** Exercises the hand-written POP3 client against an in-process fake server. */
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pop3Provider } from "../src/providers/pop3.js";
import type { MailConnection } from "../src/types.js";

interface FakeMessage {
  uidl: string;
  raw: string;
}

function rfc822(subject: string, body: string, id: string): string {
  return [
    `Message-ID: <${id}@fake.test>`,
    `From: Fake Sender <fake@fake.test>`,
    `To: you@fake.test`,
    `Subject: ${subject}`,
    `Date: Wed, 02 Jul 2026 20:00:00 +0000`,
    ``,
    body,
    `.leading dot line needs stuffing`,
  ].join("\r\n");
}

class FakePop3Server {
  server: Server;
  port = 0;
  messages: FakeMessage[] = [];
  user = "you@fake.test";
  pass = "app-password";

  constructor() {
    this.server = createServer((socket) => this.session(socket));
  }

  private session(socket: Socket) {
    socket.write("+OK fake POP3 ready\r\n");
    let buffer = "";
    let authed = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const [cmd, ...args] = line.split(" ");
        switch (cmd?.toUpperCase()) {
          case "USER":
            socket.write(args[0] === this.user ? "+OK\r\n" : "-ERR no such user\r\n");
            break;
          case "PASS":
            authed = args.join(" ") === this.pass;
            socket.write(authed ? "+OK logged in\r\n" : "-ERR bad password\r\n");
            break;
          case "STAT":
            socket.write(`+OK ${this.messages.length} 1000\r\n`);
            break;
          case "UIDL": {
            socket.write("+OK\r\n");
            this.messages.forEach((m, i) => socket.write(`${i + 1} ${m.uidl}\r\n`));
            socket.write(".\r\n");
            break;
          }
          case "RETR": {
            const n = Number(args[0]);
            const msg = this.messages[n - 1];
            if (!msg) {
              socket.write("-ERR no such message\r\n");
              break;
            }
            socket.write("+OK\r\n");
            // Dot-stuff lines starting with "."
            const stuffed = msg.raw
              .split("\r\n")
              .map((l) => (l.startsWith(".") ? "." + l : l))
              .join("\r\n");
            socket.write(stuffed + "\r\n.\r\n");
            break;
          }
          case "QUIT":
            socket.write("+OK bye\r\n");
            socket.end();
            break;
          default:
            socket.write("-ERR unknown command\r\n");
        }
      }
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe("pop3 provider", () => {
  const server = new FakePop3Server();
  let conn: MailConnection;

  beforeAll(async () => {
    await server.listen();
    conn = {
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      username: server.user,
      secret: server.pass,
      address: server.user,
    };
    server.messages = [
      { uidl: "u1", raw: rfc822("Old message 1", "historic body", "m1") },
      { uidl: "u2", raw: rfc822("Old message 2", "historic body", "m2") },
    ];
  });
  afterAll(async () => {
    await server.close();
  });

  it("testConnection succeeds with valid creds, fails with bad ones", async () => {
    await expect(pop3Provider.testConnection(conn)).resolves.toBeUndefined();
    await expect(
      pop3Provider.testConnection({ ...conn, secret: "wrong" }),
    ).rejects.toThrow(/authentication/i);
  });

  it("first sync backfills existing messages and sets the watermark", async () => {
    const result = await pop3Provider.fetchNew(conn, {});
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.subject).toBe("Old message 1");
    expect(result.messages[0]!.bodyText).toContain(".leading dot line");
    expect(result.hasMore).toBe(false);

    // Nothing new: same state comes back, zero messages.
    const again = await pop3Provider.fetchNew(conn, result.state);
    expect(again.messages).toHaveLength(0);
  });

  it("detects only new messages on subsequent syncs", async () => {
    const first = await pop3Provider.fetchNew(conn, {});
    server.messages.push({ uidl: "u3", raw: rfc822("Fresh news", "hi", "m3") });
    const second = await pop3Provider.fetchNew(conn, first.state);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]!.subject).toBe("Fresh news");
    expect(second.messages[0]!.dedupeKey).toBe("<m3@fake.test>");
  });

  it("forgets UIDLs that left the server (bounded watermark)", async () => {
    const state1 = (await pop3Provider.fetchNew(conn, {})).state as { seen: string[] };
    expect(state1.seen.length).toBe(server.messages.length);
    server.messages = server.messages.slice(-1); // user emptied mailbox
    const state2 = (await pop3Provider.fetchNew(conn, state1)).state as { seen: string[] };
    expect(state2.seen.length).toBe(1);
  });
});
