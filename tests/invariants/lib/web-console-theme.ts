/**
 * The tenant console's colour model, read from the two stylesheets that build
 * it (FE-HIGH-321).
 *
 * theme.css owns every colour value: the `@theme` palette, and the
 * re-assignments of the `--color-sd-*` tokens per theme (`data-theme`) and
 * per workspace (`data-ws`). suderra.css owns the console scope, which points
 * Tailwind's scales (gray, primary, success, warning, accent, error, info,
 * white) at those tokens inside the console. What a utility such as
 * `bg-primary-700` paints in the console is therefore a walk through both
 * files; this module is the one model of that walk:
 *
 *   - `cascade(path)` — the value a custom property takes on an element, by
 *     the cascade theme.css builds (specificity, source order, inheritance);
 *   - `page` / `placements` — where the theme and workspace attributes sit;
 *   - `consoleColour(utility, theme, ws)` — the hex a colour utility paints
 *     inside the console scope.
 *
 * Shared by web-theme-token-parity.spec.ts (the tokens' own contrast) and
 * web-console-series-contrast.spec.ts (data series painted from the scope).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const THEME_CSS = 'web/shared-ui/src/styles/theme.css';
export const SUDERRA_CSS = 'web/shared-ui/src/styles/suderra.css';

export const THEME_SOURCE = readFileSync(resolve(REPO_ROOT, THEME_CSS), 'utf8');
export const SUDERRA_SOURCE = readFileSync(resolve(REPO_ROOT, SUDERRA_CSS), 'utf8');

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];
/** The console's workspaces (README §6). The shell sets `data-ws` for each one, aqua included
 *  (useFollowedWorkspace); aqua's accent is the theme default, its ground is its own block. */
export const WORKSPACES: readonly string[] = ['aqua', 'gh', 'ctl', 'org'];

/** The `@theme { … }` block alone — a `[data-theme='dark']` override further down
 *  re-assigns a token per theme and is not a second definition of it. */
export function themeBlock(): string {
  const start = THEME_SOURCE.indexOf('@theme {');
  const end = THEME_SOURCE.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error(`${THEME_CSS} has no @theme block`);
  return THEME_SOURCE.slice(start, end);
}

// ── WCAG arithmetic ──────────────────────────────────────────────────────────

export function hexToRgb(hex: string): [number, number, number] {
  const channel = (offset: number): number => parseInt(hex.slice(offset, offset + 2), 16);
  return [channel(1), channel(3), channel(5)];
}

/** WCAG 2 relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const linear = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio of two colours, order-free (1 … 21). */
export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** OKLCH lightness, chroma and hue (degrees) of a `#rrggbb` colour — how far a tint leans and
 *  which way (Björn Ottosson's OKLab, the space theme.css's comments give their values in). */
export function oklch(hex: string): { l: number; c: number; h: number } {
  const linear = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [sr, sg, sb] = hexToRgb(hex);
  const [r, g, b] = [linear(sr), linear(sg), linear(sb)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    c: Math.hypot(a, bb),
    h: hue < 0 ? hue + 360 : hue,
  };
}

/** `fg` drawn at `alpha` over `bg` — a tinted surface such as a chat bubble. */
export function over(fg: string, alpha: number, bg: string): string {
  const f = hexToRgb(fg);
  const g = hexToRgb(bg);
  return `#${f
    .map((value, i) => Math.round(alpha * value + (1 - alpha) * (g[i] ?? 0)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

// ── theme.css cascade ────────────────────────────────────────────────────────

/** An element's attributes, as far as theme.css selects on them (`data-theme`, `data-ws`). */
export type Attrs = Readonly<Record<string, string>>;
/** One compound selector: its `[attr='value']` parts (`:root` as the pair [':root', '']). */
type Compound = ReadonlyArray<readonly [string, string]>;
/** A top-level theme.css rule keyed on attributes or `:root`: each selector is its
 *  compounds, ancestor first (descendant combinators only). Kept in source order. */
interface AttrRule {
  readonly selectors: ReadonlyArray<readonly Compound[]>;
  readonly body: string;
}
const ATTR_RULES: readonly AttrRule[] = [
  ...THEME_SOURCE.matchAll(/^((?:\[data-|:root)[^{]*)\{([^}]*)\}/gm),
].map(([, list = '', body = '']) => ({
  body,
  selectors: list.split(',').map((selector) =>
    selector
      .trim()
      .split(/\s+/)
      .map((compound): Compound => {
        if (compound === ':root') return [[':root', '']];
        const parts = [...compound.matchAll(/\[([a-z-]+)='([^']*)'\]/g)].map(
          ([, attr = '', value = '']) => [attr, value] as const,
        );
        // A selector shape this model does not read must fail here, not resolve wrongly.
        if (parts.map(([attr, value]) => `[${attr}='${value}']`).join('') !== compound)
          throw new Error(`theme.css selector the cascade model cannot read: ${selector.trim()}`);
        return parts;
      }),
  ),
}));

function compoundMatches(compound: Compound, path: readonly Attrs[], index: number): boolean {
  return compound.every(([attr, value]) =>
    attr === ':root' ? index === 0 : path[index]?.[attr] === value,
  );
}
function selectorMatches(
  selector: readonly Compound[],
  path: readonly Attrs[],
  index: number,
): boolean {
  const subject = selector[selector.length - 1];
  if (subject === undefined || !compoundMatches(subject, path, index)) return false;
  let at = index;
  for (let k = selector.length - 2; k >= 0; k -= 1) {
    const compound = selector[k];
    if (compound === undefined) return false;
    let found = -1;
    for (let j = at - 1; j >= 0 && found < 0; j -= 1)
      if (compoundMatches(compound, path, j)) found = j;
    if (found < 0) return false;
    at = found;
  }
  return true;
}

/** The value `property` is declared with in one rule body, if it is. */
export function declared(block: string, property: string): string | undefined {
  return new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim().toLowerCase();
}

/** The value a custom property takes on the last element of `path` (<html> first), by the
 *  cascade theme.css builds: on each element the most specific, then the latest, matching
 *  rule that declares it; else the parent's value; past <html>, the `@theme` value (the
 *  theme layer, under every rule above). Undefined when nothing declares it. */
export function cascade(path: readonly Attrs[]): (property: string) => string | undefined {
  return (property) => {
    for (let index = path.length - 1; index >= 0; index -= 1) {
      let best: { weight: number; order: number; value: string } | undefined;
      ATTR_RULES.forEach((rule, order) => {
        const value = declared(rule.body, property);
        if (value === undefined) return;
        for (const selector of rule.selectors) {
          if (!selectorMatches(selector, path, index)) continue;
          const weight = selector.reduce((sum, compound) => sum + compound.length, 0);
          if (
            best === undefined ||
            weight > best.weight ||
            (weight === best.weight && order > best.order)
          )
            best = { weight, order, value };
        }
      });
      if (best !== undefined) return best.value;
    }
    return declared(themeBlock(), property);
  };
}

const DARK: Attrs = { 'data-theme': 'dark' };
// Every workspace, aqua included, as the shell writes it (FE-MEDIUM-348): modelling aqua as
// the absence of the attribute measured a page nobody sees once aqua has a block of its own.
const wsAttrs = (ws: string): Attrs => ({ 'data-ws': ws });

/** The page: the theme on <html>, the workspace on <body>, a console element under them. */
export function page(theme: Theme, ws: string): Attrs[] {
  return [theme === 'dark' ? DARK : {}, wsAttrs(ws), {}];
}

/** A page with no workspace — the SUPER_ADMIN console and the auth pages, where the console
 *  shell (and with it `data-ws`) is not mounted. */
export function bare(theme: Theme): Attrs[] {
  return [theme === 'dark' ? DARK : {}, {}, {}];
}

/** Every other placement of the same theme and workspace — the attributes on one element,
 *  and a surface that pins the dark theme on itself (a `theme="dark"` Modal or Drawer, the
 *  SCADA operator view) on a light or a dark page — with the island and a child of it. */
export function placements(theme: Theme, ws: string): Array<[string, Attrs[]]> {
  const rows: Array<[string, Attrs[]]> = [
    [
      'theme and workspace on <html>',
      [{ ...(theme === 'dark' ? DARK : {}), ...wsAttrs(ws) }, {}, {}],
    ],
  ];
  if (theme === 'light') return rows;
  const islands: Array<[string, Attrs[]]> = [
    ['a dark island on a light page', [{}, wsAttrs(ws), DARK]],
    ['a dark island on a dark page', [DARK, wsAttrs(ws), DARK]],
    ['a dark island, the workspace on <html>', [wsAttrs(ws), {}, DARK]],
  ];
  for (const [where, path] of islands)
    rows.push([where, path], [`${where}, a child of it`, [...path, {}]]);
  return rows;
}

/** The hex `--color-<name>` takes in a placement. */
export function resolver(path: readonly Attrs[]): (name: string) => string {
  const at = cascade(path);
  return (name) => {
    const value = at(`--color-${name}`);
    if (value === undefined || !/^#[0-9a-f]{6}$/.test(value))
      throw new Error(`--color-${name} has no hex value here: ${String(value)}`);
    return value;
  };
}

// ── suderra.css console scope ────────────────────────────────────────────────

/** The scope roots (suderra.css): the console's classes, and every dialog while the
 *  console is on screen — Modal, ConfirmModal and Drawer portal out of the column. */
const SCOPE =
  ".sd-page, .sd-surface, .sd-content, body:has(.sd-content) :is([role='dialog'], [role='alertdialog'])";
const normalize = (selector: string): string =>
  selector.replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
const SUDERRA_RULES = [
  ...SUDERRA_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map(([, selector = '', body = '']): [string, string] => [normalize(selector), body]);

/** The body of the suderra.css rule whose selector list is `selector`. */
export function suderraRule(selector: string): string {
  const body = SUDERRA_RULES.find(([list]) => list === normalize(selector))?.[1];
  if (body === undefined) throw new Error(`suderra.css has no rule \`${selector}\``);
  return body;
}

/** The workspace motif behind the tenant console (FE-MEDIUM-348): the workspaces suderra.css
 *  draws one for — a `[data-ws='…'] .sd-content::after` rule masking with `var(--sd-motif-…)` —
 *  and the data URI that property holds on the motif layer (`.sd-content::after`). */
export function workspaceMotifs(): Map<string, string> {
  const layer = suderraRule('.sd-content::after');
  const motifs = new Map<string, string>();
  for (const [selector, body] of SUDERRA_RULES) {
    const ws = /^\[data-ws='([a-z]+)'\] \.sd-content::after$/.exec(selector)?.[1];
    const property = /mask-image:\s*var\((--[a-z0-9-]+)\)/.exec(body)?.[1];
    if (ws === undefined || property === undefined) continue;
    const uri = new RegExp(`(?:^|[\\s;])${property}:\\s*url\\("([^"]+)"\\)`).exec(layer)?.[1];
    if (uri === undefined)
      throw new Error(
        `suderra.css masks [data-ws='${ws}'] with ${property}, which the layer lacks`,
      );
    motifs.set(ws, uri);
  }
  return motifs;
}

/** The scope's re-assignments, both themes. */
export const SCOPE_RULE = suderraRule(`:where(${SCOPE})`);
/** Its dark-theme re-assignments: dark above a scope root, on one (a dialog pinned dark),
 *  or inside one (a dark island). */
export const DARK_SCOPE_RULE = suderraRule(
  `[data-theme='dark'] :where(${SCOPE}), [data-theme='dark']:where(${SCOPE}), :where(${SCOPE}) [data-theme='dark']`,
);

const COLOUR_UTILITY =
  /^(?:bg|text|border|fill|stroke|ring|outline|divide|decoration)-([a-z]+(?:-\d+)?)(?:\/(\d+))?$/;

/**
 * The hex a colour utility (`bg-primary-700`, `text-white`, `bg-gray-900/20`)
 * paints inside the console scope, in a theme and workspace. A utility whose
 * scale the scope does not re-assign (a Tailwind hue, `secondary`) throws: no
 * console theme reaches it. A translucent one is composited over `ground`.
 */
export function consoleColour(utility: string, theme: Theme, ws: string, ground?: string): string {
  const match = COLOUR_UTILITY.exec(utility);
  if (match?.[1] === undefined) throw new Error(`not a colour utility: ${utility}`);
  const property = `--color-${match[1]}`;
  const assigned =
    (theme === 'dark' ? declared(DARK_SCOPE_RULE, property) : undefined) ??
    declared(SCOPE_RULE, property);
  const token = /^var\(--color-([a-z0-9-]+)\)$/.exec(assigned ?? '')?.[1];
  if (token === undefined)
    throw new Error(`${utility}: the console scope does not re-assign ${property}`);
  const hex = resolver(page(theme, ws))(token);
  if (match[2] === undefined) return hex;
  if (ground === undefined) throw new Error(`${utility} is translucent: name the ground under it`);
  return over(hex, Number(match[2]) / 100, ground);
}

/**
 * The utility a class list applies in one theme for one property prefix
 * (`bg`, `text`): in the dark theme its `dark:` variant when it has one, else
 * the plain utility. Other variants (`hover:`, `md:`) are not the resting paint
 * and are skipped.
 */
export function utilityFor(classes: string, prefix: string, theme: Theme): string {
  const tokens = classes.split(/\s+/).filter(Boolean);
  const plain = tokens.find((token) => token.startsWith(`${prefix}-`));
  const darkVariant = tokens
    .filter((token) => token.startsWith(`dark:${prefix}-`))
    .map((token) => token.slice('dark:'.length))[0];
  const chosen = theme === 'dark' ? (darkVariant ?? plain) : plain;
  if (chosen === undefined) throw new Error(`no ${prefix}-* utility in "${classes}"`);
  return chosen;
}
