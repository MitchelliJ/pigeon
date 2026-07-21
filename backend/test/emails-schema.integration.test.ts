/* Integration coverage for the normalized message and mailbox occurrence schema. */
import { describe, expect, it } from "vitest";
import { withTestDb } from "./db";
import { runMigrations } from "../src/migrate/runner";

type TestDbClient = Awaited<ReturnType<typeof withTestDb>>["db"];

async function insertUser(db: TestDbClient, email: string): Promise<string> {
  const rows =
    await db.query`INSERT INTO users(email, name, password_hash) VALUES (${email}, 'U', 'h') RETURNING id`;
  return String(rows[0]?.id);
}

async function insertMailbox(
  db: TestDbClient,
  userId: string,
  address: string,
): Promise<string> {
  const rows = await db.query`
    INSERT INTO mailboxes(
      user_id, provider, protocol, label, address, host, port, tls,
      username, password_ciphertext
    ) VALUES (
      ${userId}, 'imap', 'imap', 'Work', ${address}, 'imap.example.com', 993,
      true, ${address}, 'ciphertext'
    ) RETURNING id`;
  return String(rows[0]?.id);
}

async function insertMessageOccurrence(
  db: TestDbClient,
  userId: string,
  mailboxId: string,
  providerUid: string,
  seen = false,
): Promise<string> {
  const rows = await db.query`
    WITH inserted AS (
      INSERT INTO messages(
        user_id, identity_key, from_name, from_address, subject, body, received_at
      ) VALUES (
        ${userId}, ${providerUid}, 'Alice', 'alice@example.com', 'Hello',
        'Body text', ${new Date("2026-01-01T00:00:00Z")}
      ) RETURNING id
    )
    INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid, seen)
    SELECT ${mailboxId}, id, ${providerUid}, ${seen} FROM inserted
    RETURNING message_id`;
  return String(rows[0]?.message_id);
}

describe("normalized messages schema", () => {
  it("creates canonical messages and mailbox occurrences with expected columns", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const tables = await db.query`
        SELECT to_regclass('public.messages') AS messages,
               to_regclass('public.mailbox_messages') AS mailbox_messages`;
      expect(tables[0]?.messages).not.toBeNull();
      expect(tables[0]?.mailbox_messages).not.toBeNull();

      const rows = await db.query`
        SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name IN ('messages', 'mailbox_messages')
        ORDER BY table_name, column_name`;
      const columns = new Map(
        rows.map((row) => [
          `${String(row.table_name)}.${String(row.column_name)}`,
          { data_type: row.data_type, is_nullable: row.is_nullable },
        ]),
      );
      expect(columns.get("messages.user_id")).toEqual({
        data_type: "uuid",
        is_nullable: "NO",
      });
      expect(columns.get("messages.identity_key")).toEqual({
        data_type: "text",
        is_nullable: "NO",
      });
      expect(columns.get("mailbox_messages.message_id")).toEqual({
        data_type: "uuid",
        is_nullable: "NO",
      });
      expect(columns.get("mailbox_messages.seen")).toEqual({
        data_type: "boolean",
        is_nullable: "NO",
      });
    } finally {
      await close();
    }
  });

  it("inserts and reads canonical content with mailbox-specific state", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "owner@example.com");
      const mailboxId = await insertMailbox(db, userId, "inbox@example.com");
      const messageId = await insertMessageOccurrence(
        db,
        userId,
        mailboxId,
        "uid-1",
        true,
      );

      const rows = await db.query`
        SELECT m.subject, m.from_address, m.body, mm.seen, mm.provider_uid
        FROM messages m
        JOIN mailbox_messages mm ON mm.message_id = m.id
        WHERE m.id = ${messageId}`;
      expect(rows).toEqual([
        {
          subject: "Hello",
          from_address: "alice@example.com",
          body: "Body text",
          seen: true,
          provider_uid: "uid-1",
        },
      ]);
    } finally {
      await close();
    }
  });

  it("enforces mailbox provider UID uniqueness and deletes orphan messages", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const userId = await insertUser(db, "constraints@example.com");
      const mailboxId = await insertMailbox(db, userId, "box@example.com");
      const messageId = await insertMessageOccurrence(
        db,
        userId,
        mailboxId,
        "uid-duplicate",
      );
      const secondRows = await db.query`
        INSERT INTO messages(
          user_id, identity_key, from_name, from_address, subject, body, received_at
        ) VALUES (
          ${userId}, 'second', 'Bob', 'bob@example.com', 'Other', 'Body', now()
        ) RETURNING id`;
      await expect(
        db.query`
          INSERT INTO mailbox_messages(mailbox_id, message_id, provider_uid)
          VALUES (${mailboxId}, ${String(secondRows[0]?.id)}, 'uid-duplicate')`,
      ).rejects.toThrow();

      await db.query`DELETE FROM mailboxes WHERE id = ${mailboxId}`;
      expect(
        await db.query`SELECT id FROM messages WHERE id = ${messageId}`,
      ).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("keeps mailboxes.last_synced_at nullable and defaulting to NULL", async () => {
    const { db, close } = await withTestDb();
    try {
      await runMigrations(db);
      const columnRows = await db.query`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'mailboxes' AND column_name = 'last_synced_at'`;
      expect(columnRows).toEqual([
        { data_type: "timestamp with time zone", is_nullable: "YES" },
      ]);
      const userId = await insertUser(db, "sync@example.com");
      const mailboxId = await insertMailbox(db, userId, "sync-box@example.com");
      expect(
        await db.query`SELECT last_synced_at FROM mailboxes WHERE id = ${mailboxId}`,
      ).toEqual([{ last_synced_at: null }]);
    } finally {
      await close();
    }
  });
});
