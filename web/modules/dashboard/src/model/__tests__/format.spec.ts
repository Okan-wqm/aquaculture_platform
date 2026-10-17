/**
 * Formatting: the viewer's decimal notation, and a site's own calendar day
 * (its feeding day plans' key) — not the browser's.
 */
import { describe, expect, it } from 'vitest';

import { formatDecimal, localDateIn } from '../format';

describe('format', () => {
  it('writes decimals in the viewer’s notation', () => {
    expect(formatDecimal(5.84, 1, 'en')).toBe('5.8');
    expect(formatDecimal(5.84, 1, 'tr')).toBe('5,8');
  });

  it('reads the date in the site’s zone, UTC for none or an unknown one', () => {
    const lateUtc = new Date('2026-10-17T22:30:00Z');
    expect(localDateIn(lateUtc, 'Europe/Istanbul')).toBe('2026-10-18');
    expect(localDateIn(lateUtc, null)).toBe('2026-10-17');
    expect(localDateIn(lateUtc, 'Not/AZone')).toBe('2026-10-17');
  });
});
