/**
 * INVARIANT — design-system adoption in the web tree only moves one way
 * (FE-HIGH-065 / FE-HIGH-066 / FE-MEDIUM-067).
 *
 * `web/shared-ui` is a real design system: 61 colour tokens, Modal /
 * ConfirmModal / Drawer with one shared dialog behaviour, Button, form fields.
 * The September 2026 survey found the product mostly not using it: 96 files
 * carried their own `fixed inset-0` overlay (55 with an unlabelled close
 * button, 111 of them stacked on the same `z-50`), 2,136 raw hex colours sat
 * outside `theme.css` (sensor-module alone wrote `#ff0000` 28 times for SCADA
 * alarms), and 683 inline `style={{…}}` blocks bypassed the token system.
 *
 * None of that can be fixed in one change, and none of it may grow while it is
 * being fixed. So this spec is a governed ratchet, the same shape as
 * `admin-panel-data-layer.spec.ts`:
 *
 *   1. **Overlays are keyed by FILE.** Every file outside shared-ui (and
 *      outside AquaMobil's own primitives, see PRIMITIVE_DIRS) that
 *      contains `fixed inset-0` must be listed with a batch (dialog → Modal,
 *      drawer → Drawer, mobile → bottom sheet, runtime → a genuine full-screen
 *      surface that is not a dialog), an owner, a future expiry, the finding
 *      and a reason; every listed file must still contain one, so a migrated
 *      file cannot hold the ceiling up. The ceiling only decreases.
 *
 *   2. **Raw hex, inline style, raw tables, hand-rolled spinners and page titles are keyed by PACKAGE.** Each web package has
 *      an occurrence ceiling; a package not listed must be at zero. Counting is
 *      by occurrence, not by file, so moving colours between files is not
 *      progress and adding one to a listed file is caught. Inline style counts
 *      only STATIC blocks (every value a literal): a runtime value reaching
 *      the DOM (a progress width, a record's colour) is data, not a bypass.
 *
 * A hand-rolled spinner (FE-MEDIUM-070) is a lucide loader icon or an inline
 * `<svg>` spun by `animate-spin`, or a bordered ring `div`/`span` spun the same
 * way — 365 of them in the survey against 16 uses of shared-ui's `Spinner`.
 * An icon whose spin is conditional (a refresh arrow while refetching) is an
 * affordance, not a loading indicator, and is not counted.
 *
 * A hand-written page title (FE-MEDIUM-071) is an `h1` in `text-2xl`/`text-xl`
 * (web) or `text-lg` (AquaMobil's bands) bold or semibold outside the two
 * PageHeaders — the title row shared-ui's PageHeader owns (one h1, one
 * description, the actions beside it, responsive and dark-aware) and the
 * band AquaMobil's PageHeader owns (tone, back arrow, icon, actions) —
 * written by hand in a dozen spellings across 169 pages in the survey.
 *
 * An icon-shaped `<svg>` (FE-MEDIUM-082) is a hand-pasted glyph — a 16, 20 or
 * 24 unit viewBox — beside the lucide-react set every package renders from:
 * 733 of them in the survey against lucide in 308 files.
 * A light-only surface (FE-MEDIUM-072) is a class string that paints
 * `bg-white`, `bg-gray-50` or `bg-gray-100` with no `dark:` sibling: under the
 * shell's dark theme the element keeps its light colour. A semantic tint
 * (`bg-success-50`, `bg-primary-100` — the Alert, Badge, KpiCard and chip
 * surfaces, FE-MEDIUM-081) is a light surface too and pairs the same way.
 * theme.css keys
 * `dark:` on `[data-theme='dark']` (the shell's toggle, or a dialog pinned
 * dark), so a surface is dark-aware exactly when every light class it paints
 * has a dark counterpart — 2,600 did not in the survey. The three shared-ui
 * primitives a pinned-dark dialog is built from are held to the strict form:
 * every gray or white class, not only surfaces, pairs with a `dark:` one.
 *
 * Detection is deliberately textual and identical to the survey (`git
 * ls-files` + a regex on the raw source, tests and generated code excluded) so
 * the numbers in the allowlist mean exactly what the survey meant.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '../..');
const ALLOWLIST = '.claude/allowlists/web-design-system-ratchet.yaml';
const ROOTS = ['web/modules', 'web/shell/src', 'web/apps'];

/**
 * The standalone PWA cannot import shared-ui (own lockfile, offline-first — see
 * web/apps/aquamobil/CLAUDE.md), so its one sanctioned overlay primitive,
 * `BottomSheet`, lives here: the mobile counterpart of shared-ui's Modal and
 * Drawer and, like them, the surface the ratchet migrates TO, not from. Only the
 * overlay check skips it; its hex and inline-style counts stay in the package
 * ceilings.
 */
const PRIMITIVE_DIRS = ['web/apps/aquamobil/src/components/ui/'];

function isPrimitive(file: string): boolean {
  return PRIMITIVE_DIRS.some((dir) => file.startsWith(dir));
}

const OVERLAY = /fixed inset-0/;
// A raw colour in any CSS spelling: #rgb, #rgba, #rrggbb, #rrggbbaa. Not an HTML
// entity (&#9888;), an IEC literal (16#FF, T#5s) or an issue number in prose — the
// look-behind rejects a word character, `&` or `#` before the hash, and comment
// lines are stripped before counting.
const RAW_HEX = /(?<![\w&#$])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
/** Block comments — the JSX-wrapped ones too — including prose lines inside them that carry no star prefix. */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
/** The token source itself: the one file that may spell a colour as hex. */
const THEME_TOKEN_SOURCE = 'web/shared-ui/src/styles/theme.ts';
/**
 * A colour utility on one of Tailwind's raw hues (`bg-blue-600`,
 * `dark:text-red-400`, `focus:ring-indigo-500`) instead of a theme scale
 * (primary / secondary / accent / success / warning / error / info / neutral).
 * The neutral greys are not counted: they are surfaces, and theme.css owns
 * `gray-400`. shared-ui is held at zero — a primitive that paints from the raw
 * palette makes the token file decorative for every consumer (FE-HIGH-078).
 */
const RAW_PALETTE =
  /(?<![\w-])(?:[a-z-]+:)*!?(?:bg|text|border|ring|divide|from|to|via|placeholder|outline|shadow|fill|stroke|accent|caret|decoration)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+(?:\/\d+)?(?![\w-])/g;
/**
 * FE-HIGH-069: a hand-rolled `<table>` re-implements what shared-ui's DataTable
 * owns — header semantics, sorting, selection, pagination, empty and loading
 * states, export. Counted per package the same way as raw hex.
 */
const RAW_TABLE = /<table\b/g;
/**
 * A TanStack `useMutation(` called directly by a module (FE-HIGH-086). A
 * mutation that reports nothing is the silent-save defect; modules declare
 * their outcome messages through shared-ui `useFeedbackMutation`, and the
 * admin panel through `useAdminMutation` (the one wrapper allowed to call
 * `useMutation` itself).
 */
const RAW_MUTATION = /\buseMutation\s*(?:<[^(]*>)?\(/g;
/**
 * Raw `<button>` and raw `<input>` / `<select>` / `<textarea>` outside the
 * primitives (FE-HIGH-079): each re-derives padding, radius, focus ring,
 * disabled state, label binding and error display that shared-ui Button /
 * Input / Select / Textarea (AquaMobil: Button / Field) already own.
 */
const RAW_BUTTON = /<button\b/g;
const RAW_FIELD = /<(?:input|select|textarea)\b/g;
/**
 * Element-aware reading of `<button>` (FE-HIGH-158, FE-HIGH-159). The two
 * counters below ask what is INSIDE a button and what its opening tag declares,
 * which a `/<button\b/` match cannot answer.
 *
 * The opening tag cannot be found by scanning to the first `>`: an arrow
 * function in a prop (`onClick={() => close()}`) carries one. Four hand-rolled
 * passes over this corpus each produced a different total because of exactly
 * that, so the scan tracks brace depth and quotes and only accepts a `>` at
 * depth zero. Nested `<button>` is not legal HTML, but the body scan counts
 * depth anyway rather than trusting the corpus.
 */
function* buttonElements(source: string): Generator<{ openTag: string; body: string }> {
  const OPEN = /<button\b/g;
  let match: RegExpExecArray | null;
  while ((match = OPEN.exec(source)) !== null) {
    const start = match.index;
    let i = start + '<button'.length;
    let depth = 0;
    let quote: string | null = null;
    let tagEnd = -1;
    for (; i < source.length; i += 1) {
      const c = source[i] as string;
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c;
      } else if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
      } else if (c === '>' && depth === 0) {
        tagEnd = i + 1;
        break;
      }
    }
    if (tagEnd === -1) return;
    const openTag = source.slice(start, tagEnd);
    if (openTag.endsWith('/>')) {
      yield { openTag, body: '' };
      OPEN.lastIndex = tagEnd;
      continue;
    }
    let bodyDepth = 1;
    let j = tagEnd;
    while (j < source.length && bodyDepth > 0) {
      if (source.startsWith('<button', j)) {
        bodyDepth += 1;
        j += '<button'.length;
      } else if (source.startsWith('</button>', j)) {
        bodyDepth -= 1;
        j += '</button>'.length;
      } else {
        j += 1;
      }
    }
    yield { openTag, body: source.slice(tagEnd, Math.max(tagEnd, j - '</button>'.length)) };
    OPEN.lastIndex = tagEnd;
  }
}

/**
 * Does the body put any words on screen? Tags are blanked to a sentinel first,
 * so an icon's own props never read as text. What is left is literal JSX text
 * plus expressions, and an expression is judged by what it can PRODUCE:
 *
 *   {open ? <X /> : <Menu />}            two elements  -> no words
 *   {isLoading ? loadingText : confirm}  two values    -> words
 *   {date.getDate()}                     a call        -> words
 *   {count > 0 && <Badge />}             a guarded element -> no words
 *
 * Both halves of that distinction were learned the hard way. Reading only the
 * condition counted the first line as text and hid every icon-only toggle;
 * requiring a bare identifier counted the second and third as icons, which
 * inflated shared-ui's ceiling by four buttons that render a day number or a
 * confirm label.
 */
function rendersText(body: string): boolean {
  const blanked = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/<[^>]*>/g, '\u0000');
  /** An operand that can only yield an element, nothing, or an empty string. */
  const yieldsNoWords = (operand: string): boolean =>
    /^[\s\u0000]*$/.test(operand) ||
    /^[\s]*(null|undefined|false|''|""|``)[\s]*$/.test(operand) ||
    /^[\s\u0000()]*$/.test(operand);
  for (const expr of blanked.match(/\{[^{}]*\}/g) ?? []) {
    const inner = expr.slice(1, -1).trim();
    if (inner === '') continue;
    const ternary = /^([^?]*)\?([^:]*):(.*)$/s.exec(inner);
    if (ternary) {
      if (yieldsNoWords(ternary[2] ?? '') && yieldsNoWords(ternary[3] ?? '')) continue;
      return true;
    }
    const guarded = /^(.*?)(?:&&|\|\|)(.*)$/s.exec(inner);
    if (guarded) {
      if (yieldsNoWords(guarded[2] ?? '')) continue;
      return true;
    }
    if (yieldsNoWords(inner)) continue;
    return true;
  }
  return blanked.replace(/\{[^{}]*\}/g, '').replace(/[\s\u0000]/g, '') !== '';
}

const NAMES_THE_CONTROL = /\baria-label\b|\baria-labelledby\b|\btitle=/;
const DECLARES_ITS_STATE = /\baria-pressed\b|\baria-selected\b|\baria-current\b/;
const PAINTS_A_STATE = /className=\{`[^`]*\$\{[^}]*\?|className=\{[^}]*\?[^}]*:/;

/**
 * FE-HIGH-158 — a button with no words in it and no accessible name. A screen
 * reader announces it as "button", whether it deletes a row, logs the operator
 * out or expands a table.
 */
function unnamedIconButtons(source: string): number {
  let count = 0;
  for (const { openTag, body } of buttonElements(source)) {
    if (!rendersText(body) && !NAMES_THE_CONTROL.test(openTag)) count += 1;
  }
  return count;
}

/**
 * FE-HIGH-159 — a button whose class attribute switches on a selected state
 * while its opening tag never declares that state. The selection is visible and
 * inaudible: colour alone, which WCAG 1.4.1 rejects.
 */
function silentStateButtons(source: string): number {
  let count = 0;
  for (const { openTag } of buttonElements(source)) {
    if (PAINTS_A_STATE.test(openTag) && !DECLARES_ITS_STATE.test(openTag)) count += 1;
  }
  return count;
}
/**
 * A class attribute that fixes `grid-cols-N` (N in 2–6 or 8–11) with no
 * breakpoint variant (FE-HIGH-088): on a 375 px phone the N columns share the
 * width and every cell wraps or overflows. Seven (a week) and twelve (a layout
 * grid whose children set `col-span`) are intentional and not counted; the
 * responsive shape is `grid-cols-1 sm:grid-cols-2 lg:grid-cols-N`. AquaMobil
 * is phone-first by construction and is not counted.
 */
/**
 * A user-visible string written in the file — JSX text between tags, or a
 * placeholder / title / aria-label / alt / label attribute — instead of a
 * message key through useI18n (FE-HIGH-089): the language then follows the
 * file, not the user. Counted per package, shared-ui included. The
 * SUPER_ADMIN panel (web/modules/admin-panel) is the declared English-only
 * surface and is not counted.
 */
const HARDCODED_JSX_TEXT = />\s*([^<>{};=]*[A-Za-zÇĞİŞÖÜçğışöü][^<>{};=]*?)\s*</g;
const HARDCODED_TEXT_ATTRIBUTE =
  /\b(?:placeholder|title|aria-label|alt|label)="([^"{}]*[A-Za-zÇĞİŞÖÜçğışöü][^"{}]*)"/g;
const DECLARED_ENGLISH_ONLY = ['web/modules/admin-panel'];
function hardcodedText(source: string): number {
  return (
    (source.match(HARDCODED_JSX_TEXT)?.length ?? 0) +
    (source.match(HARDCODED_TEXT_ATTRIBUTE)?.length ?? 0)
  );
}
const CLASS_ATTRIBUTE = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
const FIXED_GRID = /(?<![\w:-])grid-cols-(?:[2-6]|8|9|1[01])(?![\w-])/;
const RESPONSIVE_GRID = /\b(?:sm|md|lg|xl|2xl):grid-cols-/;
/**
 * An icon-shaped `<svg>` written in the file — a 16 / 20 / 24 unit viewBox,
 * the shape of a hand-pasted Heroicons or lucide glyph (FE-MEDIUM-082) —
 * beside the lucide-react set every package renders from. Counted per
 * package, shared-ui included; a custom glyph (a SCADA equipment symbol)
 * belongs in one shared icon module, not inline.
 */
const INLINE_ICON_SVG = /<svg\b[^>]*\bviewBox="0 0 (?:16 16|20 20|24 24)"/g;
function fixedGrids(source: string): number {
  let count = 0;
  for (const match of source.matchAll(CLASS_ATTRIBUTE)) {
    const value = match[1] ?? match[2] ?? '';
    if (FIXED_GRID.test(value) && !RESPONSIVE_GRID.test(value)) count += 1;
  }
  return count;
}
const MUTATION_WRAPPERS = ['web/modules/admin-panel/src/hooks/useAdminMutation.ts'];

/** A lucide loader icon spun unconditionally — shared-ui's Spinner is the loading indicator. */
const LOADER_ICON_SPINNER =
  /<(?:Loader2|LoaderCircle|Loader)\b[^>]*className="[^"]*\banimate-spin\b/g;
/** An inline `<svg>` spun unconditionally — the same arc Spinner draws. A conditional spin is an icon affordance. */
const SVG_SPINNER = /<svg\b[^>]*className="[^"]*\banimate-spin\b/g;
/** A className literal carrying `animate-spin`; a ring when it also draws a border or a circle. */
const CLASS_WITH_SPIN =
  /className=(?:"[^"]*\banimate-spin\b[^"]*"|'[^']*\banimate-spin\b[^']*'|\{`[^`]*\banimate-spin\b[^`]*`\})/g;
const RING = /\brounded-full\b|\bborder(?:-[tblrxy])?-\d\b/;

/** A page title written by hand — PageHeader renders the h1. */
const RAW_PAGE_TITLE =
  /<h1 className="[^"]*\b(?:text-2xl|text-xl|text-lg)\b[^"]*\bfont-(?:bold|semibold)\b[^"]*"/g;

/**
 * A string literal — one class attribute, one ternary branch, one map value.
 * A template that nests another (`${cond ? `…` : ''}`) is read as the chunks
 * between its backticks; the classes inside the nested one are still checked,
 * as their own literal.
 */
const STRING_LITERAL = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/g;
/**
 * A surface painted light: the one class that has to change for a dark theme
 * to exist. `.bg-white` is a selector (a query for such a surface), not a
 * surface; `after:bg-white` paints generated content (a toggle's knob, white
 * in both themes), not the element.
 */
const LIGHT_SURFACE =
  /(?<![.\w-])(?<!after:)(?<!before:)(?:bg-white|bg-gray-50|bg-gray-100|bg-(?:primary|secondary|accent|success|warning|error|info)-(?:50|100))\b/;
/** Every light gray/white class the strict form pairs (surfaces, text, borders, dividers, placeholders). */
const LIGHT_CLASS = /\b(?:bg-white|(?:bg|text|border|divide|placeholder)-gray-\d{2,3})\b/;
/** theme.css keys `dark:` on the shell's attribute — the one definition every entry imports. */
const DARK_VARIANT_DEFINITION =
  /@custom-variant dark \(&:where\(\[data-theme='dark'\], \[data-theme='dark'\] \*\)\);/;
/** shared-ui primitives a `theme="dark"` dialog is built from; held to the strict form. */
const DARK_AWARE_PRIMITIVES = [
  'web/shared-ui/src/components/DataTable/DataTable.tsx',
  'web/shared-ui/src/components/Modal/Modal.tsx',
  'web/shared-ui/src/components/Drawer/Drawer.tsx',
];

/** Comment lines out of the way: a class named in prose (`// no competing \`bg-white\``) is not painted. */
const COMMENT_LINE = /^[ \t]*(?:\/\/|\*|\/\*).*$/gm;

function lightOnlySurfaces(source: string): number {
  let hits = 0;
  for (const match of source.replace(COMMENT_LINE, '').matchAll(STRING_LITERAL)) {
    if (LIGHT_SURFACE.test(match[0]) && !match[0].includes('dark:')) hits += 1;
  }
  return hits;
}

function handRolledSpinners(source: string): number {
  let hits =
    (source.match(LOADER_ICON_SPINNER) ?? []).length + (source.match(SVG_SPINNER) ?? []).length;
  for (const match of source.matchAll(CLASS_WITH_SPIN)) {
    if (RING.test(match[0])) hits += 1;
  }
  return hits;
}
/**
 * FE-MEDIUM-067 counts STATIC inline style blocks: every value a string or
 * number literal, so the block could have been a utility class or a token. A
 * block that carries a runtime value (a progress bar's width, a colour read
 * from a record, a virtualiser's offset) is data reaching the DOM, not a token
 * bypass, and is not counted.
 */
const INLINE_STYLE_OPEN = 'style={{';
const LITERAL_VALUE = /^\s*(?:'[^'\n]*'|"[^"\n]*"|-?\d+(?:\.\d+)?)\s*$/;

function staticInlineStyleBlocks(source: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const open = source.indexOf(INLINE_STYLE_OPEN, from);
    if (open < 0) return count;
    let depth = 2;
    let cursor = open + INLINE_STYLE_OPEN.length;
    while (cursor < source.length && depth > 0) {
      const ch = source[cursor];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      cursor += 1;
    }
    const body = source.slice(open + INLINE_STYLE_OPEN.length, cursor - 2);
    if (isStaticStyleBody(body)) count += 1;
    from = cursor;
  }
}

/** `key: literal, key: literal` — no template, spread, call or identifier. */
function isStaticStyleBody(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed === '') return true;
  if (trimmed.includes('${') || trimmed.includes('...')) return false;
  const pairs: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of trimmed) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      pairs.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') pairs.push(current);
  return pairs.every((pair) => {
    const colon = pair.indexOf(':');
    if (colon < 0) return false;
    const key = pair.slice(0, colon);
    const value = pair.slice(colon + 1);
    return /^\s*[A-Za-z][A-Za-z0-9]*\s*$/.test(key) && LITERAL_VALUE.test(value);
  });
}

interface OverlayEntry {
  site: string;
  batch: 'dialog' | 'drawer' | 'mobile' | 'runtime';
  owner: string;
  expiry: string | Date;
  findingId: string;
  reason: string;
}

interface PackageCeiling {
  package: string;
  ceiling: number;
  owner: string;
  expiry: string | Date;
  findingId: string;
  reason: string;
}

interface Allowlist {
  version: number;
  overlays: { ceiling: number; entries: OverlayEntry[] };
  rawHex: { entries: PackageCeiling[] };
  rawPalette: { entries: PackageCeiling[] };
  inlineStyle: { entries: PackageCeiling[] };
  rawTable: { entries: PackageCeiling[] };
  rawMutation: { entries: PackageCeiling[] };
  rawButton: { entries: PackageCeiling[] };
  unnamedIconButton: { entries: PackageCeiling[] };
  silentStateButton: { entries: PackageCeiling[] };
  rawField: { entries: PackageCeiling[] };
  fixedGrid: { entries: PackageCeiling[] };
  inlineIconSvg: { entries: PackageCeiling[] };
  hardcodedText: { entries: PackageCeiling[] };
  rawSpinner: { entries: PackageCeiling[] };
  rawPageTitle: { entries: PackageCeiling[] };
  darkSurface: { entries: PackageCeiling[] };
}

/** Tracked source files under ROOTS, tests and generated code excluded (see admin-panel-data-layer.spec.ts on why not a `**` pathspec). */
function sourceFiles(roots: readonly string[] = ROOTS): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...roots], { encoding: 'utf8' })
    .split('\n')
    .filter(
      (file) =>
        (file.endsWith('.ts') || file.endsWith('.tsx')) &&
        !/__tests__/.test(file) &&
        !/\.(spec|test)\.tsx?$/.test(file) &&
        !file.includes('/generated/') &&
        !file.includes('/node_modules/'),
    );
}

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

/** `web/modules/<name>`, `web/shell`, `web/apps/<name>` or `web/shared-ui` — the unit a ceiling is granted to. */
function packageOf(file: string): string {
  const pkg = /^(web\/modules\/[^/]+|web\/shell|web\/apps\/[^/]+|web\/shared-ui)/.exec(file)?.[1];
  if (!pkg) throw new Error(`file outside a web package: ${file}`);
  return pkg;
}

function expiryIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

function countByPackage(
  files: string[],
  pattern: RegExp | ((source: string) => number),
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const source = read(file);
    const hits =
      typeof pattern === 'function' ? pattern(source) : (source.match(pattern)?.length ?? 0);
    if (hits === 0) continue;
    const pkg = packageOf(file);
    counts.set(pkg, (counts.get(pkg) ?? 0) + hits);
  }
  return counts;
}

function assertGoverned(
  entry: { owner: string; expiry: string | Date; findingId: string; reason: string },
  today: string,
): void {
  expect(entry.owner).toBeTruthy();
  expect(entry.findingId).toMatch(/^[A-Z]+-[A-Z]+-\d+$/);
  expect(entry.reason.length).toBeGreaterThan(20);
  expect(expiryIso(entry.expiry) > today).toBe(true);
}

describe('INVARIANT (FE-HIGH-065/077, FE-MEDIUM-067/070/071/072): web design-system adoption ratchet', () => {
  const files = sourceFiles();
  const doc = yaml.load(read(ALLOWLIST)) as Allowlist;
  const today = new Date().toISOString().slice(0, 10);

  it('sees the web tree', () => {
    // A path typo would otherwise make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(800);
    expect(files.some((f) => f.startsWith('web/modules/sensor-module/'))).toBe(true);
    expect(files.some((f) => f.startsWith('web/apps/aquamobil/'))).toBe(true);
  });

  it('ratchets every hand-rolled overlay — governed, live, and only shrinking (FE-HIGH-065)', () => {
    const actual = new Set(files.filter((file) => !isPrimitive(file) && OVERLAY.test(read(file))));
    const listed = new Set(doc.overlays.entries.map((entry) => entry.site));

    // A new overlay cannot ship outside shared-ui without being named here.
    expect([...actual].filter((file) => !listed.has(file)).sort()).toEqual([]);
    // A migrated file cannot stay listed to hold the ceiling up.
    expect([...listed].filter((file) => !actual.has(file)).sort()).toEqual([]);

    for (const entry of doc.overlays.entries) {
      expect(entry.batch).toMatch(/^(dialog|drawer|mobile|runtime)$/);
      assertGoverned(entry, today);
    }

    expect(actual.size).toBeLessThanOrEqual(doc.overlays.ceiling);
    expect(doc.overlays.entries.length).toBeLessThanOrEqual(doc.overlays.ceiling);
  });

  it('ratchets raw hex colours outside theme.css per package (FE-HIGH-066)', () => {
    const actual = countByPackage(
      [
        ...files,
        ...sourceFiles(['web/shared-ui/src']).filter((file) => file !== THEME_TOKEN_SOURCE),
      ],
      (source) =>
        source.replace(BLOCK_COMMENT, '').replace(COMMENT_LINE, '').match(RAW_HEX)?.length ?? 0,
    );
    const ceilings = new Map(doc.rawHex.entries.map((entry) => [entry.package, entry]));

    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      // A package with no ceiling must be at zero — the ceiling is the permission.
      expect(entry === undefined ? `${pkg}: ${count} raw hex, no ceiling` : '').toBe('');
      if (entry) expect({ pkg, count }).toEqual({ pkg, count: expect.any(Number) });
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} raw hex colours, ceiling ${entry.ceiling}. Use theme.css tokens (bg-primary-*, var(--color-*)) instead of raw values; lower the ceiling when you remove some.`,
        );
      }
    }
    for (const entry of doc.rawHex.entries) {
      assertGoverned(entry, today);
      // A ceiling above the live count is slack nobody earned: tighten it.
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets raw-palette colour utilities per package; shared-ui at zero (FE-HIGH-078)', () => {
    const actual = new Map<string, number>();
    for (const file of [...files, ...sourceFiles(['web/shared-ui/src'])]) {
      const hits = read(file).replace(COMMENT_LINE, '').match(RAW_PALETTE)?.length ?? 0;
      if (hits === 0) continue;
      const pkg = packageOf(file);
      actual.set(pkg, (actual.get(pkg) ?? 0) + hits);
    }
    const ceilings = new Map(doc.rawPalette.entries.map((entry) => [entry.package, entry]));
    // The primitives are the design system: no ceiling is ever granted to shared-ui.
    expect(ceilings.has('web/shared-ui')).toBe(false);

    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} raw-palette utilities, no ceiling` : '').toBe(
        '',
      );
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} raw-palette colour utilities, ceiling ${entry.ceiling}. Paint from the theme scales (bg-primary-*, text-error-*, border-warning-*) or through a shared-ui primitive; lower the ceiling when you remove some.`,
        );
      }
    }
    for (const entry of doc.rawPalette.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets hand-rolled <table> elements per package (FE-HIGH-069)', () => {
    const actual = countByPackage(files, RAW_TABLE);
    const ceilings = new Map(doc.rawTable.entries.map((entry) => [entry.package, entry]));

    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} raw tables, no ceiling` : '').toBe('');
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} hand-rolled <table> elements, ceiling ${entry.ceiling}. Render lists through shared-ui DataTable; lower the ceiling when you migrate one.`,
        );
      }
    }
    for (const entry of doc.rawTable.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets direct useMutation calls per package — feedback belongs to the hook layer (FE-HIGH-086)', () => {
    const actual = countByPackage(
      files.filter((file) => !file.startsWith('web/apps/') && !MUTATION_WRAPPERS.includes(file)),
      RAW_MUTATION,
    );
    const ceilings = new Map(doc.rawMutation.entries.map((entry) => [entry.package, entry]));

    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(
        entry === undefined ? `${pkg}: ${count} direct useMutation calls, no ceiling` : '',
      ).toBe('');
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} direct useMutation calls, ceiling ${entry.ceiling}. Declare the outcome through useFeedbackMutation({ feedback: { success, error? } }) (admin-panel: useAdminMutation feedback) and lower the ceiling when you migrate one.`,
        );
      }
    }
    for (const entry of doc.rawMutation.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets raw <button> elements per package (FE-HIGH-079)', () => {
    const actual = countByPackage(
      files.filter((file) => !isPrimitive(file)),
      RAW_BUTTON,
    );
    const ceilings = new Map(doc.rawButton.entries.map((entry) => [entry.package, entry]));
    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} raw buttons, no ceiling` : '').toBe('');
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} raw <button> elements, ceiling ${entry.ceiling}. Render through shared-ui Button (AquaMobil: Button / IconButton) and lower the ceiling when you migrate one.`,
        );
      }
    }
    for (const entry of doc.rawButton.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets buttons with no words and no accessible name per package (FE-HIGH-158)', () => {
    // shared-ui is included, unlike the rawButton ratchet above, which reads
    // ROOTS alone. A primitive is allowed to render a raw <button>; it is not
    // allowed to render one a screen reader cannot name, because every consumer
    // inherits that name — or its absence.
    const actual = countByPackage(
      [...files, ...sourceFiles(['web/shared-ui/src'])],
      unnamedIconButtons,
    );
    const ceilings = new Map(doc.unnamedIconButton.entries.map((entry) => [entry.package, entry]));
    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} unnamed icon buttons, no ceiling` : '').toBe(
        '',
      );
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} buttons with no text and no accessible name, ceiling ${entry.ceiling}. Give the control a name (aria-label from useI18n, or aria-labelledby pointing at visible text) and lower the ceiling when you fix one.`,
        );
      }
    }
    for (const entry of doc.unnamedIconButton.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets buttons that paint a state without declaring it per package (FE-HIGH-159)', () => {
    const actual = countByPackage(
      [...files, ...sourceFiles(['web/shared-ui/src'])],
      silentStateButtons,
    );
    const ceilings = new Map(doc.silentStateButton.entries.map((entry) => [entry.package, entry]));
    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} silent state buttons, no ceiling` : '').toBe(
        '',
      );
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} buttons whose class switches on a selected state with no aria-pressed / aria-selected / aria-current, ceiling ${entry.ceiling}. Declare the state on the same prop that paints it and lower the ceiling when you fix one.`,
        );
      }
    }
    for (const entry of doc.silentStateButton.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets grids fixed at N columns for every viewport per package (FE-HIGH-088)', () => {
    const actual = countByPackage(
      files.filter((file) => !file.startsWith('web/apps/')),
      fixedGrids,
    );
    const ceilings = new Map(doc.fixedGrid.entries.map((entry) => [entry.package, entry]));
    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} fixed grids, no ceiling` : '').toBe('');
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} grids fixed at N columns with no breakpoint variant, ceiling ${entry.ceiling}. Give the grid a phone shape (grid-cols-1 sm:grid-cols-2 lg:grid-cols-N) and lower the ceiling when you migrate one.`,
        );
      }
    }
    for (const entry of doc.fixedGrid.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets icon-shaped <svg> written in the file per package, shared-ui included (FE-MEDIUM-082)', () => {
    const actual = countByPackage(
      [...files, ...sourceFiles(['web/shared-ui/src'])].filter((file) => file.endsWith('.tsx')),
      INLINE_ICON_SVG,
    );
    const ceilings = new Map(doc.inlineIconSvg.entries.map((entry) => [entry.package, entry]));
    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} inline icon svgs, no ceiling` : '').toBe('');
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} icon-shaped <svg> written in the file, ceiling ${entry.ceiling}. Render the icon from lucide-react (a custom glyph from one shared icon module) and lower the ceiling when you migrate one.`,
        );
      }
    }
    for (const entry of doc.inlineIconSvg.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets user-visible strings written in the file per package, shared-ui included (FE-HIGH-089)', () => {
    const actual = countByPackage(
      [...files, ...sourceFiles(['web/shared-ui/src'])].filter(
        (file) =>
          file.endsWith('.tsx') && !DECLARED_ENGLISH_ONLY.some((pkg) => file.startsWith(`${pkg}/`)),
      ),
      hardcodedText,
    );
    const ceilings = new Map(doc.hardcodedText.entries.map((entry) => [entry.package, entry]));
    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} hardcoded strings, no ceiling` : '').toBe('');
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} user-visible strings written in the file, ceiling ${entry.ceiling}. Add a message key to shared-ui's locales (AquaMobil: its own), render it through useI18n().t and lower the ceiling when you migrate one.`,
        );
      }
    }
    for (const entry of doc.hardcodedText.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets raw <input>, <select> and <textarea> elements per package (FE-HIGH-079)', () => {
    const actual = countByPackage(
      files.filter((file) => !isPrimitive(file)),
      RAW_FIELD,
    );
    const ceilings = new Map(doc.rawField.entries.map((entry) => [entry.package, entry]));
    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} raw fields, no ceiling` : '').toBe('');
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} raw form controls, ceiling ${entry.ceiling}. Render through shared-ui Input / Select / Textarea / Checkbox (AquaMobil: Field) and lower the ceiling when you migrate one.`,
        );
      }
    }
    for (const entry of doc.rawField.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('never answers a required-field miss with a toast (FE-HIGH-086)', () => {
    // farm validated 22 required fields through toasts ("Please enter a
    // name.") while the form kept no error state; a miss belongs on the
    // field, as FormField error. A single-field or ||-combined empty check
    // that opens a toast is that defect exactly.
    const REQUIRED_FIELD_TOAST = /if \(!formData\.\w+(?: \|\| !formData\.\w+)*\) \{\s*toast\(/g;
    const offenders = files
      .filter((file) => !file.startsWith('web/apps/'))
      .flatMap((file) => (read(file).match(REQUIRED_FIELD_TOAST) ?? []).map(() => file));
    expect(offenders).toEqual([]);
  });

  it('ratchets hand-rolled loading spinners per package (FE-MEDIUM-070)', () => {
    const actual = new Map<string, number>();
    for (const file of files) {
      if (isPrimitive(file)) continue;
      const hits = handRolledSpinners(read(file));
      if (hits === 0) continue;
      const pkg = packageOf(file);
      actual.set(pkg, (actual.get(pkg) ?? 0) + hits);
    }
    const ceilings = new Map(doc.rawSpinner.entries.map((entry) => [entry.package, entry]));

    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} hand-rolled spinners, no ceiling` : '').toBe(
        '',
      );
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} hand-rolled spinners, ceiling ${entry.ceiling}. Render loading through shared-ui Spinner (aquamobil: components/ui/Spinner); lower the ceiling when you migrate one.`,
        );
      }
    }
    for (const entry of doc.rawSpinner.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets hand-written page titles per package (FE-MEDIUM-071)', () => {
    const actual = countByPackage(
      files.filter((file) => !isPrimitive(file)),
      RAW_PAGE_TITLE,
    );
    const ceilings = new Map(doc.rawPageTitle.entries.map((entry) => [entry.package, entry]));

    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(
        entry === undefined ? `${pkg}: ${count} hand-written page titles, no ceiling` : '',
      ).toBe('');
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} hand-written page titles, ceiling ${entry.ceiling}. Open the page with shared-ui PageHeader (title, description, actions, eyebrow, leading); lower the ceiling when you migrate one.`,
        );
      }
    }
    for (const entry of doc.rawPageTitle.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('keys dark: on the shell theme and holds the dark-aware primitives to the strict form (FE-MEDIUM-072)', () => {
    expect(read('web/shared-ui/src/styles/theme.css')).toMatch(DARK_VARIANT_DEFINITION);
    for (const file of DARK_AWARE_PRIMITIVES) {
      const unpaired = [...read(file).replace(COMMENT_LINE, '').matchAll(STRING_LITERAL)]
        .map((match) => match[0])
        .filter((literal) => LIGHT_CLASS.test(literal) && !literal.includes('dark:'));
      expect(unpaired.length === 0 ? '' : `${file}: ${unpaired.join(' | ')}`).toBe('');
    }
  });

  it('ratchets light-only surfaces per package, shared-ui included (FE-MEDIUM-072)', () => {
    const actual = new Map<string, number>();
    for (const file of [...files, ...sourceFiles(['web/shared-ui/src'])]) {
      const hits = lightOnlySurfaces(read(file));
      if (hits === 0) continue;
      const pkg = packageOf(file);
      actual.set(pkg, (actual.get(pkg) ?? 0) + hits);
    }
    const ceilings = new Map(doc.darkSurface.entries.map((entry) => [entry.package, entry]));

    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} light-only surfaces, no ceiling` : '').toBe(
        '',
      );
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} light-only surfaces, ceiling ${entry.ceiling}. Pair every bg-white / bg-gray-50 / bg-gray-100 with a dark: class (theme.css keys it on the shell's data-theme); lower the ceiling when you pair some.`,
        );
      }
    }
    for (const entry of doc.darkSurface.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets static inline style={{}} blocks per package (FE-MEDIUM-067)', () => {
    const actual = new Map<string, number>();
    for (const file of files) {
      const hits = staticInlineStyleBlocks(read(file));
      if (hits === 0) continue;
      const pkg = packageOf(file);
      actual.set(pkg, (actual.get(pkg) ?? 0) + hits);
    }
    const ceilings = new Map(doc.inlineStyle.entries.map((entry) => [entry.package, entry]));

    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} inline styles, no ceiling` : '').toBe('');
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} static inline style blocks, ceiling ${entry.ceiling}. Every value is a literal, so it is a utility class or a token; lower the ceiling when you remove some.`,
        );
      }
    }
    for (const entry of doc.inlineStyle.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });
});
