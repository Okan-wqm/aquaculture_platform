/**
 * INVARIANT: the tenant console stays legible in both themes.
 *
 * The console sheet is ~1058 lines of rules that read only `--color-sd-*`, so
 * one token redefinition under `[data-theme='dark']` gives the whole surface a
 * dark mode. That leverage cuts both ways: a single token edited to the wrong
 * value silently changes the contrast of every card, table and badge at once,
 * and nothing else would catch it. `darkSurface` counts TAILWIND light classes
 * with no `dark:` sibling — these are plain CSS classes, so that ratchet is
 * blind to them by construction (FE-HIGH-167).
 *
 * So the ratios are asserted here, read from theme.css rather than restated:
 * a copy of the palette in the test would drift from the stylesheet and assert
 * that the copy is fine.
 *
 * The bar is WCAG AA (4.5:1) for text that carries meaning. `ink-faint`,
 * `ink-hint`, `ink-hint-soft` and `ink-disabled` are deliberately excluded:
 * they are decorative in the approved light design too, where they sit at
 * 1.6–2.5:1, and holding dark to a bar light never met would be inventing a
 * requirement rather than preserving one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const THEME_CSS = path.join(__dirname, '..', '..', 'web/shared-ui/src/styles/theme.css');

/** WCAG relative luminance of an `#rrggbb` colour. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (offset: number): number => {
    const c = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/**
 * The `--color-sd-*` values in force for a theme: the `@theme` block's, with
 * the `[data-theme='dark']` block's applied on top when dark is asked for.
 */
function palette(theme: 'light' | 'dark'): Map<string, string> {
  const css = fs.readFileSync(THEME_CSS, 'utf8');
  const darkStart = css.indexOf("[data-theme='dark'] {");
  expect(darkStart).toBeGreaterThan(-1);
  const darkEnd = css.indexOf('\n}', darkStart);
  const darkBlock = css.slice(darkStart, darkEnd);

  const read = (source: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [, name, value] of source.matchAll(
      /--color-(sd-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g,
    )) {
      if (name && value) out.set(name, value);
    }
    return out;
  };

  // The base values live outside the dark block; dark overrides them.
  const base = read(css.slice(0, darkStart) + css.slice(darkEnd));
  if (theme === 'light') return base;
  for (const [name, value] of read(darkBlock)) base.set(name, value);
  return base;
}

/** Text tokens that carry meaning, so must clear AA on the page surfaces. */
const MEANINGFUL_TEXT: readonly string[] = [
  'sd-ink',
  'sd-ink-body',
  'sd-ink-soft',
  'sd-mint-ink',
  'sd-teal',
  'sd-teal-deep',
  'sd-teal-mid',
  'sd-danger-ink',
  'sd-amber-ink',
  'sd-violet-ink',
];

const SURFACES: readonly string[] = ['sd-paper', 'sd-parchment', 'sd-paper-lit'];
const AA = 4.5;

describe.each(['light', 'dark'] as const)('SUDERRA console contrast (%s)', (theme) => {
  const tokens = palette(theme);

  it('defines every surface and text token this theme needs', () => {
    for (const name of [...SURFACES, ...MEANINGFUL_TEXT]) {
      expect(tokens.get(name)).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('holds AA for meaningful text on every page surface', () => {
    const failures: string[] = [];
    for (const surface of SURFACES) {
      const bg = tokens.get(surface);
      if (!bg) continue;
      for (const text of MEANINGFUL_TEXT) {
        const fg = tokens.get(text);
        if (!fg) continue;
        const ratio = contrast(fg, bg);
        if (ratio < AA) failures.push(`${text} on ${surface}: ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps the two themes genuinely different, so the switch does something', () => {
    // A dark block that forgot a surface would read as light here and the page
    // would be half-themed — the exact failure this whole block exists to stop.
    const other = palette(theme === 'light' ? 'dark' : 'light');
    for (const surface of SURFACES) {
      expect(tokens.get(surface)).not.toBe(other.get(surface));
    }
  });
});
