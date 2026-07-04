/**
 * POP3 inbox provider with a minimal hand-written client (USER/PASS, STAT,
 * UIDL, RETR, QUIT over TLS or plain TCP). No maintained POP3 libraries
 * exist for Node, and the protocol is small enough to own.
 *
 * Watermark: { seen: string[] } — the UIDLs currently known. POP3 has no
 * monotonic cursor, so "new" = UIDL on server that we haven't seen. The
 * stored set is replaced by the server's current UIDL list each sync, so it
 * cannot grow beyond the mailbox size.
 */
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { createConnection, type Socket } from "node:net";
import { simpleParser } from "mailparser";
import { parsedToMessage } from "./imap.js";
import {
  FIRST_SYNC_BACKFILL,
  type FetchOptions,
  type FetchResult,
  type IncomingMessage,
  type InboxProvider,
  type MailConnection,
  type SyncState,
} from "../types.js";

const TIMEOUT_MS = 20_000;

class Pop3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Pop3Error";
  }
}

export class Pop3Client {
  private socket!: Socket | TLSSocket;
  private buffer = Buffer.alloc(0);
  private closed = false;

  static async connect(conn: MailConnection): Promise<Pop3Client> {
    const client = new Pop3Client();
    await client.open(conn);
    return client;
  }

  private open(conn: MailConnection): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(new Pop3Error(`connection failed: ${err.message}`));
      this.socket = conn.tls
        ? tlsConnect({ host: conn.host, port: conn.port, servername: conn.host }, () => {})
        : createConnection({ host: conn.host, port: conn.port });
      this.socket.setTimeout(TIMEOUT_MS, () => {
        this.socket.destroy(new Pop3Error("timeout"));
      });
      this.socket.once("error", onError);
      this.socket.on("close", () => {
        this.closed = true;
      });
      // Server greets first.
      this.readLine()
        .then((greeting) => {
          this.socket.removeListener("error", onError);
          if (!greeting.startsWith("+OK")) {
            reject(new Pop3Error(`unexpected greeting: ${greeting}`));
          } else {
            resolve();
          }
        })
        .catch(reject);
    });
  }

  private waitForData(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Pop3Error("connection closed"));
      const onData = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Pop3Error("connection closed"));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.socket.removeListener("data", onData);
        this.socket.removeListener("close", onClose);
        this.socket.removeListener("error", onError);
      };
      this.socket.once("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        onData();
      });
      this.socket.once("close", onClose);
      this.socket.once("error", onError);
    });
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf("\r\n");
      if (idx !== -1) {
        const line = this.buffer.subarray(0, idx).toString("utf8");
        this.buffer = this.buffer.subarray(idx + 2);
        return line;
      }
      await this.waitForData();
    }
  }

  /** Read a multiline response body terminated by a lone ".", un-stuffing dots. */
  private async readMultiline(): Promise<string[]> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line === ".") return lines;
      lines.push(line.startsWith("..") ? line.slice(1) : line);
    }
  }

  private send(line: string): void {
    this.socket.write(line + "\r\n");
  }

  /** Single-line command; throws on -ERR. */
  async cmd(line: string): Promise<string> {
    this.send(line);
    const res = await this.readLine();
    if (!res.startsWith("+OK")) {
      throw new Pop3Error(`${line.split(" ")[0]} failed: ${res}`);
    }
    return res;
  }

  async login(user: string, pass: string): Promise<void> {
    await this.cmd(`USER ${user}`);
    this.send(`PASS ${pass}`);
    const res = await this.readLine();
    if (!res.startsWith("+OK")) {
      throw new Pop3Error("authentication failed");
    }
  }

  /** UIDL — returns [messageNumber, uidl] pairs. */
  async uidl(): Promise<Array<[number, string]>> {
    await this.cmd("UIDL");
    const lines = await this.readMultiline();
    return lines.map((l) => {
      const [n, id] = l.split(" ");
      return [Number(n), id ?? ""] as [number, string];
    });
  }

  /** RETR — returns the raw RFC822 source of one message. */
  async retr(messageNumber: number): Promise<string> {
    await this.cmd(`RETR ${messageNumber}`);
    const lines = await this.readMultiline();
    return lines.join("\r\n");
  }

  async quit(): Promise<void> {
    try {
      await this.cmd("QUIT");
    } catch {
      // best effort
    }
    this.socket.destroy();
  }
}

interface Pop3State {
  seen?: string[];
}

export const pop3Provider: InboxProvider = {
  protocol: "pop3",

  async testConnection(conn) {
    const client = await Pop3Client.connect(conn);
    try {
      await client.login(conn.username, conn.secret);
      await client.cmd("STAT");
    } finally {
      await client.quit();
    }
  },

  async fetchNew(conn, rawState: SyncState, options: FetchOptions = {}): Promise<FetchResult> {
    const limit = options.limit ?? 50;
    const state = rawState as Pop3State;
    const firstSync = !Array.isArray(state.seen);
    const seen = new Set(state.seen ?? []);

    const client = await Pop3Client.connect(conn);
    try {
      await client.login(conn.username, conn.secret);
      const listing = await client.uidl();
      const unseen = listing.filter(([, id]) => !seen.has(id));
      // First sync: only a capped backfill of the newest messages.
      const wanted = firstSync ? unseen.slice(-FIRST_SYNC_BACKFILL) : unseen;
      const batch = wanted.slice(0, limit);

      const messages: IncomingMessage[] = [];
      for (const [n] of batch) {
        const source = await client.retr(n);
        const parsed = await simpleParser(source);
        messages.push(parsedToMessage(parsed, new Date()));
      }

      // New watermark = everything currently on the server. Messages we
      // skipped (over limit) stay "new" next sync because we only record
      // the UIDLs we actually fetched, plus what was already seen.
      const fetchedIds = new Set(batch.map(([, id]) => id));
      const nextSeen = listing
        .map(([, id]) => id)
        .filter((id) => seen.has(id) || fetchedIds.has(id) || (firstSync && !fetchedIds.has(id)));

      return {
        messages,
        state: { seen: nextSeen },
        hasMore: wanted.length > batch.length,
      };
    } finally {
      await client.quit();
    }
  },
};
