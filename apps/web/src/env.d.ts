/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Base URL of the Pigeon API. Defaults to http://localhost:8787. */
  readonly PUBLIC_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
