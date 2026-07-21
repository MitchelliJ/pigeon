/**
 * Provider-neutral channel delivery contracts.
 *
 * Delivery policy builds these messages once so individual connectors can stay
 * focused on provider validation and payload translation.
 */
import type { Category, ChannelKind } from "@pigeon/shared";

/** One email summary selected for a channel delivery. */
export interface DeliverySummaryItem {
  category: Category;
  summary: string;
}

/** Provider-neutral delivery message produced before connector rendering. */
export type DeliveryMessage =
  | { type: "test" }
  | ({ type: "immediate" } & DeliverySummaryItem)
  | { type: "heartbeat" }
  | {
      type: "digest";
      username: string;
      items: DeliverySummaryItem[];
      omittedCount?: number;
    }
  | { type: "empty_digest" };

/** Connector send outcome, split for durable retry handling by workers. */
export type SendResult =
  | { ok: true; providerMessageId?: string }
  | {
      ok: false;
      retryable: boolean;
      reason: string;
      /** The stored channel configuration no longer identifies a usable target. */
      channelInvalid?: boolean;
    };

/** Stable boundary implemented by every outbound channel provider. */
export interface ChannelConnector<TConfig = unknown> {
  readonly kind: ChannelKind;
  validateConfig(input: unknown): TConfig;
  sendTest(config: TConfig): Promise<SendResult>;
  send(config: TConfig, message: DeliveryMessage): Promise<SendResult>;
}
