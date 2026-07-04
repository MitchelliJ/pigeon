/**
 * Delivery E2E against a fake Discord webhook endpoint: immediate routing,
 * digest rollup, dedupe, retry semantics, quiet reassurance.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@pigeon/config";
import { startTestDb, type TestDb } from "@pigeon/db/testing";
import { createVaultFromMasterKey } from "@pigeon/vault";
import { routeEmail, sendDigest } from "../src/service.js";
import { getDeliverySettings, updateDeliverySettings } from "../src/store.js";

const logger = createLogger("error", { name: "deliver-test" });
const vault = createVaultFromMasterKey(Buffer.alloc(32, 5).toString("base64"));

let webhook: Server;
let webhookUrl: string;
let received: Array<{ content: string }> = [];
let respondWith = 204;

describe("delivery engine", () => {
  let db: TestDb;
  let userId: string;
  let mailboxId: string;
  let urgentChannelId: string;

  async function insertEmail(input: {
    subject: string;
    summary: string;
    priority: "urgent" | "important" | "everything";
    dedupe: string;
  }): Promise<string> {
    const { rows } = await db.pool.query(
      `INSERT INTO emails (mailbox_id, user_id, dedupe_key, from_name, from_address,
                           subject, body_text, received_at, summary, priority,
                           needs_attention, processed_at)
       VALUES ($1,$2,$3,'Sender','s@x.y',$4,'body',now(),$5,$6,$7,now())
       RETURNING id`,
      [mailboxId, userId, input.dedupe, input.subject, input.summary, input.priority, input.priority === "urgent"],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    webhook = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        if (respondWith < 400) received.push(JSON.parse(data));
        res.writeHead(respondWith);
        res.end();
      });
    });
    await new Promise<void>((r) => webhook.listen(0, "127.0.0.1", r));
    webhookUrl = `http://127.0.0.1:${(webhook.address() as { port: number }).port}/api/webhooks/1/x`;

    db = await startTestDb();
    const user = await db.pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('d@t.dev','x') RETURNING id",
    );
    userId = user.rows[0].id;
    const mb = await db.pool.query(
      `INSERT INTO mailboxes (user_id, provider, protocol, label, address, host, port, tls, username, credentials_sealed)
       VALUES ($1,'mock','mock','Personal','d@t.dev','mock',1,false,'d@t.dev','x') RETURNING id`,
      [userId],
    );
    mailboxId = mb.rows[0].id;
    // Channel inserted directly (route-level validation requires a real
    // discord.com URL; the connector itself posts anywhere).
    const ch = await db.pool.query(
      `INSERT INTO channels (user_id, kind, label, config_sealed, min_priority)
       VALUES ($1,'discord','Test channel',$2,'urgent') RETURNING id`,
      [userId, vault.seal(JSON.stringify({ webhookUrl }))],
    );
    urgentChannelId = ch.rows[0].id;
    await updateDeliverySettings(db.pool, userId, {
      digestChannelId: urgentChannelId,
      timezone: "UTC",
      digestTime: "08:00",
    });
  });
  afterAll(async () => {
    await db.stop();
    await new Promise<void>((r) => webhook.close(() => r()));
  });

  it("routes an urgent email immediately, once", async () => {
    const emailId = await insertEmail({
      subject: "Pay invoice",
      summary: "Invoice €24 due tomorrow.",
      priority: "urgent",
      dedupe: "<u1@x>",
    });
    const first = await routeEmail(db.pool, vault, logger, emailId);
    expect(first.sent).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.content).toContain("Invoice €24 due tomorrow.");
    expect(received[0]!.content).toContain("Needs you now");

    const again = await routeEmail(db.pool, vault, logger, emailId);
    expect(again.sent).toBe(0);
    expect(again.skipped).toBe(1);
    expect(received).toHaveLength(1); // no double notify

    const { rows } = await db.pool.query(
      "SELECT delivered_immediate_at FROM emails WHERE id = $1",
      [emailId],
    );
    expect(rows[0].delivered_immediate_at).not.toBeNull();
  });

  it("does not push emails below the channel threshold", async () => {
    const emailId = await insertEmail({
      subject: "Newsletter",
      summary: "Weekly roundup.",
      priority: "everything",
      dedupe: "<n1@x>",
    });
    const outcome = await routeEmail(db.pool, vault, logger, emailId);
    expect(outcome.sent).toBe(0);
    expect(received).toHaveLength(1); // unchanged
  });

  it("retryable webhook failure throws; retry succeeds without duplicates", async () => {
    const emailId = await insertEmail({
      subject: "Server down?",
      summary: "Reply needed on the incident.",
      priority: "urgent",
      dedupe: "<u2@x>",
    });
    respondWith = 500;
    await expect(routeEmail(db.pool, vault, logger, emailId)).rejects.toThrow(/incomplete/);
    const failed = await db.pool.query(
      "SELECT status FROM deliveries WHERE email_id = $1",
      [emailId],
    );
    expect(failed.rows[0].status).toBe("failed");

    respondWith = 204;
    const retry = await routeEmail(db.pool, vault, logger, emailId);
    expect(retry.sent).toBe(1);
    expect(received.filter((r) => r.content.includes("incident"))).toHaveLength(1);
  });

  it("digest rolls up undelivered emails, marks them, and dedupes per day", async () => {
    await insertEmail({
      subject: "Delivery window",
      summary: "Package arrives Thursday 9-12.",
      priority: "important",
      dedupe: "<i1@x>",
    });
    const before = received.length;
    const outcome = await sendDigest(db.pool, vault, logger, userId);
    expect(outcome).toBe("sent");
    expect(received).toHaveLength(before + 1);
    const digest = received.at(-1)!.content;
    expect(digest).toContain("daily digest");
    expect(digest).toContain("Package arrives Thursday 9-12.");
    expect(digest).toContain("Weekly roundup."); // the skipped newsletter
    expect(digest).not.toContain("Invoice €24"); // already pushed immediately

    const undigested = await db.pool.query(
      "SELECT count(*)::int AS n FROM emails WHERE user_id = $1 AND digested_at IS NULL AND delivered_immediate_at IS NULL",
      [userId],
    );
    expect(undigested.rows[0].n).toBe(0);

    // Same-day rerun: nothing new, no reassurance either (digest went out).
    const rerun = await sendDigest(db.pool, vault, logger, userId);
    expect(rerun).toBe("skipped");
    expect(received).toHaveLength(before + 1);
  });

  it("sends the quiet reassurance on an empty day", async () => {
    // Pretend the last digest was yesterday; queue is empty now.
    await db.pool.query(
      "UPDATE delivery_settings SET last_digest_at = now() - interval '1 day' WHERE user_id = $1",
      [userId],
    );
    await db.pool.query("DELETE FROM deliveries WHERE kind = 'digest'");
    const before = received.length;
    const outcome = await sendDigest(db.pool, vault, logger, userId);
    expect(outcome).toBe("reassured");
    expect(received).toHaveLength(before + 1);
    expect(received.at(-1)!.content).toContain("All quiet");
    const settings = await getDeliverySettings(db.pool, userId);
    expect(settings.lastDigestAt).not.toBeNull();
  });
});
