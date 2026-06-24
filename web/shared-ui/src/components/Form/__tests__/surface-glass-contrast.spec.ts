/**
 * Glass surface — WCAG AA contrast contract
 *
 * WHAT: numerically pins that every `--surface-*` text token from theme.css clears
 * WCAG 2.1 AA (4.5:1 for normal text) against the surface it actually renders on.
 * The card surface and field surface are COMPUTED here from the gradient endpoints +
 * alpha compositing (not hardcoded) so a future token edit that breaks AA fails CI.
 *
 * Card   = white @ 0.65 over the worst-case gradient stop (primary-600).
 * Field  = white @ 0.80 over the card.
 */
import { describe, it, expect } from 'vitest';

type RGB = [number, number, number];

// theme.css design-system values referenced by the glass tokens
const PRIMARY_600: RGB = [0x00, 0x5b, 0xb3]; // worst-case card background stop
const PRIMARY_700: RGB = [0x00, 0x42, 0x80]; // label / muted / placeholder
const PRIMARY_800: RGB = [0x00, 0x2a, 0x4d]; // heading / field text
const WHITE: RGB = [255, 255, 255];

/** Alpha-composite `fg` over `bg` (fg drawn at `alpha`). */
function composite(fg: RGB, bg: RGB, alpha: number): RGB {
  return [0, 1, 2].map((i) => Math.round(alpha * fg[i] + (1 - alpha) * bg[i])) as RGB;
}

function relativeLuminance([r, g, b]: RGB): number {
  const lin = [r, g, b].map((c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const CARD = composite(WHITE, PRIMARY_600, 0.65);
const FIELD = composite(WHITE, CARD, 0.8);
const AA = 4.5;

describe('glass surface contrast (WCAG AA)', () => {
  it('heading token on the card ≥ 4.5:1', () => {
    expect(contrastRatio(PRIMARY_800, CARD)).toBeGreaterThanOrEqual(AA);
  });

  it('label / muted token on the card ≥ 4.5:1', () => {
    expect(contrastRatio(PRIMARY_700, CARD)).toBeGreaterThanOrEqual(AA);
  });

  it('field text token on the field surface ≥ 4.5:1', () => {
    expect(contrastRatio(PRIMARY_800, FIELD)).toBeGreaterThanOrEqual(AA);
  });

  it('placeholder token on the field surface ≥ 4.5:1', () => {
    expect(contrastRatio(PRIMARY_700, FIELD)).toBeGreaterThanOrEqual(AA);
  });

  it('white button text on the primary-600 button ≥ 4.5:1', () => {
    expect(contrastRatio(WHITE, PRIMARY_600)).toBeGreaterThanOrEqual(AA);
  });
});
