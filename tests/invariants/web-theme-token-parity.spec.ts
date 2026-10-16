/**
 * INVARIANT (FE-HIGH-066): the TypeScript colour tokens mirror theme.css.
 *
 * ## Two records of one palette
 *
 * `web/shared-ui/src/styles/theme.css` is the design system's single source
 * of truth for colour: shell and every federated remote import it, and every
 * `bg-primary-*` / `text-error-*` utility resolves from its `@theme` block.
 * CSS classes cannot reach everywhere, though — chart libraries take stroke
 * and fill as strings, gauges draw on SVG, and a default role colour has to be
 * a value. Those places need the same palette as TypeScript, which is what
 * `colors` in `web/shared-ui/src/styles/theme.ts` is for.
 *
 * Before this gate, `theme.ts` carried a *different* palette (an Ant-Design
 * blue as "brand", a different grey scale) that nothing consumed, while every
 * chart wrote raw hex instead — 2 136 occurrences outside theme.css. A second
 * palette that can drift is worse than none: a chart that "uses the tokens"
 * would silently render the wrong brand.
 *
 * ## The rule
 *
 * Every `--color-<scale>-<step>` token in theme.css exists in `colors` with
 * the same value, and every scale/step in `colors` exists in theme.css — so
 * the raw-hex ratchet (`web-design-system-ratchet.spec.ts`) can send chart
 * colours to `colors` knowing they ARE the theme.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { colors } from '../../web/shared-ui/src/styles/theme';

const REPO_ROOT = resolve(__dirname, '../..');
const THEME_CSS = 'web/shared-ui/src/styles/theme.css';

const TOKEN = /--color-([a-z]+)-(\d+):\s*(#[0-9a-fA-F]{6})\s*;/g;

const THEME_SOURCE = readFileSync(resolve(REPO_ROOT, THEME_CSS), 'utf8');

/** The `@theme { … }` block alone — a `[data-theme='dark']` override further down
 *  re-assigns a token per theme and is not a second definition of it. */
function themeBlock(): string {
  const start = THEME_SOURCE.indexOf('@theme {');
  const end = THEME_SOURCE.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error(`${THEME_CSS} has no @theme block`);
  return THEME_SOURCE.slice(start, end);
}

function cssTokens(): Map<string, string> {
  const css = themeBlock();
  const tokens = new Map<string, string>();
  for (const [, scale, step, value] of css.matchAll(TOKEN)) {
    if (scale === undefined || step === undefined || value === undefined) continue;
    tokens.set(`${scale}-${step}`, value.toLowerCase());
  }
  return tokens;
}

function tsTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [scale, steps] of Object.entries(colors)) {
    if (typeof steps === 'string') continue; // white / black / transparent
    const scaleSteps: Readonly<Record<number, string>> = steps;
    for (const [step, value] of Object.entries(scaleSteps)) {
      tokens.set(`${scale}-${step}`, value.toLowerCase());
    }
  }
  return tokens;
}

describe('INVARIANT (FE-HIGH-066): TypeScript colour tokens mirror theme.css', () => {
  const css = cssTokens();
  const ts = tsTokens();

  it('reads the theme', () => {
    // A regex or path slip would otherwise make the comparisons vacuous.
    expect(css.size).toBeGreaterThan(50);
    expect(css.get('primary-500')).toBe('#0073e6');
  });

  it('every theme.css colour token exists in `colors` with the same value', () => {
    const drift = [...css]
      .filter(([name, value]) => ts.get(name) !== value)
      .map(([name, value]) => `${name}: css ${value} vs ts ${ts.get(name) ?? '(missing)'}`);
    expect(drift).toEqual([]);
  });

  it('`colors` declares nothing theme.css does not have', () => {
    const orphans = [...ts.keys()].filter((name) => !css.has(name)).sort();
    expect(orphans).toEqual([]);
  });

  it('no CSS entry under web/ opens a second @theme — theme.css is the only token source', () => {
    // tenant-admin and messaging-module used to carry a private @theme (Tailwind's
    // green and slate scales under the names tenant-* and dark-*): a fourth visual
    // language, invisible to `colors` and to this parity check. A package that
    // needs a scale uses the design system's; a new scale is added to theme.css.
    const entries = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', '--', 'web/*.css', 'web/**/*.css'],
      {
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter((file) => file && !file.includes('/node_modules/') && file !== THEME_CSS);
    expect(entries.length).toBeGreaterThan(5);
    const offenders = entries.filter((file) =>
      /@theme\b/.test(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * INVARIANT (FE-HIGH-073): a colour utility names a scale and a step that some
 * palette defines.
 *
 * Tailwind emits nothing for `bg-tenant-600` once the `tenant-*` scale is gone,
 * for `bg-gray-850` (no such step), or for `!bg-aqua-500` (a scale AquaMobil's
 * config never had) — the class stays in the markup, the element paints with
 * whatever is behind it, and no compiler, lint or test says a word. The dead
 * classes this gate was written against: six `tenant-*` in the shell after the
 * private palette was retired, nine `gray-750/850` in the SCADA editors, three
 * `gray-150`, two `*-25` in the delete dialog, one `aqua-500` on the mobile
 * sync page.
 *
 * Allowed = Tailwind's default palette (every step) ∪ the scales in theme.css
 * (their steps) for the Tailwind-4 packages; AquaMobil, on Tailwind 3 with its
 * own config, is checked against that config's scales instead.
 */
describe('INVARIANT (FE-HIGH-073): colour utilities only name scales and steps a palette defines', () => {
  const TAILWIND_PALETTE = new Set([
    'slate',
    'gray',
    'zinc',
    'neutral',
    'stone',
    'red',
    'orange',
    'amber',
    'yellow',
    'lime',
    'green',
    'emerald',
    'teal',
    'cyan',
    'sky',
    'blue',
    'indigo',
    'violet',
    'purple',
    'fuchsia',
    'pink',
    'rose',
  ]);
  const TAILWIND_STEPS = new Set([
    '50',
    '100',
    '200',
    '300',
    '400',
    '500',
    '600',
    '700',
    '800',
    '900',
    '950',
  ]);
  /** `<prefix>-<word>-<digits>` shapes that are not colours: opacity, spacing, gradient angles, sides. */
  const NOT_A_COLOUR = new Set([
    'opacity',
    'spacing',
    'offset',
    'linear',
    'radial',
    'conic',
    'inset',
    't',
    'r',
    'b',
    'l',
    'x',
    'y',
    's',
    'e',
    'tl',
    'tr',
    'br',
    'bl',
    'ss',
    'se',
    'es',
    'ee',
  ]);
  const COLOUR_UTILITY =
    /(?<![\w-])(?:[a-z-]+:)*!?(?:bg|text|border|ring|divide|from|to|via|placeholder|outline|shadow|fill|stroke|accent|caret|decoration|ring-offset|border-[trblxyse]|border-[st][se])-([a-z]+)-(\d+)(?:\/\d+)?(?![\w-])/g;
  const MOBILE_CONFIG = 'web/apps/aquamobil/tailwind.config.js';

  function scaleSteps(source: string, tokenPattern: RegExp): Map<string, Set<string>> {
    const steps = new Map<string, Set<string>>();
    for (const [, scale, step] of source.matchAll(tokenPattern)) {
      if (scale === undefined || step === undefined) continue;
      if (!steps.has(scale)) steps.set(scale, new Set());
      steps.get(scale)?.add(step);
    }
    return steps;
  }

  function mobileScaleSteps(): Map<string, Set<string>> {
    const config = readFileSync(resolve(REPO_ROOT, MOBILE_CONFIG), 'utf8');
    const steps = new Map<string, Set<string>>();
    for (const block of config.matchAll(/^ {8}([a-z]+): \{([\s\S]*?)^ {8}\}/gm)) {
      const [, scale, body] = block;
      if (scale === undefined || body === undefined) continue;
      steps.set(scale, new Set([...body.matchAll(/^\s+(\d+):/gm)].map(([, step]) => step ?? '')));
    }
    return steps;
  }

  const webSteps = scaleSteps(themeBlock(), /--color-([a-z]+)-(\d+):/g);
  const mobileSteps = mobileScaleSteps();

  it('reads both palettes', () => {
    expect(webSteps.get('primary')?.size).toBe(10);
    // AquaMobil v4 paints only from its token scales (tokens.css → tailwind.config.js):
    // the stepped ones are the surfaces and the ink ramp. Its legacy ocean/sea/coral
    // palettes are deleted and banned by its own design-token invariant.
    expect(mobileSteps.get('surface')?.has('1')).toBe(true);
    expect(mobileSteps.get('ink')?.has('3')).toBe(true);
  });

  it('no source file under web/ uses a colour utility that would compile to nothing', () => {
    const files = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', '--', 'web/*.ts', 'web/**/*.ts', 'web/*.tsx', 'web/**/*.tsx'],
      {
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter(
        (file) =>
          file &&
          !file.includes('/node_modules/') &&
          !file.includes('__tests__') &&
          !/\.(spec|test|d)\.tsx?$/.test(file),
      );
    expect(files.length).toBeGreaterThan(500);
    const dead: string[] = [];
    for (const file of files) {
      const palette = file.startsWith('web/apps/aquamobil/') ? mobileSteps : webSteps;
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      for (const [utility, scale, step] of source.matchAll(COLOUR_UTILITY)) {
        if (scale === undefined || step === undefined || NOT_A_COLOUR.has(scale)) continue;
        const known =
          (TAILWIND_PALETTE.has(scale) && TAILWIND_STEPS.has(step)) ||
          (palette.get(scale)?.has(step) ?? false);
        if (!known) dead.push(`${file}: ${utility}`);
      }
    }
    expect(dead).toEqual([]);
  });
});

/**
 * INVARIANT (FE-HIGH-074): the muted-text token reads on both themes.
 *
 * FE-MEDIUM-024 darkened `--color-gray-400` to pass AA on white; utilities
 * resolve the variable at paint time, so every `dark:text-gray-400` inherited
 * the darkened value too — 3.7:1 on gray-900, 3.0:1 on gray-800 — and the fix
 * for light surfaces became the failure on dark ones. theme.css now assigns
 * the token per theme; this gate holds both assignments to 4.5:1 so neither
 * can drift back.
 */
describe('INVARIANT (FE-HIGH-074): `--color-gray-400` passes WCAG AA on both themes', () => {
  const WHITE = '#ffffff';
  /** Tailwind v4's gray-800 (oklch(27.8% 0.033 256.848)) in sRGB — the lighter of the two dark surfaces. */
  const DARK_SURFACE = '#1e2939';

  function luminance(hex: string): number {
    const channel = (offset: number): number => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  }
  function contrast(foreground: string, background: string): number {
    const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
  }
  function tokenIn(block: string): string {
    const match = /--color-gray-400:\s*(#[0-9a-fA-F]{6})\s*;/.exec(block);
    if (match?.[1] === undefined)
      throw new Error('theme.css does not assign --color-gray-400 here');
    return match[1];
  }

  it('the light assignment reads on white', () => {
    expect(contrast(tokenIn(themeBlock()), WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it("the [data-theme='dark'] assignment reads on gray-800", () => {
    const override = /\[data-theme='dark'\]\s*\{[^}]*\}/.exec(THEME_SOURCE)?.[0];
    if (override === undefined)
      throw new Error("theme.css has no [data-theme='dark'] override block");
    expect(contrast(tokenIn(override), DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * INVARIANT (FE-HIGH-321): the Suderra scope paints only from theme.css, and
 * the contrast it relies on holds in both themes.
 *
 * `sd-content` / `sd-page` / `sd-surface` and, while the console is on screen,
 * every dialog (web/shared-ui/src/styles/suderra.css) re-assign the gray,
 * primary and semantic scales inside the tenant console.
 * The values live in theme.css as `--color-sd-*` tokens; suderra.css may only
 * reference them, so theme.css stays the one owner of every colour value and
 * this file is the one place their contrast is measured. Review of 5435f85ba
 * found a hint token at 2.7:1 on parchment carrying the dialog close icon and
 * chat timestamps.
 *
 * The Industry re-skin (Tenant Console — Industrial, Phase 1) added the
 * theme-flipping semantic ramps (`sd-accent-*`, `sd-neutral-*`), the hazard
 * tokens (`sd-hz-*`) and one accent block per workspace (`[data-ws]`). Every
 * text token is held to 4.5:1 and every icon token to 3:1 on the grounds it
 * is drawn on, under both themes and in every workspace — a workspace block
 * that forgot to re-assign a theme-flipping token would shadow the dark value
 * on <body>. The values come from a model of theme.css's own cascade
 * (`cascade()` below: specificity, source order, inheritance), and every
 * placement of the attributes — the theme on <html>, on the workspace
 * element, or pinned on a dark island inside it — must resolve to the same
 * values as the page.
 */
describe('INVARIANT (FE-HIGH-321): Suderra scope — tokens only, AA in both themes', () => {
  const SUDERRA_CSS = 'web/shared-ui/src/styles/suderra.css';
  const suderra = readFileSync(resolve(REPO_ROOT, SUDERRA_CSS), 'utf8');
  const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
  const TEXT = 4.5;
  const ICON = 3;
  const WORKSPACES = ['aqua', 'gh', 'ctl', 'org'];

  function hexToRgb(hex: string): [number, number, number] {
    return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as [
      number,
      number,
      number,
    ];
  }
  function luminance(hex: string): number {
    const [r, g, b] = hexToRgb(hex).map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  }
  /** `fg` drawn at `alpha` over `bg` — a tinted surface such as a chat bubble. */
  function over(fg: string, alpha: number, bg: string): string {
    const f = hexToRgb(fg);
    const g = hexToRgb(bg);
    return `#${f
      .map((value, i) => Math.round(alpha * value + (1 - alpha) * (g[i] ?? 0)))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')}`;
  }
  function hexIn(block: string, name: string): string | undefined {
    return new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block)?.[1]?.toLowerCase();
  }
  function tokenIn(block: string, name: string): string {
    const value = hexIn(block, name);
    if (value === undefined) throw new Error(`no hex --color-${name} in the block`);
    return value;
  }
  const light = (name: string): string => tokenIn(themeBlock(), name);
  const darkBlock = (() => {
    const blocks = THEME_SOURCE.match(/\[data-theme='dark'\]\s*\{[^}]*\}/g) ?? [];
    const sd = blocks.find((block) => block.includes('--color-sd-paper'));
    if (sd === undefined) throw new Error("theme.css has no [data-theme='dark'] block for sd-*");
    return sd;
  })();
  const dark = (name: string): string => tokenIn(darkBlock, name);

  /** An element's attributes, as far as theme.css selects on them (`data-theme`, `data-ws`). */
  type Attrs = Readonly<Record<string, string>>;
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
  function declared(block: string, property: string): string | undefined {
    return new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]+);`)
      .exec(block)?.[1]
      ?.trim()
      .toLowerCase();
  }
  /** The value a custom property takes on the last element of `path` (<html> first), by the
   *  cascade theme.css builds: on each element the most specific, then the latest, matching
   *  rule that declares it; else the parent's value; past <html>, the `@theme` value (the
   *  theme layer, under every rule above). Undefined when nothing declares it. */
  function cascade(path: readonly Attrs[]): (property: string) => string | undefined {
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
  const wsAttrs = (ws: string): Attrs => (ws === 'aqua' ? {} : { 'data-ws': ws });
  /** The page: the theme on <html>, the workspace on <body>, a console element under them. */
  function page(theme: 'light' | 'dark', ws: string): Attrs[] {
    return [theme === 'dark' ? DARK : {}, wsAttrs(ws), {}];
  }
  /** Every other placement of the same theme and workspace — the attributes on one element,
   *  and a surface that pins the dark theme on itself (a `theme="dark"` Modal or Drawer, the
   *  SCADA operator view) on a light or a dark page — with the island and a child of it. */
  function placements(theme: 'light' | 'dark', ws: string): Array<[string, Attrs[]]> {
    const rows: Array<[string, Attrs[]]> = [
      [
        'theme and workspace on <html>',
        [{ ...(theme === 'dark' ? DARK : {}), ...wsAttrs(ws) }, {}, {}],
      ],
    ];
    if (theme === 'light') return rows;
    for (const [where, path] of [
      ['a dark island on a light page', [{}, wsAttrs(ws), DARK]],
      ['a dark island on a dark page', [DARK, wsAttrs(ws), DARK]],
      ['a dark island, the workspace on <html>', [wsAttrs(ws), {}, DARK]],
    ] as Array<[string, Attrs[]]>)
      rows.push([where, path], [`${where}, a child of it`, [...path, {}]]);
    return rows;
  }
  /** The hex `--color-<name>` takes in a placement. */
  function resolver(path: readonly Attrs[]): (name: string) => string {
    const at = cascade(path);
    return (name) => {
      const value = at(`--color-${name}`);
      if (value === undefined || !/^#[0-9a-f]{6}$/.test(value))
        throw new Error(`--color-${name} has no hex value here: ${String(value)}`);
      return value;
    };
  }
  /** Every console property theme.css declares — the tokens a placement must agree on. */
  const SD_PROPERTIES = [
    ...new Set(
      [...THEME_SOURCE.matchAll(/(--(?:color|shadow)-sd-[a-z0-9-]+)\s*:/g)].map(([, p = '']) => p),
    ),
  ];

  /** Pairs below `min`, as readable rows — an empty list is the pass. */
  function below(rows: ReadonlyArray<[string, string, string]>, min: number): string[] {
    return rows
      .filter(([, fg, bg]) => contrast(fg, bg) < min)
      .map(([label, fg, bg]) => `${label}: ${fg} on ${bg} = ${contrast(fg, bg).toFixed(2)}`);
  }

  /** The scope roots (suderra.css): the console's classes, and every dialog while the
   *  console is on screen — Modal, ConfirmModal and Drawer portal out of the column. */
  const SCOPE =
    ".sd-page, .sd-surface, .sd-content, body:has(.sd-content) :is([role='dialog'], [role='alertdialog'])";
  const normalize = (selector: string): string =>
    selector.replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
  const SUDERRA_RULES = [
    ...suderra.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map(([, selector = '', body = '']): [string, string] => [normalize(selector), body]);
  function suderraRule(selector: string): string {
    const body = SUDERRA_RULES.find(([list]) => list === normalize(selector))?.[1];
    if (body === undefined) throw new Error(`suderra.css has no rule \`${selector}\``);
    return body;
  }
  const scope = suderraRule(`:where(${SCOPE})`);
  // Dark above a scope root, on one (a dialog pinned dark), or inside one (a dark island).
  const darkScope = suderraRule(
    `[data-theme='dark'] :where(${SCOPE}), [data-theme='dark']:where(${SCOPE}), :where(${SCOPE}) [data-theme='dark']`,
  );

  it('suderra.css holds no colour value of its own', () => {
    const code = suderra.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/g) ?? []).toEqual([]);
  });

  it('the scope re-assigns every step of each scale to its theme.css ramp', () => {
    // Success and info follow gray: "good" is not a colour in Industry (README §7.8).
    const ramps: Record<string, string> = {
      gray: 'sd-ink',
      primary: 'sd-teal',
      success: 'sd-ink',
      warning: 'sd-amber',
      error: 'sd-rust',
      info: 'sd-ink',
    };
    const darkRamps: Record<string, string> = {
      gray: 'sd-deep',
      success: 'sd-deep',
      info: 'sd-deep',
    };
    const missing: string[] = [];
    for (const [rule, table] of [
      [scope, ramps],
      [darkScope, darkRamps],
    ] as const) {
      for (const [scale, ramp] of Object.entries(table)) {
        for (const step of STEPS) {
          light(`${ramp}-${step}`);
          if (!rule.includes(`--color-${scale}-${step}: var(--color-${ramp}-${step});`))
            missing.push(`${rule === scope ? 'light' : 'dark'} ${scale}-${step}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(scope).toContain('--color-white: var(--color-sd-cream);');
  });

  it('the scope squares every radius token and sets the console faces', () => {
    expect(themeBlock()).toMatch(/--radius-sd:\s*0;/);
    const radii = ['', '-xs', '-sm', '-md', '-lg', '-xl', '-2xl', '-3xl', '-4xl'].filter(
      (suffix) => !scope.includes(`--radius${suffix}: var(--radius-sd);`),
    );
    expect(radii).toEqual([]);
    for (const line of [
      '--font-sans: var(--font-body-sd);',
      '--font-display: var(--font-display-sd);',
      '--page-title-font: var(--font-display-sd);',
      '--page-title-weight: 600;',
    ])
      expect(scope).toContain(line);
  });

  it('both gray ramps run light to dark, step by step', () => {
    for (const ramp of ['sd-ink', 'sd-deep']) {
      const lum = STEPS.map((step) => luminance(light(`${ramp}-${step}`)));
      expect(lum).toEqual([...lum].sort((a, b) => b - a));
    }
  });

  it('light theme: text tokens read 4.5:1 on parchment, paper and every chat bubble', () => {
    const parchment = light('sd-parchment');
    const paper = light('sd-paper');
    for (const text of [
      'sd-ink',
      'sd-ink-soft',
      'sd-ink-muted',
      'sd-ink-hint',
      'sd-teal',
      'sd-teal-deep',
      'sd-danger-ink',
    ]) {
      expect({ text, parchment: contrast(light(text), parchment) >= 4.5 }).toEqual({
        text,
        parchment: true,
      });
      expect({ text, paper: contrast(light(text), paper) >= 4.5 }).toEqual({ text, paper: true });
    }
    // `.sd-msg` is opaque paper, `--mine` the accent tint, `--ai` violet over paper.
    for (const bubble of [paper, light('sd-accent-100'), over(light('sd-violet'), 0.13, paper)])
      expect(contrast(light('sd-ink-hint'), bubble)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light('sd-mint-paper'), light('sd-teal-deep'))).toBeGreaterThanOrEqual(4.5);
  });

  it('dark theme: the re-assigned text tokens read 4.5:1 on parchment, paper and every chat bubble', () => {
    const parchment = dark('sd-parchment');
    const paper = dark('sd-paper');
    for (const text of [
      'sd-ink',
      'sd-ink-soft',
      'sd-ink-muted',
      'sd-ink-hint',
      'sd-teal',
      'sd-teal-deep',
      'sd-danger-ink',
    ]) {
      expect({ text, parchment: contrast(dark(text), parchment) >= 4.5 }).toEqual({
        text,
        parchment: true,
      });
      expect({ text, paper: contrast(dark(text), paper) >= 4.5 }).toEqual({ text, paper: true });
    }
    for (const bubble of [paper, dark('sd-accent-100'), over(light('sd-violet'), 0.13, paper)])
      expect(contrast(dark('sd-ink-hint'), bubble)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark('sd-mint-paper'), dark('sd-teal-deep'))).toBeGreaterThanOrEqual(4.5);
  });

  it('inside the scope: muted text and button labels hold 4.5:1 (light ramp and dark ramp)', () => {
    const cream = light('sd-cream');
    expect(contrast(light('sd-ink-400'), cream)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light('sd-ink-400'), light('sd-ink-50'))).toBeGreaterThanOrEqual(4.5);
    for (const fill of ['sd-teal-600', 'sd-rust-600', 'sd-amber-600']) {
      expect({ fill, ok: contrast(cream, light(fill)) >= 4.5 }).toEqual({ fill, ok: true });
    }
    expect(contrast(light('sd-deep-400'), light('sd-deep-900'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light('sd-deep-400'), light('sd-deep-800'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light('sd-deep-300'), light('sd-deep-800'))).toBeGreaterThanOrEqual(4.5);
  });

  it('every workspace, both themes: Industry text holds 4.5:1 and icons 3:1 where they are drawn', () => {
    const failures: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const ws of WORKSPACES) {
        const t = resolver(page(theme, ws));
        const at = `${theme}/${ws}`;
        const grounds = [t('sd-paper'), t('sd-parchment')];
        const accentTint = t('sd-accent-100');
        const aiBubble = over(t('sd-violet'), 0.13, t('sd-paper'));
        const text: Array<[string, string, string]> = [
          // text on the page ground and on a raised surface
          ...[
            'sd-ink',
            'sd-ink-soft',
            'sd-ink-muted',
            'sd-ink-hint',
            'sd-teal',
            'sd-teal-deep',
            'sd-danger-ink',
            'sd-neutral-700',
            'sd-neutral-800',
            'sd-neutral-900',
            'sd-accent-700',
            'sd-accent-800',
            'sd-accent-900',
            'sd-hz-amber-ink',
          ].flatMap((name) =>
            grounds.map((ground): [string, string, string] => [`${at} ${name}`, t(name), ground]),
          ),
          // text on a fill: accent pairs, primary button, bubbles, alarm tiles and tints
          [`${at} mint-paper on teal-deep`, t('sd-mint-paper'), t('sd-teal-deep')],
          [`${at} cream on teal-600 (primary button)`, t('sd-cream'), t('sd-teal-600')],
          [`${at} accent-800 on accent-100 (active tag)`, t('sd-accent-800'), accentTint],
          [`${at} ink on neutral-300 (OK tag, success banner)`, t('sd-ink'), t('sd-neutral-300')],
          [`${at} accent-900 on accent-100 (active row)`, t('sd-accent-900'), accentTint],
          [`${at} ink on accent-100 (own message)`, t('sd-ink'), accentTint],
          [`${at} hint on accent-100 (own message time)`, t('sd-ink-hint'), accentTint],
          [`${at} ink on the AI bubble`, t('sd-ink'), aiBubble],
          [`${at} hint on the AI bubble`, t('sd-ink-hint'), aiBubble],
          [`${at} on-red on red-deep (CRIT tile)`, t('sd-hz-on-red'), t('sd-hz-red-deep')],
          [`${at} on-amber on amber (HIGH tile)`, t('sd-hz-on-amber'), t('sd-hz-amber')],
          [`${at} danger-ink on red tint`, t('sd-danger-ink'), t('sd-hz-red-tint')],
          [`${at} amber-ink on amber tint`, t('sd-hz-amber-ink'), t('sd-hz-amber-tint')],
        ];
        const icons: Array<[string, string, string]> = [
          ...['sd-accent', 'sd-neutral-600', 'sd-hz-red', 'sd-danger', 'sd-violet-ink'].flatMap(
            (name) =>
              grounds.map((ground): [string, string, string] => [
                `${at} icon ${name}`,
                t(name),
                ground,
              ]),
          ),
          [`${at} icon danger on red tint`, t('sd-danger'), t('sd-hz-red-tint')],
        ];
        failures.push(...below(text, TEXT), ...below(icons, ICON));
      }
    }
    expect(failures).toEqual([]);
  });

  it('a console token takes one value per theme and workspace, wherever the attributes sit', () => {
    // The contrast rows above are measured on the page placement; this holds every other
    // placement to the same values. A dark island inside a workspace once matched only the
    // theme-wide dark block: steel accent on it, the workspace's primary still inherited.
    const drift: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const ws of WORKSPACES) {
        const expected = cascade(page(theme, ws));
        for (const [where, path] of placements(theme, ws)) {
          const actual = cascade(path);
          for (const property of SD_PROPERTIES)
            if (actual(property) !== expected(property))
              drift.push(
                `${theme}/${ws}, ${where}: ${property} ${String(actual(property))} ≠ ${String(expected(property))}`,
              );
        }
      }
    }
    expect(SD_PROPERTIES.length).toBeGreaterThan(100);
    expect(drift).toEqual([]);
    // Not vacuous: each workspace moves the accent off steel, in both themes.
    for (const theme of ['light', 'dark'] as const)
      for (const ws of WORKSPACES.filter((name) => name !== 'aqua'))
        expect({
          theme,
          ws,
          moved: resolver(page(theme, ws))('sd-teal') !== resolver(page(theme, 'aqua'))('sd-teal'),
        }).toEqual({ theme, ws, moved: true });
  });

  it('the console shadows are plain custom properties, so the dark theme reaches `shadow-(--shadow-sd-*)`', () => {
    // Tailwind v4 copies a @theme shadow value into its utility instead of reading the
    // variable, so a dark re-assignment of a @theme shadow never reaches the page.
    expect(themeBlock()).not.toMatch(/--shadow-sd-[a-z0-9-]*\s*:/);
    for (const step of ['sm', 'md', 'lg']) {
      const property = `--shadow-sd-${step}`;
      const lightValue = cascade(page('light', 'aqua'))(property);
      const darkValue = cascade(page('dark', 'aqua'))(property);
      expect({
        property,
        light: lightValue !== undefined,
        flips: darkValue !== lightValue,
      }).toEqual({
        property,
        light: true,
        flips: true,
      });
    }
  });

  it('the graphite rail: labels hold 4.5:1 and icons 3:1 on every stop of its gradient', () => {
    const stops = ['sd-rail-top', 'sd-rail-mid', 'sd-rail-bottom'].map((stop) => light(stop));
    const activeRow = over(light('sd-mint'), 0.15, light('sd-rail-top'));
    const rows = (names: string[], grounds: string[]): Array<[string, string, string]> =>
      names.flatMap((name) =>
        grounds.map((ground): [string, string, string] => [name, light(name), ground]),
      );
    expect([
      ...below(
        [
          ...rows(
            ['sd-rail-item', 'sd-rail-child', 'sd-rail-bright', 'sd-rail-accent', 'sd-ink-faint'],
            stops,
          ),
          ...rows(['sd-mint-soft'], [...stops, activeRow]),
        ],
        TEXT,
      ),
      ...below(rows(['sd-rail-icon', 'sd-rail-child-icon', 'sd-mint'], stops), ICON),
    ]).toEqual([]);
  });
});

/**
 * INVARIANT (FE-MEDIUM-090): every face theme.css names is one the shell loads.
 *
 * `web/shell/index.html` is the only font loader. A family named in a
 * `--font-*` token but missing from its Google Fonts request does not fail
 * anywhere: the browser falls back down the stack and the product renders in
 * a face nobody chose (the tenant console's Barlow pair was added this way).
 * The first family of each stack is the web font; the rest are system faces.
 */
describe('INVARIANT (FE-MEDIUM-090): the shell loads every face theme.css names', () => {
  const INDEX_HTML = readFileSync(resolve(REPO_ROOT, 'web/shell/index.html'), 'utf8');

  it('the first family of every --font-* token is in the Google Fonts request', () => {
    const request = /https:\/\/fonts\.googleapis\.com\/css2\?[^"]+/.exec(INDEX_HTML)?.[0] ?? '';
    expect(request).not.toBe('');
    const families = [...themeBlock().matchAll(/--font-[a-z-]+:\s*([^,;]+)[,;]/g)].map(
      ([, first]) => (first ?? '').trim().replace(/^'|'$/g, ''),
    );
    expect(families.length).toBeGreaterThanOrEqual(5);
    const unloaded = families.filter(
      (family) => !request.includes(`family=${family.replace(/ /g, '+')}:`),
    );
    expect(unloaded).toEqual([]);
  });
});
