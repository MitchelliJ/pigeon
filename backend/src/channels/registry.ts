/**
 * Channel connector registry.
 *
 * Keeps delivery code provider-neutral by resolving supported channel kinds to
 * their connector implementations at the module boundary.
 */
import type { ChannelKind } from "@pigeon/shared";

import { createDiscordConnector } from "./discord";
import type { ChannelConnector } from "./types";

interface ChannelRegistryOptions {
  fetch: typeof fetch;
}

export interface ChannelRegistry {
  supportedKinds(): ChannelKind[];
  get(kind: string): ChannelConnector;
}

const SUPPORTED_CHANNEL_KINDS: ChannelKind[] = ["discord"];

export function createChannelRegistry({
  fetch,
}: ChannelRegistryOptions): ChannelRegistry {
  const connectors: Record<ChannelKind, ChannelConnector> = {
    discord: createDiscordConnector({ fetch }),
  };

  return {
    supportedKinds(): ChannelKind[] {
      return [...SUPPORTED_CHANNEL_KINDS];
    },

    get(kind: string): ChannelConnector {
      if (!isSupportedChannelKind(kind)) {
        throw new Error(`Unsupported channel kind: ${kind}`);
      }

      return connectors[kind];
    },
  };
}

function isSupportedChannelKind(kind: string): kind is ChannelKind {
  return SUPPORTED_CHANNEL_KINDS.includes(kind as ChannelKind);
}
