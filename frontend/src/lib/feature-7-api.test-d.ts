/*
 * Compile-time contract for the one-channel Feature 7 API client.
 */
import type { Channel, ChannelKind, Digest } from "@pigeon/shared";
import { channels, deliverySettings } from "./api";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type DeliverySettings = Pick<
  Digest,
  "mode" | "digestTime" | "digestDays" | "timezone"
>;
type DeliverySettingsPatch = Partial<
  Pick<Digest, "mode" | "digestTime" | "digestDays">
>;

type ExpectedFeature7Api = {
  channels: {
    get: () => Promise<{
      channel: Channel | null;
      supportedKinds: ChannelKind[];
    }>;
    create: (input: {
      kind: "discord";
      config: { webhookUrl: string };
    }) => Promise<{ channel: Channel }>;
    test: (id: string) => Promise<{ channel: Channel }>;
    remove: (id: string) => Promise<{ ok: true }>;
  };
  deliverySettings: {
    get: () => Promise<{ settings: DeliverySettings }>;
    update: (
      patch: DeliverySettingsPatch,
    ) => Promise<{ settings: DeliverySettings }>;
  };
};

export type _Feature7ApiUsesTheSharedOneChannelContract = Assert<
  IsEqual<
    { channels: typeof channels; deliverySettings: typeof deliverySettings },
    ExpectedFeature7Api
  >
>;
