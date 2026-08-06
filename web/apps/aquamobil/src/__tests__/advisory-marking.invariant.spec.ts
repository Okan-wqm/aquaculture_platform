/**
 * Advisory-marking invariant (ORPHAN-MEDIUM-589) — Tier 3.
 *
 * WHY. Before v4 the AI cards were distinguished from measured data by
 * purple/indigo chrome. v4 has no purple token — teal is reserved for actions
 * and the gradients went for sunlight contrast — so the conversion necessarily
 * removed the only signal these cards carried.
 *
 * That is most dangerous on the unit detail, where the three AI cards now sit
 * directly beneath LiveReadingsCard's MEASURED sensor values with nothing but a
 * heading between them. A worker acting on a 30-day forecast believing it is a
 * reading is the failure this prevents.
 *
 * The marker is deliberately NOT colour: a colourblind worker must read the
 * same thing everyone else does. So every card in src/components/ai/ must carry
 * BOTH — the chip labels the card, the tilde labels the number, and a numeral
 * screenshotted or read aloud away from its card still carries its own caveat.
 *
 * This is a BAN, not a ratchet. All four cards comply today; a fifth added
 * without marking fails the build rather than shipping an estimate that looks
 * like a measurement.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const AI_DIR = resolve(__dirname, '../components/ai');

/** The cards themselves — not the marker primitives or the barrel. */
function advisoryCards(): string[] {
  return readdirSync(AI_DIR).filter(
    (f) => /\.tsx$/.test(f) && f !== 'AdvisoryChip.tsx' && !f.startsWith('index'),
  );
}

describe('advisory-marking invariant', () => {
  it('finds the AI cards it is meant to guard', () => {
    // A gate that silently guards nothing is worse than no gate: if this
    // directory is ever restructured, fail loudly rather than pass vacuously.
    expect(advisoryCards().length).toBeGreaterThanOrEqual(4);
  });

  it.each(advisoryCards())('%s labels itself as advisory', (file) => {
    const source = readFileSync(join(AI_DIR, file), 'utf8');
    expect(
      source.includes('<AdvisoryChip'),
      `${file} renders model output without an <AdvisoryChip/>. Its only pre-v4 ` +
        'signal was purple chrome, which the token system removed — on the unit detail ' +
        'these cards sit directly under measured sensor values.',
    ).toBe(true);
  });

  it.each(advisoryCards())('%s marks its predicted numerals with a tilde', (file) => {
    const source = readFileSync(join(AI_DIR, file), 'utf8');
    expect(
      source.includes('<Approx'),
      `${file} shows a model's number with no <Approx/> tilde. The chip labels the card, ` +
        'but a numeral read aloud or screenshotted on its own must carry its own caveat.',
    ).toBe(true);
  });

  it('keeps the marker non-colour, so it survives colourblindness and greyscale', () => {
    const chip = readFileSync(join(AI_DIR, 'AdvisoryChip.tsx'), 'utf8');
    expect(chip, 'the chip must say a word, not just be a colour').toMatch(/>\s*Advisory\s*</);
    expect(chip, 'the tilde must be a literal character').toContain('~');
    // Neither may lean on the accent or a status hue to carry the meaning.
    expect(chip).not.toMatch(/text-acc\b|bg-acc\b|text-warn\b|text-crit\b/);
  });
});
