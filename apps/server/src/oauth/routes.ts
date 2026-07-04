/**
 * /api/oauth — Gmail/Microsoft connect flow (env-gated).
 * start → 302 to the provider's consent screen (HMAC-signed state);
 * callback → code exchange → mailbox created with vault-sealed tokens.
 */
import { Hono } from "hono";
import { audit } from "@pigeon/db";
import {
  buildAuthUrl,
  createMailbox,
  enabledOAuthProviders,
  exchangeCode,
  JOB_MAILBOX_SYNC,
  signOAuthState,
  verifyOAuthState,
} from "@pigeon/mail";
import { canAddMailbox, tierLimits } from "@pigeon/quota";
import { enqueue } from "@pigeon/queue";
import type { AppEnv } from "../app.js";
import { requireAuth } from "../auth/middleware.js";

function redirectUri(apiOrigin: string, providerId: string): string {
  return `${apiOrigin}/api/oauth/${providerId}/callback`;
}

export const oauthRoutes = new Hono<AppEnv>()
  // Which providers are configured — the UI shows/hides buttons with this.
  .get("/providers", (c) => {
    const { config } = c.get("deps");
    return c.json({
      providers: enabledOAuthProviders(config).map(({ def }) => ({
        id: def.id,
        displayName: def.displayName,
        providerBadge: def.providerBadge,
      })),
    });
  })

  .get("/:provider/start", requireAuth, async (c) => {
    const { config, pool } = c.get("deps");
    const user = c.get("user");
    const enabled = enabledOAuthProviders(config).find(
      (p) => p.def.id === c.req.param("provider"),
    );
    if (!enabled) return c.json({ error: "provider not configured" }, 404);

    if (!(await canAddMailbox(pool, user.id, user.tier))) {
      const limits = tierLimits(user.tier);
      return c.json(
        { error: `your ${limits.name} plan allows ${limits.maxMailboxes} mailboxes`, code: "quota_mailboxes" },
        403,
      );
    }

    const state = signOAuthState(config.SESSION_SECRET, {
      userId: user.id,
      provider: enabled.def.id,
    });
    return c.redirect(
      buildAuthUrl(enabled.def, {
        clientId: enabled.clientId,
        redirectUri: redirectUri(config.API_ORIGIN, enabled.def.id),
        state,
      }),
    );
  })

  // No session requirement: the signed state carries the user identity
  // (browser arrives here from the provider, cookies may be cross-site).
  .get("/:provider/callback", async (c) => {
    const { config, pool, vault, logger } = c.get("deps");
    const providerId = c.req.param("provider");
    const enabled = enabledOAuthProviders(config).find((p) => p.def.id === providerId);
    if (!enabled) return c.json({ error: "provider not configured" }, 404);

    const errorParam = c.req.query("error");
    if (errorParam) {
      return c.redirect(`${config.WEB_ORIGIN}/?connect=denied`);
    }
    const code = c.req.query("code") ?? "";
    const stateParam = c.req.query("state") ?? "";
    const state = verifyOAuthState(config.SESSION_SECRET, stateParam);
    if (!code || !state || state.provider !== providerId) {
      return c.json({ error: "invalid or expired state" }, 400);
    }

    try {
      const tokens = await exchangeCode(enabled.def, {
        clientId: enabled.clientId,
        clientSecret: enabled.clientSecret,
        redirectUri: redirectUri(config.API_ORIGIN, providerId),
        code,
      });
      const address = tokens.email ?? `${providerId}-account`;
      const mailbox = await createMailbox(pool, vault, {
        userId: state.userId,
        provider: enabled.def.providerBadge,
        protocol: enabled.def.protocol,
        label: enabled.def.displayName,
        address,
        host: enabled.def.imapHost,
        port: enabled.def.imapPort,
        tls: true,
        username: address,
        secret: JSON.stringify({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        }),
      });
      await enqueue(pool, JOB_MAILBOX_SYNC, { mailboxId: mailbox.id }, {
        idempotencyKey: `${mailbox.id}:initial`,
      });
      await audit(pool, {
        userId: state.userId,
        actor: "user",
        action: "mailbox.connect.oauth",
        detail: { provider: providerId },
      });
      return c.redirect(`${config.WEB_ORIGIN}/?connect=ok`);
    } catch (err) {
      logger.error("oauth callback failed", {
        provider: providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.redirect(`${config.WEB_ORIGIN}/?connect=failed`);
    }
  });
