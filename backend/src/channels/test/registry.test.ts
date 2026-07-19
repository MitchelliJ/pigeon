import { describe, expect, it, vi } from "vitest";
import { createChannelRegistry } from "../registry";
import type { ChannelConnector } from "../types";

function createFetchStub(): typeof fetch {
  return vi.fn() as unknown as typeof fetch;
}

function expectProviderNeutralConnector(connector: ChannelConnector): void {
  expect(Object.keys(connector).sort()).toEqual([
    "kind",
    "send",
    "sendTest",
    "validateConfig",
  ]);
}

describe("channel registry", () => {
  it("exposes Discord only through the provider-neutral registry", () => {
    const registry = createChannelRegistry({ fetch: createFetchStub() });
    const connector = registry.get("discord");

    expect(registry.supportedKinds()).toEqual(["discord"]);
    expect(connector.kind).toBe("discord");
    expect(() => registry.get("signal")).toThrow(/unsupported|unknown/i);
    expectProviderNeutralConnector(connector);
  });
});
