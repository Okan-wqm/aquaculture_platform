/**
 * INVARIANT (FE-HIGH-333): a page audited onto the tenant console's Industry
 * theme stays on it.
 *
 * WHY: suderra.css re-assigns the theme tokens inside the console scope —
 * gray / success / info to the graphite ramp, primary to the workspace accent,
 * warning and accent (Severity's "high" tier, README §7.5) to the hazard amber,
 * error to the hazard red, every radius token to square, the sans and display
 * faces to Inter — so a page written against those scales paints Industry
 * with no skin of its own (web-theme-token-parity.spec.ts pins each mapping).
 * What the scope cannot reach is whatever does not read those tokens:
 *
 *   - Tailwind's raw hues, and the two legacy scales the scope leaves alone
 *     (sea-green `secondary`, slate `neutral`);
 *   - a colour function written in script (`rgb(`, `hsl(`, `oklch(`): a
 *     literal no theme reaches — paint from `var(--color-*)`;
 *   - gradients (Industry draws no fills but the primary button);
 *   - an arbitrary radius (`rounded-[14px]` is not a token, so it keeps its
 *     corner), and `rounded-full` on a padded pill (`rounded-full` reads no
 *     token either; on a dot, an avatar or a switch it is meant);
 *   - the v3 shadow scale: Tailwind copies a shadow token's value into its
 *     utility, so no re-assignment reaches `shadow-md` — the console's
 *     elevation is `shadow-(--shadow-sd-sm|md|lg)`, which follows the theme;
 *   - a serif or arbitrary font family;
 *   - a card drawn by hand — a `bg-white` box with a rounded hairline: inside
 *     the scope that is a cream-filled box with no corner marks, beside
 *     `sd-card` frames on the same page (README §7.7: a card is a line
 *     drawing with no fill; suderra.css `.sd-card` owns it). Held over
 *     CARD_FRAME_AUDITED, the files already moved onto `sd-card`;
 *   - a looping `animate-pulse` / `-ping` / `-bounce` with no `motion-safe:`
 *     gate (README §7.5). Held over MOTION_AUDITED.
 *
 * sensor-module's SCADA and chart canvases take colours as values; the
 * colour-function and gradient rules waive exactly those files
 * (COLOUR_VALUE_SURFACES), and the spec fails on a waiver nothing needs.
 *
 * A stylesheet is read too: an `@apply bg-green-400` paints exactly what the
 * class would.
 *
 * Each renders the pre-console look inside the console and passes every
 * render test. The 2026-10-16 audit moved tenant-admin, farm-module,
 * hr-module, dashboard, hydroponics-module, messaging-module, sensor-module and
 * the shell's settings pages off all of them; this spec holds those files at zero and is
 * the one owner of these rules — a package does not keep a local copy.
 * A package joins AUDITED once it is clean — the list only grows.
 *
 * Not textual, so not here: a meaning misused on an allowed scale (amber on a
 * decoration, the legacy tenant green as the selection accent). The audit
 * fixed those by reading each site.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');

/** Audited onto the console theme: a directory root (every source file under it) or one file. */
const AUDITED: readonly string[] = [
  'web/modules/tenant-admin/src',
  'web/modules/farm-module/src',
  'web/modules/hr-module/src',
  'web/modules/dashboard/src',
  'web/modules/hydroponics-module/src',
  'web/modules/messaging-module/src',
  'web/modules/sensor-module/src',
  'web/shell/src/pages/SettingsPage.tsx',
  // The settings page's cards split out of SettingsPage.tsx (AppearanceSettings).
  'web/shell/src/pages/settings',
  'web/shell/src/pages/ConsentSettingsPage.tsx',
];

/**
 * Where the hand-drawn card rule holds: the audited sources whose every card
 * is `sd-card`. The rest still paint the filled card and join when
 * FE-MEDIUM-340 closes (docs/reviews/claude/2026-10-16-tenant-console-d6.md):
 * the shell's settings pages draw theirs through shared-ui `Card`, itself a
 * filled box, so moving ConsentSettingsPage's own four alone would mix the
 * two looks on one page; sensor-module, farm-module, hr-module and
 * hydroponics-module hand-draw 147, 130, 63 and 26.
 */
const CARD_FRAME_AUDITED: readonly string[] = ['web/modules/tenant-admin/src/'];

/**
 * sensor-module surfaces where a colour is a value, not a class the scope can
 * re-map, so the colour-function and gradient rules do not hold over them
 * (every other rule does):
 *   - the SCADA runtime (`engine/`, its ISA-101 palette in engine/theme/
 *     tokens.ts) and the HMI widget renderers paint the operator's drawing
 *     onto SVG and canvas;
 *   - the editor canvases' nodes, the minimap mask and the Layers panel's
 *     per-group hue, which must match the group ring on the canvas node;
 *   - the process diagram's SVG filter and the heatmap's data ramp (a legend
 *     strip is that ramp drawn as a gradient);
 *   - the uPlot / recharts grids: an ink at a few per cent alpha handed to a
 *     2D canvas or an SVG attribute, which no CSS variable reaches and which
 *     reads on either ground.
 * The spec fails on an entry that no longer needs the waiver, so the list
 * only shrinks.
 */
const COLOUR_VALUE_SURFACES: readonly string[] = [
  'web/modules/sensor-module/src/engine/',
  'web/modules/sensor-module/src/components/scada-builder/widget-renderers/',
  'web/modules/sensor-module/src/components/scada-builder/nodes/',
  'web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx',
  'web/modules/sensor-module/src/components/scada-builder/LayersPanel.tsx',
  'web/modules/sensor-module/src/components/process-editor/nodes/',
  'web/modules/sensor-module/src/components/dashboard/widgets/ProcessDiagramRenderer.tsx',
  'web/modules/sensor-module/src/components/dashboard/widgets/HeatmapWidgetContent.tsx',
  'web/modules/sensor-module/src/components/charts/BarChart.tsx',
  'web/modules/sensor-module/src/components/charts/TrendChart.tsx',
  'web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeChart.tsx',
];

/**
 * Where a looping animation has to be gated: README §7.5 — under
 * `prefers-reduced-motion: reduce` the alarm glyph does not blink — and the
 * console's own marks are `motion-safe:` only (theme.css `--animate-sd-blink`).
 * Tailwind's `animate-pulse` has no reduced-motion rule of its own, and the
 * shell's opt-out lists its own animations only, so an ungated pulse keeps
 * looping for a reader who asked for stillness. A spinner is not looped
 * decoration and stays.
 */
const MOTION_AUDITED: readonly string[] = ['web/modules/sensor-module/src/'];

function sourceFiles(path: string): string[] {
  if (statSync(resolve(REPO_ROOT, path)).isFile()) return [path];
  return readdirSync(resolve(REPO_ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' || entry.name === 'test' ? [] : sourceFiles(child);
    }
    // Stylesheets too: `@apply` takes the same utilities a className does.
    const isSource =
      /\.(?:tsx?|css)$/.test(entry.name) && !/\.(spec|test)\.tsx?$|\.d\.ts$/.test(entry.name);
    return isSource ? [child] : [];
  });
}

/**
 * The source with its comments blanked to spaces: a class named in prose is
 * not painted, and blanking (not deleting) keeps every line number.
 */
function code(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|\s)(\/\/.*)$/gm, (_match, lead: string, comment: string) => lead + blank(comment));
}

/** A utility's variant chain (`dark:`, `hover:`, `md:`), not part of a longer class name. */
const VARIANTS = String.raw`(?<![\w-])(?:[a-z0-9-]+:)*!?`;
/** Every utility that takes a colour. */
const COLOUR_UTILITY = String.raw`(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|divide|from|via|to|placeholder|outline|shadow|fill|stroke|accent|caret|decoration)`;
const HUES =
  'slate|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';

interface Hit {
  readonly index: number;
  readonly text: string;
}

interface Rule {
  readonly id: string;
  /** Offending snippets in one file's comment-free source, by offset. */
  readonly find: (source: string) => Hit[];
  /** Path prefixes the rule holds over; every audited file when absent. */
  readonly within?: readonly string[];
  /** Path prefixes the rule does not hold over (a documented waiver). */
  readonly except?: readonly string[];
}

function hits(source: string, pattern: RegExp): Hit[] {
  return [...source.matchAll(pattern)].map((match) => ({ index: match.index, text: match[0] }));
}

function matching(pattern: RegExp): (source: string) => Hit[] {
  return (source) => hits(source, pattern);
}

const STRING_LITERAL = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/g;
const QUOTED = /'[^'\n]*'|"[^"\n]*"/g;

/**
 * The class lists one literal spells: a quoted string is one; a template is
 * its static text plus each quoted branch inside it (`${a ? '…' : '…'}`), so
 * the classes of two exclusive branches are never read as one element's.
 */
function classLists(literal: string): string[] {
  if (!literal.startsWith('`')) return [literal];
  return [literal.replace(QUOTED, ' '), ...(literal.match(QUOTED) ?? [])];
}

/**
 * A card drawn by hand: one class list with the light fill, a rounded corner
 * and the bare hairline `border`. A padded control (`px-*`: a button, an
 * input, a select) keeps its field fill and is not a card.
 */
function isHandDrawnCard(classes: string): boolean {
  return (
    /(?<![\w:-])bg-white\b/.test(classes) &&
    /(?<![\w:-])rounded-(?:lg|xl|2xl)\b/.test(classes) &&
    /(?<![\w:-])border(?![\w-])/.test(classes) &&
    !/(?<![\w:-])px-/.test(classes)
  );
}

const RULES: readonly Rule[] = [
  {
    id: 'legacy scale the console scope does not re-map (secondary / neutral)',
    find: matching(new RegExp(`${VARIANTS}${COLOUR_UTILITY}-(?:secondary|neutral)-\\d+`, 'g')),
  },
  {
    id: 'colour function in script (paint from var(--color-*))',
    find: matching(/(?<![\w-])(?:rgba?|hsla?|oklch|oklab)\(/g),
    except: COLOUR_VALUE_SURFACES,
  },
  {
    id: "Tailwind's raw hue",
    find: matching(new RegExp(`${VARIANTS}${COLOUR_UTILITY}-(?:${HUES})-\\d+`, 'g')),
  },
  {
    id: 'gradient',
    find: matching(
      /bg-gradient-to-\w+|bg-(?:linear|radial|conic)-[\w[(-]+|(?:linear|radial|conic)-gradient\(/g,
    ),
    except: COLOUR_VALUE_SURFACES,
  },
  {
    id: 'arbitrary radius (not a token, so the scope cannot square it)',
    find: matching(new RegExp(`${VARIANTS}rounded(?:-[a-z]{1,2})?-\\[[^\\]]*\\]`, 'g')),
  },
  {
    id: 'pill: rounded-full on a padded box',
    find: (source) =>
      hits(source, STRING_LITERAL).filter(
        ({ text }) => /(?<![\w-])rounded-full\b/.test(text) && /(?<![\w-])px-/.test(text),
      ),
  },
  {
    id: 'v3 shadow scale (use shadow-(--shadow-sd-sm|md|lg))',
    find: matching(
      new RegExp(
        `${VARIANTS}shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner|card|dropdown|modal))?(?![\\w(\\[-])`,
        'g',
      ),
    ),
  },
  {
    id: 'serif or arbitrary font family',
    find: matching(new RegExp(`${VARIANTS}font-(?:serif|\\[[^\\]]*\\])`, 'g')),
  },
  {
    id: 'card drawn by hand: a filled rounded box (use SD_CARD / sd-card, README §7.7)',
    find: (source) =>
      hits(source, STRING_LITERAL).filter(({ text }) => classLists(text).some(isHandDrawnCard)),
    within: CARD_FRAME_AUDITED,
  },
  {
    id: 'looping animation without a reduced-motion gate (motion-safe:animate-*)',
    find: matching(/(?<![\w:-])animate-(?:pulse|ping|bounce)(?:-slow)?(?![\w-])/g),
    within: MOTION_AUDITED,
  },
];

/** Whole-source matching, so a class string written over several lines is read as one. */
function violations(file: string): string[] {
  const source = code(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
  const lineOf = (index: number): number => source.slice(0, index).split('\n').length;
  const holds = (rule: Rule): boolean =>
    (rule.within === undefined || rule.within.some((prefix) => file.startsWith(prefix))) &&
    !(rule.except ?? []).some((prefix) => file.startsWith(prefix));
  return RULES.filter(holds).flatMap((rule) =>
    rule
      .find(source)
      .map(
        ({ index, text }) =>
          `${file}:${lineOf(index)} [${rule.id}] ${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`,
      ),
  );
}

describe('INVARIANT (FE-HIGH-333): audited pages stay on the Industry console theme', () => {
  const files = AUDITED.flatMap(sourceFiles);

  it('sees the audited sources', () => {
    // A path typo would make the assertion below vacuously true: every
    // audited entry has to yield source files of its own.
    expect(AUDITED.filter((path) => sourceFiles(path).length === 0)).toEqual([]);
    expect(
      files.filter((file) => file.startsWith('web/modules/tenant-admin/')).length,
    ).toBeGreaterThan(80);
    expect(
      files.filter((file) => file.startsWith('web/modules/farm-module/')).length,
    ).toBeGreaterThan(100);
    expect(
      files.filter((file) => file.startsWith('web/modules/hr-module/')).length,
    ).toBeGreaterThan(90);
    expect(files).toEqual(expect.arrayContaining(AUDITED.filter((path) => /\.tsx?$/.test(path))));
    expect(files).toContain('web/modules/tenant-admin/src/styles.css');
    // Every card-rule prefix names audited sources, or the rule holds over nothing.
    for (const prefix of CARD_FRAME_AUDITED) {
      expect(files.some((file) => file.startsWith(prefix)) ? '' : prefix).toBe('');
    }
    expect(
      files.filter((file) => file.startsWith('web/modules/sensor-module/')).length,
    ).toBeGreaterThan(500);
    expect(files).toContain('web/modules/sensor-module/src/styles/process-editor.css');
    for (const prefix of MOTION_AUDITED) {
      expect(files.some((file) => file.startsWith(prefix)) ? '' : prefix).toBe('');
    }
  });

  it('waives the colour-value surfaces only where a colour value is still written', () => {
    // An entry whose files no longer write a colour function or a gradient is
    // a stale waiver: drop it, and the rules hold there again.
    const waived = RULES.filter((rule) => rule.except === COLOUR_VALUE_SURFACES);
    expect(waived.length).toBe(2);
    const stale = COLOUR_VALUE_SURFACES.filter(
      (prefix) =>
        !files
          .filter((file) => file.startsWith(prefix))
          .some((file) =>
            waived.some(
              (rule) => rule.find(code(readFileSync(resolve(REPO_ROOT, file), 'utf8'))).length > 0,
            ),
          ),
    );
    expect(stale).toEqual([]);
  });

  it('paints only from the tokens the console scope re-maps', () => {
    expect(files.flatMap(violations)).toEqual([]);
  });

  describe('detects what it claims to', () => {
    const flagged = (snippet: string): boolean =>
      RULES.some((rule) => rule.find(code(snippet)).length > 0);

    it.each([
      'className="bg-blue-600"',
      'className="dark:bg-secondary-900/40"',
      'className="border-l-green-500"',
      'className="hover:bg-slate-800"',
      'className="text-secondary-700"',
      'className="bg-neutral-500"',
      'className="bg-gradient-to-r from-gray-50 to-white"',
      'className="rounded-[14px] border"',
      "className='inline-flex px-2 py-0.5 rounded-full text-xs'",
      'className="hover:shadow-md"',
      'className="bg-white shadow"',
      "className={`h-4 w-4 ${critical ? 'text-error-400 animate-pulse' : ''}`}",
      'className="w-2 h-2 rounded-full bg-primary-500 animate-ping"',
      'className="font-serif"',
      "const STROKE = 'rgb(14 116 144)';",
      'fill={`hsl(200 60% 45%)`}',
      "background: 'rgba(0, 0, 0, 0.5)'",
      '@apply bg-green-400 dark:bg-slate-800;',
      'className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 p-6"',
      'className="border border-gray-200 rounded-xl overflow-hidden bg-white"',
      'className={`bg-white rounded-lg border p-4 ${open ? "ring-1" : ""}`}',
    ])('flags %s', (snippet) => {
      expect(flagged(snippet)).toBe(true);
    });

    it.each([
      'className="bg-sd-accent-100 text-sd-accent-800 border-sd-accent-300"',
      'className="text-sd-neutral-700 bg-sd-teal-600 text-sd-hz-amber-ink"',
      'className="shadow-(--shadow-sd-md) hover:shadow-(--shadow-sd-lg)"',
      'className="shadow-none transition-shadow"',
      'className="w-8 h-8 rounded-full"',
      'className="relative inline-flex h-6 w-11 rounded-full"',
      'className="rounded-lg bg-primary-600 text-white"',
      'className="font-display font-semibold"',
      // accent is re-mapped to the hazard amber (Severity "high"); its meaning is read per site
      'className="bg-accent-100 dark:bg-accent-900/40 text-accent-800"',
      "stroke: 'var(--color-primary-500)'",
      "background: 'color-mix(in srgb, var(--color-text) 5%, transparent)'",
      'const parts = parse_rgba(input);',
      // a gated loop, and a spinner (loading feedback, not decoration)
      'className="text-error-400 motion-safe:animate-pulse"',
      'className="w-4 h-4 animate-spin"',
      '// a comment naming bg-blue-600 and shadow-lg',
      // a scrollbar thumb is round by design; the pill rule reads quoted class lists only
      '@apply bg-gray-300 dark:bg-gray-600 rounded-full;',
      // the blueprint card and a padded control (a select keeps its field fill)
      'className={`${SD_CARD} p-6`}',
      'className="px-3 py-1.5 bg-white dark:bg-gray-900 border border-gray-300 rounded-lg"',
      // two exclusive branches: a bordered fill and a rounded box are not one element
      "className={`max-w-2xl rounded-lg p-4 ${mine ? 'bg-primary-600' : 'bg-white border'}`}",
    ])('passes %s', (snippet) => {
      expect(flagged(snippet)).toBe(false);
    });
  });
});
