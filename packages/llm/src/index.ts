import type { Config, Logger } from "@pigeon/config";
import { createMistralProvider } from "./mistral.js";
import { createMockProvider } from "./mock.js";
import type { LlmProvider } from "./types.js";

export * from "./types.js";
export { createMistralProvider, MistralError, type MistralOptions } from "./mistral.js";
export { createMockProvider } from "./mock.js";

/** Mistral when configured, deterministic mock otherwise. */
export function pickLlmProvider(config: Config, logger?: Logger): LlmProvider {
  if (config.MISTRAL_API_KEY) {
    return createMistralProvider({
      apiKey: config.MISTRAL_API_KEY,
      model: config.MISTRAL_MODEL,
      baseUrl: config.MISTRAL_BASE_URL,
    });
  }
  logger?.warn("MISTRAL_API_KEY not set — using the mock triage provider");
  return createMockProvider();
}
