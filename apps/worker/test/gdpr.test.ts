/** Erasure job wipes every trace; retention prunes by age. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "@pigeon/config";
import { startTestDb, type TestDb } from "@pigeon/db/testing";
import { createRunner, enqueue } from "@pigeon/queue";
import { createVaultFromMasterKey } from "@pigeon/vault";
import { registerGdprJobs, JOB_GDPR_ERASE, RETENTION } from "../src/jobs/gdpr.js";

const logger = createLogger("error", { name: "gdpr-test" });

describe("gdpr jobs", () => {
  let db: TestDb;
  let userId: string;

  beforeAll(async () => {
    db = await startTestDb();
    const user = await db.pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('wipe@t.dev','x') RETURNING id",
    );
    userId = user.rows[0].id;
    const mb = await db.pool.query(
      `INSERT INTO mailboxes (user_id, provider, protocol, address, host, port, tls, username, credentials_sealed)
       VALUES ($1,'mock','mock','wipe@t.dev','mock',1,false,'w','x') RETURNING id`,
      [userId],
    );
    await db.pool.query(
      `INSERT INTO emails (mailbox_id, user_id, dedupe_key, subject, body_text, received_at)
       VALUES ($1,$2,'<w1@x>','hello','body',now())`,
      [mb.rows[0].id, userId],
    );
    await db.pool.query(
      `INSERT INTO channels (user_id, kind, label, config_sealed) VALUES ($1,'discord','c','x')`,
      [userId],
    );
    await db.pool.query(
      "INSERT INTO usage_counters (user_id, period, emails_processed) VALUES ($1,'2026-07',5)",
      [userId],
    );
    await db.pool.query("INSERT INTO consents (user_id, kind, granted) VALUES ($1,'terms',true)", [userId]);
  });
  afterAll(async () => {
    await db.stop();
  });

  it("erasure job removes the user and every dependent row", async () => {
    const config = loadConfig(
      {
        NODE_ENV: "test",
        DATABASE_URL: db.connectionString,
        VAULT_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
        SESSION_SECRET: "s".repeat(40),
      },
      { dotenv: false },
    );
    const runner = createRunner(db.pool, logger);
    registerGdprJobs(runner, {
      config,
      logger,
      vault: createVaultFromMasterKey(config.VAULT_MASTER_KEY),
    });

    const request = await db.pool.query(
      "INSERT INTO erasure_requests (user_id) VALUES ($1) RETURNING id",
      [userId],
    );
    // A stale pending job referencing the user must be scrubbed too.
    await enqueue(db.pool, "mailbox.sync", { mailboxId: "x", userId });
    await enqueue(db.pool, JOB_GDPR_ERASE, { userId, requestId: request.rows[0].id });
    await runner.drain();

    for (const table of [
      "users",
      "mailboxes",
      "emails",
      "channels",
      "usage_counters",
      "consents",
      "sessions",
    ]) {
      const { rows } = await db.pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${table === "users" ? "id" : "user_id"} = $1`,
        [userId],
      );
      expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
    }
    const req = await db.pool.query("SELECT status FROM erasure_requests WHERE id = $1", [
      request.rows[0].id,
    ]);
    expect(req.rows[0].status).toBe("done");
    // Audit trail survives with only a hash.
    const auditRows = await db.pool.query(
      "SELECT detail FROM audit_log WHERE action = 'gdpr.erase.completed'",
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(JSON.stringify(auditRows.rows[0].detail)).not.toContain("wipe@t.dev");
    // The user-referencing pending job was scrubbed.
    const stale = await db.pool.query(
      "SELECT count(*)::int AS n FROM jobs WHERE type = 'mailbox.sync' AND status = 'pending'",
    );
    expect(stale.rows[0].n).toBe(0);
  });

  it("retention cleanup deletes only out-of-window rows", async () => {
    const user = await db.pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('keep@t.dev','x') RETURNING id",
    );
    const mb = await db.pool.query(
      `INSERT INTO mailboxes (user_id, provider, protocol, address, host, port, tls, username, credentials_sealed)
       VALUES ($1,'mock','mock','keep@t.dev','mock',1,false,'k','x') RETURNING id`,
      [user.rows[0].id],
    );
    await db.pool.query(
      `INSERT INTO emails (mailbox_id, user_id, dedupe_key, subject, body_text, received_at, created_at)
       VALUES ($1,$2,'<old@x>','old','x',now(), now() - interval '${RETENTION.emailsDays + 1} days'),
              ($1,$2,'<new@x>','new','x',now(), now())`,
      [mb.rows[0].id, user.rows[0].id],
    );

    const config = loadConfig(
      {
        NODE_ENV: "test",
        DATABASE_URL: db.connectionString,
        VAULT_MASTER_KEY: Buffer.alloc(32, 4).toString("base64"),
        SESSION_SECRET: "s".repeat(40),
      },
      { dotenv: false },
    );
    const runner = createRunner(db.pool, logger);
    const tasks = registerGdprJobs(runner, {
      config,
      logger,
      vault: createVaultFromMasterKey(config.VAULT_MASTER_KEY),
    });
    const cleanup = tasks.find((t) => t.name === "retention-cleanup")!;
    await cleanup.run(db.pool, logger);

    const { rows } = await db.pool.query(
      "SELECT subject FROM emails WHERE user_id = $1 ORDER BY subject",
      [user.rows[0].id],
    );
    expect(rows.map((r) => r.subject)).toEqual(["new"]);
  });
});
