/*
 * `html-to-text`'s published package (v10.0.0) ships no bundled type
 * declarations, and `@types/html-to-text` on npm only covers up to v9.x
 * (mismatched — installing it would risk incorrect/stale types). This
 * ambient module declaration covers only the one export `pop3.ts` actually
 * imports and uses: `convert`.
 */
declare module "html-to-text" {
  export function convert(
    html: string,
    options?: Record<string, unknown>,
  ): string;
}
