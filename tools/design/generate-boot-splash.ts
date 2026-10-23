/**
 * Writes the boot splash's colours and face into web/shell/index.html from
 * theme.css (FE-MEDIUM-349).
 *
 * WHAT: the custom properties the BrandLoader's stylesheet in index.html
 * falls back to before the design system's CSS has loaded — the console
 * ground (`--color-sd-paper`), its muted text (`--color-sd-ink-muted`), its
 * hairline (`--color-sd-rule`), the cream the brand mark stands on
 * (`--color-sd-cream`, as on the rail) and its body face (`--font-body-sd`),
 * for the light theme and the dark one — and the `theme-color` meta
 * (`--color-primary-500`).
 *
 * WHY generated: index.html paints the splash before any bundle runs, so it
 * cannot read theme.css; colours typed into it by hand were a second palette
 * that had already drifted (the old splash was sky-500 on gray-50). The
 * values are spliced between BEGIN/END GENERATED sentinels, the convention
 * of the edge page (generate-edge-theme.ts), and
 * `tests/invariants/web-brand-loader.spec.ts` regenerates and diffs, so a
 * token change that is not carried here fails the build.
 *
 * Which theme applies: the shell's resolved theme (`data-theme` on <html>)
 * once it is set, the OS scheme before that.
 *
 *   npx tsx tools/design/generate-boot-splash.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

export const INDEX_HTML_PATH = 'web/shell/index.html';
export const THEME_CSS_PATH = 'web/shared-ui/src/styles/theme.css';

export const TOKENS_BEGIN =
  '/* BEGIN GENERATED BRAND LOADER TOKENS (tools/design/generate-boot-splash.ts) */';
export const TOKENS_END = '/* END GENERATED BRAND LOADER TOKENS */';

const THEME_COLOR_META = /<meta name="theme-color" content="[^"]*" \/>/;

interface ThemeValues {
  readonly ground: string;
  readonly ink: string;
  readonly rule: string;
}

interface BootTokens {
  readonly light: ThemeValues;
  readonly dark: ThemeValues;
  /** The cream the mark stands on: the same in both themes (theme.css never re-assigns it). */
  readonly plate: string;
  readonly font: string;
  readonly themeColor: string;
}

function declared(block: string, property: string): string {
  const value = new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
  if (value === undefined) throw new Error(`theme.css declares no ${property} where expected`);
  return value;
}

/** The tokens the splash needs, from theme.css: `@theme` for light, the dark block for dark. */
export function bootTokens(themeCss: string): BootTokens {
  const start = themeCss.indexOf('@theme {');
  const theme = themeCss.slice(start, themeCss.indexOf('\n}', start));
  if (start < 0) throw new Error(`${THEME_CSS_PATH} has no @theme block`);
  // The theme-wide dark block: the top-level `[data-theme='dark'] {` that re-assigns the ground.
  const dark = [...themeCss.matchAll(/^\[data-theme='dark'\] \{([^}]*)\}/gm)]
    .map(([, body = '']) => body)
    .find((body) => body.includes('--color-sd-paper'));
  if (dark === undefined) throw new Error(`${THEME_CSS_PATH} has no dark block for the ground`);
  return {
    light: {
      ground: declared(theme, '--color-sd-paper'),
      ink: declared(theme, '--color-sd-ink-muted'),
      rule: declared(theme, '--color-sd-rule'),
    },
    dark: {
      ground: declared(dark, '--color-sd-paper'),
      ink: declared(dark, '--color-sd-ink-muted'),
      rule: declared(dark, '--color-sd-rule'),
    },
    plate: declared(theme, '--color-sd-cream'),
    font: declared(theme, '--font-body-sd'),
    themeColor: declared(theme, '--color-primary-500'),
  };
}

/** The generated block, indented as the lines of index.html's <style> are. */
export function renderTokenBlock(tokens: BootTokens, indent: string): string {
  const values = ({ ground, ink, rule }: ThemeValues): string =>
    `--brand-loader-ground: ${ground}; --brand-loader-ink: ${ink}; --brand-loader-rule: ${rule};`;
  return [
    TOKENS_BEGIN,
    `:root { ${values(tokens.light)} --brand-loader-plate: ${tokens.plate}; --brand-loader-font: ${tokens.font}; }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { ${values(tokens.dark)} } }`,
    `:root[data-theme='dark'] { ${values(tokens.dark)} }`,
    TOKENS_END,
  ].join(`\n${indent}`);
}

/** index.html with the generated block and theme colour brought up to date with theme.css. */
export function renderIndexHtml(html: string, themeCss: string): string {
  const begin = html.indexOf(TOKENS_BEGIN);
  const end = html.indexOf(TOKENS_END);
  if (begin < 0 || end < 0)
    throw new Error(`${INDEX_HTML_PATH} has no BEGIN/END GENERATED BRAND LOADER TOKENS sentinels`);
  if (!THEME_COLOR_META.test(html)) throw new Error(`${INDEX_HTML_PATH} has no theme-color meta`);
  const tokens = bootTokens(themeCss);
  const indent = /[ \t]*$/.exec(html.slice(0, begin))?.[0] ?? '';
  return (
    html.slice(0, begin) +
    renderTokenBlock(tokens, indent) +
    html.slice(end + TOKENS_END.length)
  ).replace(THEME_COLOR_META, `<meta name="theme-color" content="${tokens.themeColor}" />`);
}

function main(): void {
  const file = resolve(REPO_ROOT, INDEX_HTML_PATH);
  const html = readFileSync(file, 'utf8');
  const next = renderIndexHtml(html, readFileSync(resolve(REPO_ROOT, THEME_CSS_PATH), 'utf8'));
  if (process.argv.includes('--check')) {
    if (next !== html) {
      process.stderr.write(
        `${INDEX_HTML_PATH} is stale — run \`npx tsx tools/design/generate-boot-splash.ts\`.\n`,
      );
      process.exit(1);
    }
    process.stdout.write('Boot splash tokens are up to date.\n');
    return;
  }
  if (next !== html) writeFileSync(file, next);
  process.stdout.write(next === html ? 'Boot splash unchanged.\n' : `Wrote ${INDEX_HTML_PATH}\n`);
}

if (require.main === module) {
  main();
}
