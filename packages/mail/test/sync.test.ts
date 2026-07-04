/** Sync engine E2E on the mock provider: watermarks, dedupe, job enqueue. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@pigeon/config";
import { startTestDb, type TestDb } from "@pigeon/db/testing";
import { countJobs } from "@pigeon/queue";
import { createVaultFromMasterKey } from "@pigeon/vault";
import {
  createMailbox,
  getMailbox,
  listDueMailboxes,
  mockMailServer,
  syncMailbox,
} from "../src/index.js";

const logger = createLogger("error", { name: "sync-test" });
const vault = createVaultFromMasterKey(Buffer.alloc(32, 9).toString("base64"));

describe("sync engine", () => {
  let db: TestDb;
  let userId: string;
  let mailboxId: string;
  const address = "sync-test@pigeon.test";

  beforeAll(async () => {
    db = await startTestDb();
    mockMailServer.reset();
    const { rows } = await db.pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('sync@test.dev', 'x') RETURNING id`,
    );
    userId = rows[0].id;
    const mailbox = await createMailbox(db.pool, vault, {
      userId,
      provider: "mock",
      protocol: "mock",
      label: "Test inbox",
      address,
      host: "mock",
      port: 1,
      tls: false,
      username: address,
      secret: "mock-password",
    });
    mailboxId = mailbox.id;
  });
  afterAll(async () => {
    await db.stop();
  });

  it("seals credentials at rest", async () => {
    const { rows } = await db.pool.query(
      "SELECT credentials_sealed FROM mailboxes WHERE id = $1",
      [mailboxId],
    );
    expect(rows[0].credentials_sealed).toMatch(/^v1\./);
    expect(rows[0].credentials_sealed).not.toContain("mock-password");
  });

  it("first sync backfills the welcome mail and enqueues triage jobs", async () => {
    const outcome = await syncMailbox(db.pool, vault, logger, mailboxId);
    expect(outcome.stored).toBe(3); // mock provider seeds 3 samples
    const { rows } = await db.pool.query(
      "SELECT subject FROM emails WHERE mailbox_id = $1 ORDER BY created_at",
      [mailboxId],
    );
    expect(rows).toHaveLength(3);
    const jobs = await countJobs(db.pool);
    expect(jobs.pending).toBe(3); // one email.process per stored email

    const mb = await getMailbox(db.pool, mailboxId);
    expect(mb!.status).toBe("connected");
    expect(mb!.lastSyncedAt).not.toBeNull();
    expect((mb!.syncState as { lastUid: number }).lastUid).toBeGreaterThan(0);
  });

  it("re-sync stores nothing new (watermark) and enqueues nothing", async () => {
    const before = await countJobs(db.pool);
    const outcome = await syncMailbox(db.pool, vault, logger, mailboxId);
    expect(outcome.stored).toBe(0);
    expect(await countJobs(db.pool)).toEqual(before);
  });

  it("new mail flows through; duplicate dedupe keys are suppressed", async () => {
    mockMailServer.deliver(address, {
      subject: "Invoice overdue",
      dedupeKey: "<fixed-id@x>",
    });
    mockMailServer.deliver(address, {
      subject: "Invoice overdue (dup)",
      dedupeKey: "<fixed-id@x>",
    });
    const outcome = await syncMailbox(db.pool, vault, logger, mailboxId);
    expect(outcome.fetched).toBe(2);
    expect(outcome.stored).toBe(1); // second one deduped
  });

  it("failed sync marks the mailbox errored but keeps the watermark", async () => {
    const stateBefore = (await getMailbox(db.pool, mailboxId))!.syncState;
    // Sabotage: point the mailbox at a protocol that will explode.
    await db.pool.query("UPDATE mailboxes SET protocol = 'imap', host = '127.0.0.1', port = 1 WHERE id = $1", [mailboxId]);
    await expect(syncMailbox(db.pool, vault, logger, mailboxId)).rejects.toThrow();
    const mb = await getMailbox(db.pool, mailboxId);
    expect(mb!.status).toBe("error");
    expect(mb!.syncState).toEqual(stateBefore);
    await db.pool.query("UPDATE mailboxes SET protocol = 'mock' WHERE id = $1", [mailboxId]);
  });

  it("listDueMailboxes respects the interval", async () => {
    await syncMailbox(db.pool, vault, logger, mailboxId);
    expect(await listDueMailboxes(db.pool, () => 60_000)).toHaveLength(0);
    expect(
      (await listDueMailboxes(db.pool, () => 0)).map((m) => m.id),
    ).toContain(mailboxId);
  });
});
