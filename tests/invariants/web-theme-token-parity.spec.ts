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
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { colors } from '../../web/shared-ui/src/styles/theme';
import {
  DARK_SCOPE_RULE,
  SCOPE_RULE,
  SUDERRA_SOURCE,
  THEME_CSS,
  THEME_SOURCE,
  THEMES,
  WORKSPACES,
  bare,
  cascade,
  contrast,
  luminance,
  oklch,
  over,
  page,
  placements,
  resolver,
  suderraRule,
  themeBlock,
  workspaceMotifs,
} from './lib/web-console-theme';

const REPO_ROOT = resolve(__dirname, '../..');

const TOKEN = /--color-([a-z]+)-(\d+):\s*(#[0-9a-fA-F]{6})\s*;/g;

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
 * (`cascade()` in lib/web-console-theme.ts: specificity, source order,
 * inheritance), and every
 * placement of the attributes — the theme on <html>, on the workspace
 * element, or pinned on a dark island inside it — must resolve to the same
 * values as the page.
 */
describe('INVARIANT (FE-HIGH-321): Suderra scope — tokens only, AA in both themes', () => {
  const suderra = SUDERRA_SOURCE;
  const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
  const TEXT = 4.5;
  const ICON = 3;

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

  /** Every console property theme.css declares — the tokens a placement must agree on. */
  const SD_PROPERTIES = [
    ...new Set(
      [...THEME_SOURCE.matchAll(/(--(?:(?:color|shadow)-)?sd-[a-z0-9-]+)\s*:/g)].map(
        ([, p = '']) => p,
      ),
    ),
  ];

  /** Pairs below `min`, as readable rows — an empty list is the pass. */
  function below(rows: ReadonlyArray<[string, string, string]>, min: number): string[] {
    return rows
      .filter(([, fg, bg]) => contrast(fg, bg) < min)
      .map(([label, fg, bg]) => `${label}: ${fg} on ${bg} = ${contrast(fg, bg).toFixed(2)}`);
  }

  const scope = SCOPE_RULE;
  const darkScope = DARK_SCOPE_RULE;

  it('suderra.css holds no colour value of its own', () => {
    const code = suderra.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/g) ?? []).toEqual([]);
  });

  it('the scope re-assigns every step of each scale to its theme.css ramp', () => {
    // Success and info follow gray: "good" is not a colour in Industry (README §7.8).
    // Accent is Severity's "high" tier, Industry's HIGH amber (README §7.5).
    const ramps: Record<string, string> = {
      gray: 'sd-ink',
      primary: 'sd-teal',
      success: 'sd-ink',
      warning: 'sd-amber',
      accent: 'sd-amber',
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
          // the console rail and workspace menu: the current row, and any row under the pointer
          [`${at} neutral-700 on accent-100 (menu: current row)`, t('sd-neutral-700'), accentTint],
          [`${at} ink on neutral-200 (rail / menu: hovered row)`, t('sd-ink'), t('sd-neutral-200')],
          [
            `${at} neutral-700 on neutral-200 (menu: hovered row)`,
            t('sd-neutral-700'),
            t('sd-neutral-200'),
          ],
          [
            `${at} accent-800 on neutral-200 (rail: hovered current area)`,
            t('sd-accent-800'),
            t('sd-neutral-200'),
          ],
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
          // the 3px accent bar that marks the user menu's chosen segment and the
          // workspace menu's current row: their accent-100 fill alone is ~1.1:1
          // against the paper, so the bar is the state cue (WCAG 1.4.11)
          [
            `${at} state bar accent on accent-100 (segment, workspace row)`,
            t('sd-accent'),
            accentTint,
          ],
          // the workspace menu's alarm glyphs on its current row
          [`${at} icon hz-red on accent-100 (menu P1 glyph)`, t('sd-hz-red'), accentTint],
          [
            `${at} icon amber-ink on accent-100 (menu P2/P3 glyph)`,
            t('sd-hz-amber-ink'),
            accentTint,
          ],
        ];
        failures.push(...below(text, TEXT), ...below(icons, ICON));
      }
    }
    expect(failures).toEqual([]);
  });

  // Forced colours (Windows contrast themes) drop box-shadows and author
  // backgrounds, which draw every current / pressed / selected cue in the
  // console (rail bars, palette row, annunciator foot bar, segment and
  // workspace fills): suderra.css redraws each from its ARIA state as an
  // outline, which survives in a system colour.
  it('forced colours: every current, pressed or selected console control draws an outline', () => {
    const code = suderra.replace(/\/\*[\s\S]*?\*\//g, '');
    const start = code.indexOf('@media (forced-colors: active)');
    expect(start).toBeGreaterThan(-1);
    const block = code.slice(
      start,
      code.indexOf('}', code.indexOf('{', code.indexOf('{', start) + 1)),
    );
    for (const state of [
      "[aria-current]:not([aria-current='false'])",
      "[aria-pressed='true']",
      "[role='option'][aria-selected='true']",
      "[role='tab'][aria-selected='true']",
    ])
      expect(block).toContain(state);
    expect(block).toContain('body:has(.sd-content)');
    // A focused control keeps its focus ring, which is an outline too (WCAG 2.4.7).
    expect(block).toContain(':not(:focus-visible)');
    expect(block).toMatch(/outline:\s*2px solid Highlight;/);
  });

  // The shell's global focus ring is a box-shadow, which forced colours drop;
  // Tailwind's outline-hidden leaves a transparent outline there, but its
  // `--tw-outline-style: none` also switched off every focus-visible:outline-*
  // utility, so a console row, tile or segment showed no focus (WCAG 2.4.7).
  it('forced colours: the shell keeps focus outlines drawn by utilities', () => {
    const shellCss = readFileSync(resolve(REPO_ROOT, 'web/shell/src/styles/index.css'), 'utf8');
    const code = shellCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toMatch(
      /@media \(forced-colors: active\)\s*\{\s*\*:focus-visible\s*\{\s*--tw-outline-style:\s*solid;/,
    );
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
});

/**
 * INVARIANT (FE-MEDIUM-348): each workspace carries its domain on the console's ground.
 *
 * Owner decision (2026-10-17): switching the workspace moves the whole console
 * into that domain, not only its accent ramp. theme.css re-assigns the ground
 * per workspace and theme — the page (`sd-paper`), the rail and the header
 * (`sd-parchment`) — to a slight tint of the domain: Production deep-sea
 * teal-blue, Greenhouse leaf green, Control & sensors industrial purple-grey,
 * Company corporate navy-graphite. suderra.css draws a static motif of the
 * domain behind the tenant console at a low opacity (reef fish; hydroponic
 * channels and leaves; circuit and P&ID lines; Company keeps the plain grid).
 *
 * Every contrast row of FE-HIGH-321 already resolves `sd-paper` and
 * `sd-parchment` per workspace, so the tints are measured there. This block
 * holds what is new: that the tints exist, lean the right way and stay
 * slight, that the neutral ground stays where no workspace is set, and that
 * text and icons still read on the two surfaces the change creates — the
 * ground under the motif and the frosted header over it.
 */
describe('INVARIANT (FE-MEDIUM-348): each workspace carries its domain on the console ground', () => {
  const GROUND = ['sd-paper', 'sd-parchment'];
  /** Where each domain's tint points (OKLCH hue, degrees) and how far it may go ("slight"). */
  const DOMAIN: Readonly<Record<string, { hue: readonly [number, number]; maxChroma: number }>> = {
    aqua: { hue: [200, 240], maxChroma: 0.025 }, // deep-sea blue / teal water
    gh: { hue: [125, 165], maxChroma: 0.025 }, // leaf green
    ctl: { hue: [280, 310], maxChroma: 0.025 }, // industrial purple-grey
    org: { hue: [240, 275], maxChroma: 0.015 }, // corporate navy / graphite
  };
  /** Below this chroma a tint is not seen; above DOMAIN's it is no longer slight. */
  const PERCEPTIBLE = 0.005;
  const TEXT = [
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
  ];
  const ICONS = ['sd-accent', 'sd-neutral-600', 'sd-hz-red', 'sd-danger', 'sd-violet-ink'];

  /** The motif layer's paint, read from suderra.css: a token colour at a token opacity. */
  const motifLayer = suderraRule('.sd-content::after');
  const motifColour = /background-color:\s*var\(--color-([a-z0-9-]+)\)/.exec(motifLayer)?.[1];
  /** The header's frost: sd-parchment at this share over whatever scrolls under it. */
  const headerShare = Number(
    /var\(--color-sd-parchment\)_(\d+)%/.exec(
      readFileSync(
        resolve(REPO_ROOT, 'web/shared-ui/src/components/Layout/console/ConsoleHeader.tsx'),
        'utf8',
      ),
    )?.[1],
  );

  it('reads the motif layer and the header frost', () => {
    // A selector or regex slip would otherwise measure nothing below.
    expect(motifColour).toBe('sd-accent');
    expect(headerShare).toBeGreaterThan(50);
    expect(headerShare).toBeLessThan(100);
    expect([...workspaceMotifs().keys()].sort()).toEqual(['aqua', 'ctl', 'gh']);
  });

  it('every workspace moves the ground off the neutral and off every other workspace, in both themes', () => {
    const same: string[] = [];
    for (const theme of THEMES) {
      const neutral = resolver(bare(theme));
      const seen = new Map<string, string>();
      for (const ws of WORKSPACES) {
        const t = resolver(page(theme, ws));
        for (const name of GROUND) {
          if (t(name) === neutral(name)) same.push(`${theme}/${ws} ${name} is the neutral ground`);
          const key = `${name} ${t(name)}`;
          const other = seen.get(key);
          if (other !== undefined) same.push(`${theme}: ${ws} and ${other} share ${key}`);
          seen.set(key, ws);
        }
      }
    }
    expect(same).toEqual([]);
  });

  it("each tint leans to its domain and stays slight, at the neutral ground's lightness", () => {
    const off: string[] = [];
    for (const theme of THEMES) {
      const neutral = resolver(bare(theme));
      for (const ws of WORKSPACES) {
        const domain = DOMAIN[ws];
        if (domain === undefined) throw new Error(`no domain for workspace ${ws}`);
        const t = resolver(page(theme, ws));
        for (const name of GROUND) {
          const tint = oklch(t(name));
          const at = `${theme}/${ws} ${name} ${t(name)}`;
          if (tint.c < PERCEPTIBLE || tint.c > domain.maxChroma)
            off.push(`${at}: chroma ${tint.c.toFixed(4)}`);
          if (tint.h < domain.hue[0] || tint.h > domain.hue[1])
            off.push(`${at}: hue ${tint.h.toFixed(1)}`);
          // Same lightness as the neutral ground: the tint changes the hue, never the contrast.
          if (Math.abs(tint.l - oklch(neutral(name)).l) > 0.006)
            off.push(`${at}: lightness ${tint.l.toFixed(4)}`);
        }
      }
    }
    expect(off).toEqual([]);
  });

  it('with no workspace set the ground stays neutral graphite (the SUPER_ADMIN console, the auth pages)', () => {
    for (const theme of THEMES)
      for (const name of GROUND)
        expect({ theme, name, chroma: oklch(resolver(bare(theme))(name)).c < PERCEPTIBLE }).toEqual(
          { theme, name, chroma: true },
        );
  });

  it('mint-paper, the text on the solid accent, stays the ground colour in every workspace', () => {
    for (const theme of THEMES)
      for (const ws of WORKSPACES) {
        const t = resolver(page(theme, ws));
        expect({ theme, ws, mint: t('sd-mint-paper') }).toEqual({ theme, ws, mint: t('sd-paper') });
      }
  });

  it('the motif is subtle: one opacity per theme, at most 0.12', () => {
    for (const theme of THEMES) {
      const opacity = Number(cascade(page(theme, 'aqua'))('--sd-motif-opacity'));
      expect({ theme, subtle: opacity > 0 && opacity <= 0.12 }).toEqual({ theme, subtle: true });
    }
  });

  it('text holds 4.5:1 and icons 3:1 on the ground under the motif and on the frosted header over it', () => {
    if (motifColour === undefined) throw new Error('suderra.css motif layer names no colour token');
    const motifs = workspaceMotifs();
    const failures: string[] = [];
    for (const theme of THEMES) {
      for (const ws of WORKSPACES) {
        const t = resolver(page(theme, ws));
        const opacity = Number(cascade(page(theme, ws))('--sd-motif-opacity'));
        // Where the motif's mask is solid, the accent lies over the paper at the layer's opacity.
        const ground = motifs.has(ws)
          ? over(t(motifColour), opacity, t('sd-paper'))
          : t('sd-paper');
        const header = over(t('sd-parchment'), headerShare / 100, ground);
        const at = `${theme}/${ws}`;
        for (const [surface, bg] of [
          ['ground under the motif', ground],
          ['frosted header', header],
        ] as const) {
          for (const name of TEXT)
            if (contrast(t(name), bg) < 4.5)
              failures.push(`${at} ${name} on the ${surface}: ${contrast(t(name), bg).toFixed(2)}`);
          for (const name of ICONS)
            if (contrast(t(name), bg) < 3)
              failures.push(
                `${at} icon ${name} on the ${surface}: ${contrast(t(name), bg).toFixed(2)}`,
              );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

/**
 * INVARIANT (FE-MEDIUM-090): every face theme.css names is one the shell serves itself.
 *
 * `web/shared-ui/src/styles/fonts.css` is the only font loader; its files live in
 * `web/shell/public/fonts` beside their OFL notices. A family named in a
 * `--font-*` token with no `@font-face` does not fail anywhere: the browser falls
 * back down the stack and the product renders in a face nobody chose. A face
 * fetched from a third-party host is worse: the production CSP is `font-src 'self'`
 * (infrastructure/security/csp.policy.json), so it is blocked wherever that policy
 * is enforced, and where it is not, it leaks the visitor's IP on every first paint.
 * The first family of each stack is the web font; the rest are system faces.
 */
describe('INVARIANT (FE-MEDIUM-090): the shell serves every face theme.css names', () => {
  const FONTS_DIR = resolve(REPO_ROOT, 'web/shell/public/fonts');
  const FONTS_CSS = readFileSync(resolve(REPO_ROOT, 'web/shared-ui/src/styles/fonts.css'), 'utf8');
  const faces = [...FONTS_CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
    family: /font-family:\s*'([^']+)'/.exec(body ?? '')?.[1] ?? '',
    file: /url\('\/fonts\/([^']+)'\)/.exec(body ?? '')?.[1] ?? '',
  }));

  it('the first family of every --font-* token has a self-hosted @font-face', () => {
    const families = [...themeBlock().matchAll(/--font-[a-z-]+:\s*([^,;]+)[,;]/g)].map(
      ([, first]) => (first ?? '').trim().replace(/^'|'$/g, ''),
    );
    expect(families.length).toBeGreaterThanOrEqual(5);
    const undeclared = families.filter((family) => !faces.some((face) => face.family === family));
    expect(undeclared).toEqual([]);
  });

  it('every declared face points at a file that is in the shell public directory', () => {
    expect(faces.length).toBeGreaterThanOrEqual(4);
    const missing = faces.filter(
      (face) => face.file === '' || !existsSync(resolve(FONTS_DIR, face.file)),
    );
    expect(missing).toEqual([]);
  });

  it('every served family ships with its licence notice', () => {
    const missing = ['LICENSE-inter.txt', 'LICENSE-geist-mono.txt'].filter(
      (notice) => !existsSync(resolve(FONTS_DIR, notice)),
    );
    expect(missing).toEqual([]);
  });

  it('neither the shell document nor the CSP policy names a third-party font host', () => {
    const host = /fonts\.(?:googleapis|gstatic)\.com/i;
    const offenders = ['web/shell/index.html', 'infrastructure/security/csp.policy.json'].filter(
      (path) => host.test(readFileSync(resolve(REPO_ROOT, path), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
