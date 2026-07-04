import type { Provider } from "@pigeon/shared";

export interface MailProtocolDefaults {
  host: string;
  port: number;
}

export interface ProviderConfig {
  id: Provider;
  name: string;
  /** Default IMAP host for this provider. */
  host: string;
  /** Default IMAP port (993 = IMAP over TLS). */
  port: number;
  /** POP3 defaults (995 = POP3 over TLS); null when the provider has no POP3. */
  pop3: MailProtocolDefaults | null;
  /** Short helper shown in the credential step. */
  note: string;
}

/** The providers Pigeon offers in the "Add inbox" flow. */
export const PROVIDERS: ProviderConfig[] = [
  {
    id: "gmail",
    name: "Gmail",
    host: "imap.gmail.com",
    port: 993,
    pop3: { host: "pop.gmail.com", port: 995 },
    note: "Turn on 2-step verification, then create an App Password under your Google Account → Security. For POP3, also enable POP in Gmail Settings → Forwarding and POP/IMAP.",
  },
  {
    id: "outlook",
    name: "Outlook",
    host: "outlook.office365.com",
    port: 993,
    pop3: { host: "outlook.office365.com", port: 995 },
    note: "If 2FA is enabled, generate an app password in Microsoft account security settings.",
  },
  {
    id: "icloud",
    name: "iCloud Mail",
    host: "imap.mail.me.com",
    port: 993,
    pop3: null, // iCloud offers IMAP only
    note: "Generate an app-specific password at appleid.apple.com → Sign-In & Security.",
  },
  {
    id: "fastmail",
    name: "Fastmail",
    host: "imap.fastmail.com",
    port: 993,
    pop3: { host: "pop.fastmail.com", port: 995 },
    note: "Create an app password under Settings → Privacy & Security → App passwords.",
  },
  {
    id: "imap",
    name: "Other (IMAP/POP3)",
    host: "",
    port: 993,
    pop3: { host: "", port: 995 },
    note: "Enter the host and port from your email provider's documentation.",
  },
  {
    id: "mock",
    name: "Demo inbox",
    host: "mock",
    port: 1,
    pop3: null,
    note: "A built-in demo mailbox: it receives sample emails so you can watch the whole pipeline work without real credentials. Any password works.",
  },
];

export function providerConfig(id: Provider): ProviderConfig {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1]!;
}
