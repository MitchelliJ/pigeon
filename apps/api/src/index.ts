/**
 * Pigeon — single-file mock API.
 *
 * Everything lives here on purpose: all the mock data AND the (tiny) server.
 * The dashboard hits `GET /api/dashboard` and renders whatever this returns.
 * To wire up a real backend later, keep the response shape (see @pigeon/shared)
 * and replace the data below with live IMAP/POP3 + LLM-summarised results.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type {
  Channel,
  DashboardData,
  Digest,
  Email,
  EmailAccount,
  Stats,
} from "@pigeon/shared";

/* ------------------------------------------------------------------ *
 *  Mock data
 * ------------------------------------------------------------------ */

const accounts: EmailAccount[] = [
  {
    id: "acc_gmail",
    provider: "gmail",
    label: "Personal",
    address: "michiel.personal@example.com",
    protocol: "imap",
    status: "connected",
    unread: 8,
  },
  {
    id: "acc_outlook",
    provider: "outlook",
    label: "Work",
    address: "michiel.work@example.com",
    protocol: "imap",
    status: "connected",
    unread: 3,
  },
  {
    id: "acc_fastmail",
    provider: "fastmail",
    label: "Side project",
    address: "hello@example.com",
    protocol: "imap",
    status: "disconnected",
    unread: 0,
  },
];

const emails: Email[] = [
  {
    id: "em_1",
    accountId: "acc_outlook",
    fromName: "Priya Nair",
    fromAddress: "priya.nair@example.com",
    subject: "Re: Contract — we need your sign-off before 5pm",
    summary:
      "Priya needs your signature on the renewed contract today or the vendor pushes the start date by two weeks.",
    body:
      "Hi,\n\nJust circling back on the renewal — legal has finalised the redlines and we're ready for signature. The vendor has been clear that if we don't return a signed copy before 5pm today, they'll push our start date back by two weeks, which knocks the whole rollout into next quarter.\n\nThe signing link is in the previous email. Could you get it over the line this afternoon? Happy to hop on a quick call if anything in the terms still needs a second look.\n\nThanks,\nPriya",
    priority: "urgent",
    receivedAt: "8m ago",
    needsAttention: true,
    suggestedAction: "Reply now",
  },
  {
    id: "em_2",
    accountId: "acc_gmail",
    fromName: "Dr. Holloway's Office",
    fromAddress: "appointments@example.com",
    subject: "Your appointment is being rescheduled",
    summary:
      "Your Thursday appointment was moved to Friday 10:00 — they ask you to confirm or it will be cancelled.",
    body:
      "Dear patient,\n\nDue to an unexpected change in Dr. Holloway's schedule, your appointment originally booked for this Thursday has been moved to Friday at 10:00.\n\nPlease confirm that the new time works for you by replying to this message or calling the clinic. If we don't hear back within 24 hours, the appointment will be cancelled and you'll need to rebook.\n\nKind regards,\nThe Holloway Clinic",
    priority: "urgent",
    receivedAt: "31m ago",
    needsAttention: true,
    suggestedAction: "Confirm",
  },
  {
    id: "em_3",
    accountId: "acc_outlook",
    fromName: "Stripe",
    fromAddress: "no-reply@example.com",
    subject: "A payment of €2,400 failed",
    summary:
      "A customer's €2,400 subscription payment failed and will retry in 3 days unless you update the card on file.",
    body:
      "Hello,\n\nWe were unable to charge €2,400.00 for the subscription on account acme-eu. The card issuer declined the transaction (insufficient funds).\n\nWe'll automatically retry the payment in 3 days. To avoid an interruption to the subscription, you can update the card on file from your Stripe dashboard at any time before then.\n\n— The Stripe team",
    priority: "important",
    receivedAt: "1h ago",
    needsAttention: true,
  },
  {
    id: "em_4",
    accountId: "acc_gmail",
    fromName: "Marco (Landlord)",
    fromAddress: "marco.devries@example.com",
    subject: "Plumber coming by next week",
    summary:
      "Your landlord scheduled a plumber for next Tuesday afternoon and wants to know if someone will be home.",
    body:
      "Hi,\n\nI've arranged for a plumber to come by next Tuesday afternoon, somewhere between 13:00 and 16:00, to finally sort out the dripping tap in the bathroom and check the boiler pressure.\n\nCould you let me know if someone will be home to let him in? If not, I can drop off the spare key, just give me a heads up.\n\nCheers,\nMarco",
    priority: "important",
    receivedAt: "2h ago",
    needsAttention: true,
  },
  {
    id: "em_5",
    accountId: "acc_gmail",
    fromName: "GitHub",
    fromAddress: "notifications@example.com",
    subject: "Your monthly usage report is ready",
    summary:
      "Routine monthly usage summary for your repositories — nothing requires action.",
    body:
      "Hi there,\n\nYour monthly usage report is ready. Across your repositories this month you used 1,240 Actions minutes (of 2,000 included) and 3.1 GB of Packages storage.\n\nNo action is needed — this is just your regular summary. You can view the full breakdown in your account billing settings.\n\n— GitHub",
    priority: "everything",
    receivedAt: "3h ago",
    needsAttention: false,
  },
  {
    id: "em_6",
    accountId: "acc_gmail",
    fromName: "Mum",
    fromAddress: "anneke@example.com",
    subject: "Sunday dinner?",
    summary:
      "Your mum is asking whether you'll come over for dinner on Sunday and what you'd like to eat.",
    body:
      "Hi love,\n\nAre you coming over for dinner this Sunday? Dad's going to fire up the barbecue if the weather holds, otherwise I'll make the pasta you like.\n\nLet me know what you fancy and whether you're bringing anyone. Don't leave it too late so I can do the shopping!\n\nLots of love,\nMum xx",
    priority: "everything",
    receivedAt: "5h ago",
    needsAttention: false,
  },
];

const channels: Channel[] = [
  {
    id: "ch_whatsapp",
    kind: "whatsapp",
    label: "WhatsApp",
    webhookUrl: "https://hooks.pigeon.app/wa/8f3a…",
    minPriority: "urgent",
    enabled: true,
  },
  {
    id: "ch_signal",
    kind: "signal",
    label: "Signal",
    webhookUrl: "https://hooks.pigeon.app/sig/22b1…",
    minPriority: "important",
    enabled: true,
  },
  {
    id: "ch_discord",
    kind: "discord",
    label: "Discord",
    webhookUrl: "",
    minPriority: "everything",
    enabled: false,
  },
];

const digest: Digest = {
  enabled: true,
  time: "08:00",
  days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  channelId: "ch_whatsapp",
  lastSent: "today at 8:00am",
};

/* ------------------------------------------------------------------ *
 *  Derived values
 * ------------------------------------------------------------------ */

function computeStats(list: Email[]): Stats {
  return list.reduce<Stats>(
    (acc, e) => {
      acc[e.priority] += 1;
      return acc;
    },
    { urgent: 0, important: 0, everything: 0 },
  );
}

function buildDashboard(): DashboardData {
  return {
    user: {
      name: "Michiel",
      email: "michiel@example.com",
      plan: {
        tier: "pro",
        name: "Pro",
        price: "€8 / mo",
        inboxLimit: 10,
        nextBillingDate: "July 1, 2026",
        canUpgrade: true,
      },
    },
    stats: computeStats(emails),
    emails,
    accounts,
    channels,
    digest,
    lastSync: "2m ago",
  };
}

/* ------------------------------------------------------------------ *
 *  Server
 * ------------------------------------------------------------------ */

const app = new Hono();

app.use("*", cors());

app.get("/", (c) =>
  c.json({ name: "pigeon-api", endpoints: ["/api/health", "/api/dashboard"] }),
);

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/dashboard", (c) => c.json(buildDashboard()));

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🕊️  Pigeon mock API → http://localhost:${info.port}`);
});
