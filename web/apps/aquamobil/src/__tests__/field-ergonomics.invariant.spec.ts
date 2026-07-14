/**
 * Field-ergonomics invariant (MOB-MEDIUM-009) — Tier-3 "make it detectable".
 *
 * AquaMobil is used outdoors, with gloves, in sunlight. Two mechanical rules
 * keep the UI operable in those conditions, enforced as a RATCHET over the
 * source (the repo's invariant-spec idiom — see the dead-contract gate):
 *
 *   1. TOUCH FLOOR — the Tailwind config must declare the 44px `touch`
 *      spacing token, and the shared header icon buttons (the highest-traffic
 *      small targets) must carry `min-h-touch min-w-touch`.
 *   2. TINY TEXT — `text-[9px]` (and smaller) is banned outright: at arm's
 *      length in sunlight it is unreadable. The 10–11px arbitrary sizes are
 *      frozen at their current count and may only SHRINK — a new sub-12px
 *      label fails this gate instead of quietly degrading readability.
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
    const source = readFileSync(file, 'utf8');
    count += source.match(pattern)?.length ?? 0;
  }
  return count;
}

/**
 * RATCHET BASELINE for 10–11px arbitrary text (86 at introduction, 2026-07-12
 * — badge counters, KPI sublabels, tab captions). Shrink freely; never grow.
 * If you legitimately reduced occurrences, lower this number in the same
 * commit. Adding a new sub-12px label is a failing build by design.
 */
const TINY_TEXT_BASELINE = 86;

describe('field-ergonomics invariant (MOB-MEDIUM-009)', () => {
  it('declares the 44px touch spacing token in the Tailwind config', () => {
    const config = readFileSync(join(APP_DIR, 'tailwind.config.js'), 'utf8');
    expect(config).toMatch(/touch:\s*'2\.75rem'/);
  });

  it('shared header icon buttons carry the touch floor', () => {
    for (const component of [
      'components/NotificationBell.tsx',
      'components/AlertsBell.tsx',
    ]) {
      const source = readFileSync(join(SRC_DIR, component), 'utf8');
      expect(source, `${component} lost its touch floor`).toContain('min-h-touch');
      expect(source, `${component} lost its touch floor`).toContain('min-w-touch');
    }
  });

  it('bans sub-10px text outright', () => {
    expect(countOccurrences(/text-\[[0-9](?:px|\.[0-9]+px)\]/g)).toBe(0);
  });

  it('bans sub-75% white text on gradient headers (sunlight contrast floor)', () => {
    // text-white/70 and lower is unreadable outdoors on the ocean-gradient
    // headers; 75% is the floor (MOB-MEDIUM-009 outdoor-readability pass —
    // the audit's flagged /70s were raised to /85, the /40-/60s to /75).
    expect(countOccurrences(/text-white\/(?:[1-6][0-9]|7[0-4])\b/g)).toBe(0);
  });

  it('ratchets 10–11px arbitrary text — shrink only, never grow', () => {
    const current = countOccurrences(/text-\[1[01]px\]/g);
    expect(
      current,
      `text-[10px]/text-[11px] occurrences grew from the frozen baseline (${TINY_TEXT_BASELINE}). ` +
        'Use text-xs (12px) or larger for new labels — sunlight readability floor.',
    ).toBeLessThanOrEqual(TINY_TEXT_BASELINE);
  });

  it('ships the IconButton touch-floor primitive with the 44px floor baked in', () => {
    // Tier-2 "make it automatic": the zero-effort correct path for any icon/compact
    // tap target. It must carry the floor, the touch affordance and a focus ring so
    // every adopter inherits an operable-with-gloves target for free.
    const iconButton = readFileSync(join(SRC_DIR, 'components/ui/IconButton.tsx'), 'utf8');
    expect(iconButton).toContain('min-h-touch');
    expect(iconButton).toContain('min-w-touch');
    expect(iconButton).toContain('touch-feedback');
  });

  it('bans a sub-44px touch target — no touch-feedback element declares min-h/min-w below the floor', () => {
    // Precise, per-line: only elements marked with the interactive `touch-feedback`
    // affordance are held to the floor, so decorative count badges (min-w-[16px] on a
    // <span>, no touch-feedback) are correctly untouched. A sub-floor tap target must
    // adopt IconButton (or min-h-touch min-w-touch) instead.
    const SUB_44 = /min-[hw]-\[(?:[0-9]|[1-3][0-9]|4[0-3])px\]/;
    const offenders: string[] = [];
    for (const file of walkSources(SRC_DIR)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes('touch-feedback') && SUB_44.test(line)) {
            offenders.push(`${file.replace(SRC_DIR, 'src')}:${i + 1}`);
          }
        });
    }
    expect(
      offenders,
      `touch targets below the 44px floor — use IconButton (min-h-touch min-w-touch):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
