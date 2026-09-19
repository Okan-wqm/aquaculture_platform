/**
 * The domain scales' contract (FE-MEDIUM-093).
 *
 * # Why this exists
 *
 * Moving the platform's colours onto the design tokens is mostly mechanical —
 * `#dc2626` is `error[600]`, and the bytes do not change. It stops being
 * mechanical the moment the literal belongs to a DOMAIN SCALE: a pH ramp, one
 * colour per reagent. Those are not intents, and the semantic scales cannot
 * express them — the palette carries four hues plus a coral accent, so a
 * ten-step red-to-violet ramp folds back onto coral and brown at the top, and
 * a nine-member reagent set collapses onto two near-black greens.
 *
 * That is exactly what happened: the pH 7.0 and 7.25 isolines were aliased
 * onto `warning[500]`, which is also the stroke the Deffeyes chart paints the
 * reagent dosing line with, so a reference line behind the chart and the
 * answer the operator is reading off it became the same colour.
 *
 * So the scales are declared once, ordered, in the token module, and these
 * are the properties that make them usable. A future "tokenisation" that
 * flattens one of them fails here instead of on a farm.
 */
import { chartPalette, colors, domainScale, sequentialColor } from '../design/color-tokens';

/**
 * How far apart two colours have to look. Weighted-RGB ("redmean") distance —
 * cheap, no colour-space dependency, and monotonic enough for "can an
 * operator tell these two lines apart at a glance".
 */
function separation(a: string, b: string): number {
  const channels = (hex: string): [number, number, number] => {
    const v = hex.replace('#', '');
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  const mean = (r1 + r2) / 2;
  return Math.sqrt(
    (2 + mean / 256) * (r1 - r2) ** 2 +
      4 * (g1 - g2) ** 2 +
      (2 + (255 - mean) / 256) * (b1 - b2) ** 2,
  );
}

function closestPair(values: readonly string[]): { gap: number; pair: [string, string] } {
  let gap = Number.POSITIVE_INFINITY;
  let pair: [string, string] = [values[0] ?? '', values[0] ?? ''];
  values.forEach((a, i) => {
    values.slice(i + 1).forEach((b) => {
      const d = separation(a, b);
      if (d < gap) {
        gap = d;
        pair = [a, b];
      }
    });
  });
  return { gap, pair };
}

/**
 * Two lines this close read as one colour on a chart. The categorical set
 * sits at ~100; the semantic-token aliasing that this guard exists to catch
 * pushed it down to ~39.
 */
const MIN_CATEGORICAL_SEPARATION = 90;

describe('domain scales', () => {
  it('declares every colour as a six-digit hex', () => {
    for (const value of [...domainScale.sequential, ...domainScale.categorical]) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  describe('the categorical scale', () => {
    it('gives every member a colour of its own', () => {
      expect(new Set(domainScale.categorical).size).toBe(domainScale.categorical.length);
    });

    it('keeps any two members far enough apart to be told apart', () => {
      const { gap, pair } = closestPair(domainScale.categorical);

      if (gap < MIN_CATEGORICAL_SEPARATION) {
        throw new Error(
          `${pair[0]} and ${pair[1]} are ${gap.toFixed(1)} apart, under the ` +
            `${MIN_CATEGORICAL_SEPARATION} this scale holds. Every member can be ` +
            `drawn at once, so two lines this close read as one. This is what a ` +
            `semantic-token alias does to a categorical set — the palette has ` +
            `four hues, so the set collapses. Pick the colour off ` +
            `domainScale.categorical instead.`,
        );
      }
    });
  });

  describe('the sequential ramp', () => {
    it('has a distinct colour at every step', () => {
      expect(new Set(domainScale.sequential).size).toBe(domainScale.sequential.length);
    });

    it('turns hue monotonically from red through green to violet', () => {
      // The property a ramp has and a list of intents does not: read left to
      // right, the dominant channel walks red → green → blue and does not
      // come back. `accent` appearing at three points in the ramp — which is
      // how the aliased version broke — fails here.
      const dominant = domainScale.sequential.map((hex) => {
        const v = hex.replace('#', '');
        const rgb = [
          parseInt(v.slice(0, 2), 16),
          parseInt(v.slice(2, 4), 16),
          parseInt(v.slice(4, 6), 16),
        ];
        return rgb.indexOf(Math.max(...rgb));
      });

      expect(dominant).toEqual([...dominant].sort((a, b) => a - b));
      expect(dominant[0]).toBe(0);
      expect(dominant[dominant.length - 1]).toBe(2);
    });

    it('reads a step off the ramp for any position, without a fallback', () => {
      const [first] = domainScale.sequential;
      const last = domainScale.sequential[domainScale.sequential.length - 1];

      expect(sequentialColor(0)).toBe(first);
      expect(sequentialColor(-50)).toBe(first);
      expect(sequentialColor(9)).toBe(last);
      expect(sequentialColor(999)).toBe(last);
      expect(sequentialColor(3)).toBe(domainScale.sequential[3]);
    });
  });

  describe('a domain colour is not an intent colour', () => {
    it('keeps the ramp off the chart-series palette, where the collision was', () => {
      // `warning[500]` is chartPalette[3] AND the Deffeyes reagent-path
      // stroke. A ramp step landing on it is the defect this file records.
      expect(domainScale.sequential).not.toContain(colors.warning[500]);
      expect(domainScale.sequential).not.toContain(colors.accent[500]);
      expect(chartPalette).not.toContain(domainScale.sequential[3]);
    });
  });
});
