/**
 * Design-token invariant — Tier-3 "make it detectable".
 *
 * The v4 redesign replaces hand-written `dark:` variants and raw Tailwind
 * palettes with ONE semantic token layer (src/styles/tokens.css) surfaced as
 * Tailwind utilities (`bg-surface-1`, `text-ink-2`, `border-line`, `bg-acc`).
 * That only stays true if the old way cannot creep back, so this spec enforces:
 *
 *   1. THEME PARITY — every token declared for `night` also exists for `day`
 *      and `colour`. A token missing from one theme renders as an invalid value
 *      (transparent text, no background) only in that theme — the exact class
 *      of bug nobody catches until a user switches theme in the field.
 *   2. RATCHETS — `dark:` variants, legacy brand palettes and stock gray ramps
 *      are frozen at their current counts and may only SHRINK. New code uses
 *      tokens; migrated pages drive the numbers down. When a ratchet reaches
 *      zero its escape hatch is deleted (the `darkMode: 'class'` bridge, the
 *      legacy palette block in tailwind.config.js).
 *   3. OFFLINE TYPOGRAPHY — no font may be loaded from a CDN. AquaMobil is
 *      offline-first; a remote font drops out precisely when the worker is in
 *      the field, which is the case the whole app exists for.
 *   4. FOUC PARITY — the inline script in index.html and src/hooks/useTheme.ts
 *      must agree on storage key, theme vocabulary and DOM effects, or the app
 *      paints one theme then snaps to another on hydration.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

const SRC_DIR = resolve(__dirname, '..');
const APP_DIR = resolve(__dirname, '../..');

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'generated') continue;
      walkSources(full, out);
    } else if (/\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function countOccurrences(pattern: RegExp): number {
  let count = 0;
  for (const file of walkSources(SRC_DIR)) {
    count += readFileSync(file, 'utf8').match(pattern)?.length ?? 0;
  }
  return count;
}

/**
 * RATCHET BASELINES, measured at the v4 token layer's introduction.
 * Shrink freely — lower the constant in the same commit that reduces the count.
 * Growing one means new code took the pre-v4 path; use the tokens instead.
 */
const DARK_VARIANT_BASELINE = 1312;
const LEGACY_PALETTE_BASELINE = 332;
const STOCK_GRAY_BASELINE = 1481;

const TOKENS_CSS = readFileSync(join(SRC_DIR, 'styles/tokens.css'), 'utf8');

/** Extracts the `--name` custom properties declared inside one selector block. */
function tokensDeclaredIn(selector: string): Set<string> {
  // Match the block that STARTS with this selector line, up to the closing brace.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g').exec(TOKENS_CSS);
  if (!block) return new Set();
  return new Set(Array.from(block[1].matchAll(/(--[a-z0-9-]+)\s*:/g), (m) => m[1]));
}

describe('design-token invariant (AquaMobil v4)', () => {
  it('declares every theme token in all three themes', () => {
    // `night` is the default and therefore the vocabulary of record.
    const night = tokensDeclaredIn("[data-theme='night']");
    const day = tokensDeclaredIn("[data-theme='day']");
    const colour = tokensDeclaredIn("[data-theme='colour']");

    expect(night.size, 'the night theme block was not found or is empty').toBeGreaterThan(20);

    const missingInDay = [...night].filter((t) => !day.has(t));
    const missingInColour = [...night].filter((t) => !colour.has(t));

    expect(
      missingInDay,
      `tokens declared for night but missing from the day theme:\n${missingInDay.join('\n')}`,
    ).toEqual([]);
    expect(
      missingInColour,
      `tokens declared for night but missing from the colour theme:\n${missingInColour.join('\n')}`,
    ).toEqual([]);
  });

  it('declares every touch-density token in both densities', () => {
    const standard = tokensDeclaredIn("[data-density='standard']");
    const glove = tokensDeclaredIn("[data-density='glove']");

    expect(standard.size, 'the standard density block was not found').toBeGreaterThan(5);
    const missing = [...standard].filter((t) => !glove.has(t));
    expect(
      missing,
      `density tokens with no glove value — controls would not grow:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('ratchets `dark:` variants — shrink only, never grow', () => {
    const current = countOccurrences(/\bdark:/g);
    expect(
      current,
      `\`dark:\` variants grew past the frozen baseline (${DARK_VARIANT_BASELINE}). ` +
        'Use the semantic tokens (bg-surface-1, text-ink-2, border-line) — they resolve ' +
        'per theme, so a second class is never needed.',
    ).toBeLessThanOrEqual(DARK_VARIANT_BASELINE);
  });

  it('ratchets the legacy brand palettes — shrink only, never grow', () => {
    const current = countOccurrences(
      /\b(?:ocean|sea|coral|mortality|cull|harvest)-(?:50|[1-9]00|950)\b/g,
    );
    expect(
      current,
      `legacy palette usage grew past the frozen baseline (${LEGACY_PALETTE_BASELINE}). ` +
        'ocean-* is bg-acc, the status palettes are text-type-mortality/-cull/-harvest.',
    ).toBeLessThanOrEqual(LEGACY_PALETTE_BASELINE);
  });

  it('ratchets stock gray ramps — shrink only, never grow', () => {
    const current = countOccurrences(
      /\b(?:bg|text|border|from|to|via|ring|divide)-(?:gray|slate|zinc|neutral)-\d{2,3}\b/g,
    );
    expect(
      current,
      `stock gray usage grew past the frozen baseline (${STOCK_GRAY_BASELINE}). ` +
        'Surfaces are bg-surface-0/1/2/3, text is text-ink-1/2/3, dividers are border-line.',
    ).toBeLessThanOrEqual(STOCK_GRAY_BASELINE);
  });

  it('loads no font from a CDN — offline-first typography', () => {
    // A remote @import or <link> means the type falls back to a system font the
    // moment the worker loses signal, which is the app's normal operating state.
    const css = readFileSync(join(SRC_DIR, 'styles/main.css'), 'utf8') + TOKENS_CSS;
    const html = readFileSync(join(APP_DIR, 'index.html'), 'utf8');

    expect(css, 'main.css/tokens.css pulls a font over the network').not.toMatch(
      /@import\s+url\(\s*['"]?https?:/i,
    );
    for (const source of [css, html]) {
      expect(source, 'a font is referenced from a CDN host').not.toMatch(
        /fonts\.(?:googleapis|gstatic)\.com/i,
      );
    }
    // …and the self-hosted faces must actually be declared.
    expect(TOKENS_CSS).toMatch(/@font-face/);
    expect(TOKENS_CSS).toMatch(/\/mobile\/fonts\/geist-latin\.woff2/);
    // latin-ext carries the Turkish glyph set and the default locale is Turkish.
    expect(TOKENS_CSS, 'latin-ext subset missing — Turkish glyphs would fall back').toMatch(
      /geist-latin-ext\.woff2/,
    );
  });

  it('keeps the anti-FOUC script in step with useTheme', () => {
    const html = readFileSync(join(APP_DIR, 'index.html'), 'utf8');
    const hook = readFileSync(join(SRC_DIR, 'hooks/useTheme.ts'), 'utf8');
    const density = readFileSync(join(SRC_DIR, 'hooks/useDensity.ts'), 'utf8');

    // Same storage keys, or the inline script paints a theme the hook then changes.
    for (const key of ['aquamobil_dark_mode', 'aquamobil_touch_density']) {
      expect(html, `index.html does not read ${key}`).toContain(key);
    }
    expect(hook).toContain('aquamobil_dark_mode');
    expect(density).toContain('aquamobil_touch_density');

    // Same vocabulary, including the pre-v4 migration both sides must perform.
    for (const theme of ['night', 'day', 'colour']) {
      expect(html, `index.html does not know the '${theme}' theme`).toContain(`'${theme}'`);
    }

    // Same DOM effects: the attribute the tokens select on, plus the `.dark`
    // migration bridge that Konsta and unmigrated pages still depend on.
    for (const source of [html, hook]) {
      expect(source).toContain('data-theme');
      expect(source).toContain('dark');
    }
    expect(html).toContain('data-density');
    expect(density).toContain('data-density');
  });
});
