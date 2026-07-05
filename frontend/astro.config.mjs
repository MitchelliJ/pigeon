import { defineConfig } from "astro/config";
import solid from "@astrojs/solid-js";

// https://astro.build/config
export default defineConfig({
  integrations: [solid()],
  server: { port: 4321 },
  // Dev-only: forward /api/* to the backend so the browser sees everything as
  // same-origin (matches API_BASE defaulting to "" in src/lib/api.ts). Astro's
  // dev server is Vite under the hood, so proxy config lives under
  // `vite.server.proxy`, not a top-level `server.proxy`.
  vite: {
    server: {
      proxy: {
        "/api": "http://localhost:8788",
      },
    },
  },
});
