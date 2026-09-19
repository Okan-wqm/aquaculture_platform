/**
 * Platform-wide invariant — FE-MEDIUM-093:
 *
 * The edge gateway paints from the same design tokens as the product.
 *
 * # Why
 *
 * `sens-api-gateway/static/scada-edge.html` is the SCADA panel an operator
 * stands in front of on the farm. It carried 177 colour literals of its own —
 * Tailwind slate, green, yellow and orange written out by hand — so the panel
 * drifted from the web application it mirrors, and a token change never
 * reached it. It is a Rust binary's `include_str!` asset served to a device
 * that is usually offline, so it can neither import the TypeScript token
 * module nor fetch a second stylesheet: the service worker precaches
 * all-or-nothing, and a missed entry costs the offline guarantee.
 *
 * So `tools/design/generate-edge-theme.ts` splices the tokens into the page's
 * own `<style>` block and into `sens-api-gateway/src/theme_tokens.rs`, between
 * BEGIN/END GENERATED sentinels — the convention
 * `infrastructure/docker/nats/nats.conf` already uses. This guard regenerates
 * and diffs, so a hand-edited block or a stale palette fails the build, and it
 * holds the page at zero colour literals of its own.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { colors } from '../../libs/shared-contracts/src/design/color-tokens';
import {
  HTML_PATH,
  RUST_PATH,
  renderCssBlock,
  renderRustModule,
  spliceCssBlock,
} from '../../tools/design/generate-edge-theme';

const REPO_ROOT = resolve(__dirname, '..', '..');

const GENERATED_END = '/* END GENERATED TOKENS */';

/** Every CSS spelling of a hex colour, the same reading as the web ratchet. */
const RAW_HEX = /(?<![\w&#$])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

/** An `rgba()` written out by hand. Black is not a palette colour and is allowed. */
const RGBA_LITERAL = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*[0-9.]+\s*\)/g;

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('INVARIANT (FE-MEDIUM-093): the edge gateway paints from the design tokens', () => {
  it("the page's generated block matches the tokens", () => {
    const html = read(HTML_PATH);

    expect(spliceCssBlock(html, renderCssBlock())).toBe(html);
  });

  it('the Rust token module matches the tokens', () => {
    expect(read(RUST_PATH)).toBe(renderRustModule());
  });

  it('the page writes no colour literal of its own', () => {
    const html = read(HTML_PATH);
    const body = html.slice(html.indexOf(GENERATED_END) + GENERATED_END.length);
    const hexes = body.match(RAW_HEX) ?? [];

    if (hexes.length > 0) {
      throw new Error(
        `scada-edge.html carries ${hexes.length} colour literal(s) outside the\n` +
          `generated block, so the panel drifts from the product the moment a\n` +
          `token changes. Use \`var(--color-<scale>-<step>)\` in the stylesheet\n` +
          `and \`token('color-<scale>-<step>')\` in the script — an SVG\n` +
          `presentation attribute cannot resolve a var(). Found: ` +
          `${[...new Set(hexes)].join(', ')}`,
      );
    }
  });

  it('the page writes no palette colour as a hand-written rgba()', () => {
    const html = read(HTML_PATH);
    const body = html.slice(html.indexOf(GENERATED_END) + GENERATED_END.length);

    const offenders = [...body.matchAll(RGBA_LITERAL)]
      .map((m) => `${m[1]},${m[2]},${m[3]}`)
      .filter((triplet) => triplet !== '0,0,0');

    if (offenders.length > 0) {
      throw new Error(
        `A tint written as rgba() stops at the value it was typed with. Use\n` +
          `\`rgb(var(--rgb-<scale>-<step>) / <alpha>)\` so it follows the token.\n` +
          `Found: ${[...new Set(offenders)].join(' | ')}`,
      );
    }
  });

  it('the theme-color meta, which cannot read a custom property, holds the token', () => {
    const html = read(HTML_PATH);
    const meta = html.match(/<meta name="theme-color" content="(#[0-9a-fA-F]{3,8})">/);

    // A meta attribute is not a declaration, so this one value stays a literal;
    // it is the panel's browser-chrome colour and must be the app surface.
    expect(meta?.[1]).toBe(colors.neutral[900]);
  });

  it('the gateway source writes no colour literal', () => {
    const server = read('sens-api-gateway/src/scada_server.rs');

    expect(server.match(RAW_HEX) ?? []).toEqual([]);
    expect(server).toContain('theme_tokens::NEUTRAL_900');
  });

  it('the generated block is what the page resolves its tokens from', () => {
    const html = read(HTML_PATH);

    // The script-side reader and the stylesheet both depend on the block being
    // a `:root` declaration; a refactor that moved it would leave every
    // `var()` unresolved and every `token()` empty.
    expect(renderCssBlock()).toContain(':root {');
    expect(html).toContain("getPropertyValue('--' + name)");
    expect(html).toContain('var(--color-neutral-900)');
  });
});
