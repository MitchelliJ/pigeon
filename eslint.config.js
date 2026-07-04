// Flat ESLint config (ESLint 9). Formatting is owned by Prettier — the
// `eslint-config-prettier` block at the end turns off every stylistic rule
// so the two tools never fight. Run: `pnpm lint` (or `pnpm lint:fix`).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import astro from "eslint-plugin-astro";
import solid from "eslint-plugin-solid";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Never lint build output or generated files.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.astro/**",
      "**/*.d.ts",
    ],
  },

  // Baseline for all JS/TS.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Backend + shared run on Node.
  {
    files: ["backend/**/*.ts", "shared/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },

  // Frontend SolidJS components run in the browser.
  {
    files: ["frontend/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { solid },
    rules: { ...solid.configs.typescript.rules },
  },

  // Astro components.
  ...astro.configs.recommended,

  // Project-wide rule tweaks.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Keep this last: disables all formatting rules (Prettier owns formatting).
  prettier,
);
