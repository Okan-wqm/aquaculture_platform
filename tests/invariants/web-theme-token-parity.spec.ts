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
 * `sd-page` / `sd-surface` (web/shared-ui/src/styles/suderra.css) re-assign the
 * gray, primary and semantic scales inside the tenant console. The values live
 * in theme.css as `--color-sd-*` tokens; suderra.css may only reference them,
 * so theme.css stays the one owner of every colour value and this file is the
 * one place their contrast is measured. Review of 5435f85ba found a hint token
 * at 2.7:1 on parchment carrying the dialog close icon and chat timestamps.
 */
describe('INVARIANT (FE-HIGH-321): Suderra scope — tokens only, AA in both themes', () => {
  const SUDERRA_CSS = 'web/shared-ui/src/styles/suderra.css';
  const suderra = readFileSync(resolve(REPO_ROOT, SUDERRA_CSS), 'utf8');
  const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];

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
  function tokenIn(block: string, name: string): string {
    const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block);
    if (match?.[1] === undefined) throw new Error(`no hex --color-${name} in the block`);
    return match[1].toLowerCase();
  }
  const light = (name: string): string => tokenIn(themeBlock(), name);
  const darkBlock = (() => {
    const blocks = THEME_SOURCE.match(/\[data-theme='dark'\]\s*\{[^}]*\}/g) ?? [];
    const sd = blocks.find((block) => block.includes('--color-sd-paper'));
    if (sd === undefined) throw new Error("theme.css has no [data-theme='dark'] block for sd-*");
    return sd;
  })();
  const dark = (name: string): string => tokenIn(darkBlock, name);

  it('suderra.css holds no colour value of its own', () => {
    const code = suderra.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/g) ?? []).toEqual([]);
  });

  it('the scope re-assigns every step of each scale to its theme.css ramp', () => {
    const scope = /:where\(\.sd-page, \.sd-surface\) \{([^}]*)\}/.exec(suderra)?.[1] ?? '';
    const darkScope =
      /\[data-theme='dark'\] :where\(\.sd-page, \.sd-surface\) \{([^}]*)\}/.exec(suderra)?.[1] ??
      '';
    const ramps: Record<string, string> = {
      gray: 'sd-ink',
      primary: 'sd-teal',
      success: 'sd-mint',
      warning: 'sd-amber',
      error: 'sd-rust',
      info: 'sd-sea',
    };
    const missing: string[] = [];
    for (const [scale, ramp] of Object.entries(ramps)) {
      for (const step of STEPS) {
        light(`${ramp}-${step}`);
        if (!scope.includes(`--color-${scale}-${step}: var(--color-${ramp}-${step});`))
          missing.push(`${scale}-${step}`);
      }
    }
    for (const step of STEPS) {
      light(`sd-deep-${step}`);
      if (!darkScope.includes(`--color-gray-${step}: var(--color-sd-deep-${step});`))
        missing.push(`dark gray-${step}`);
    }
    expect(missing).toEqual([]);
    expect(scope).toContain('--color-white: var(--color-sd-cream);');
  });

  it('both gray ramps run light to dark, step by step', () => {
    for (const ramp of ['sd-ink', 'sd-deep']) {
      const lum = STEPS.map((step) => luminance(light(`${ramp}-${step}`)));
      expect(lum).toEqual([...lum].sort((a, b) => b - a));
    }
  });

  it('light theme: text tokens read 4.5:1 on parchment, paper and a chat bubble', () => {
    const parchment = light('sd-parchment');
    const paper = light('sd-paper');
    const bubble = over(light('sd-ink'), 0.09, parchment);
    for (const text of [
      'sd-ink',
      'sd-ink-soft',
      'sd-ink-muted',
      'sd-ink-hint',
      'sd-teal-deep',
      'sd-danger-ink',
    ]) {
      expect({ text, parchment: contrast(light(text), parchment) >= 4.5 }).toEqual({
        text,
        parchment: true,
      });
      expect({ text, paper: contrast(light(text), paper) >= 4.5 }).toEqual({ text, paper: true });
    }
    expect(contrast(light('sd-ink-hint'), bubble)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light('sd-mint-paper'), light('sd-teal-deep'))).toBeGreaterThanOrEqual(4.5);
  });

  it('dark theme: the re-assigned text tokens read 4.5:1 on parchment, paper and a chat bubble', () => {
    const parchment = dark('sd-parchment');
    const paper = dark('sd-paper');
    // sd-rule under the dark theme is rail-item (#c6dde4) at 12%.
    const bubble = over(light('sd-rail-item'), 0.12, parchment);
    for (const text of [
      'sd-ink',
      'sd-ink-soft',
      'sd-ink-muted',
      'sd-ink-hint',
      'sd-teal-deep',
      'sd-danger-ink',
    ]) {
      expect({ text, parchment: contrast(dark(text), parchment) >= 4.5 }).toEqual({
        text,
        parchment: true,
      });
      expect({ text, paper: contrast(dark(text), paper) >= 4.5 }).toEqual({ text, paper: true });
    }
    expect(contrast(dark('sd-ink-hint'), bubble)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark('sd-mint-paper'), dark('sd-teal-deep'))).toBeGreaterThanOrEqual(4.5);
  });

  it('inside the scope: muted text and button labels hold 4.5:1 (light ramp and dark ramp)', () => {
    const cream = light('sd-cream');
    expect(contrast(light('sd-ink-400'), cream)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light('sd-ink-400'), light('sd-ink-50'))).toBeGreaterThanOrEqual(4.5);
    for (const fill of ['sd-teal-600', 'sd-mint-600', 'sd-rust-600', 'sd-amber-600']) {
      expect({ fill, ok: contrast(cream, light(fill)) >= 4.5 }).toEqual({ fill, ok: true });
    }
    expect(contrast(light('sd-deep-400'), light('sd-deep-900'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light('sd-deep-400'), light('sd-deep-800'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light('sd-deep-300'), light('sd-deep-800'))).toBeGreaterThanOrEqual(4.5);
  });
});
