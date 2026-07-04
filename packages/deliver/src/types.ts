/** Channel abstraction: anything that can receive a Pigeon notification. */

export type ChannelKind = "discord" | "whatsapp" | "signal";

export type Priority = "urgent" | "important" | "everything";

export const PRIORITY_ORDER: Record<Priority, number> = {
  urgent: 3,
  important: 2,
  everything: 1,
};

/** One line of a notification (an email's gist). */
export interface MessageLine {
  fromName: string;
  subject: string;
  summary: string;
  priority: Priority;
  suggestedAction?: string;
  mailboxLabel?: string;
}

/** A structured outbound notification; connectors own the formatting. */
export interface OutboundMessage {
  kind: "immediate" | "digest" | "reassurance" | "test";
  title: string;
  lines: MessageLine[];
  /** Free-form footer, e.g. "3 more in your dashboard". */
  footer?: string;
}

export interface ChannelConnector {
  readonly kind: ChannelKind;
  /** Throws with a readable message when the config is unusable. */
  validateConfig(config: Record<string, unknown>): void;
  send(config: Record<string, unknown>, message: OutboundMessage): Promise<void>;
}

export class ChannelSendError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = "ChannelSendError";
  }
}
