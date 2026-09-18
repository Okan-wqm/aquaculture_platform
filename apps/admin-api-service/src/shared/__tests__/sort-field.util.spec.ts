import { clampLimit } from '../sort-field.util';

describe('sort-field.util (SEC-MEDIUM-072 — 2026-08-23 scan №17)', () => {
  describe('clampLimit', () => {
    it('returns the fallback for undefined and non-numeric input', () => {
      expect(clampLimit(undefined, 100)).toBe(100);
      expect(clampLimit('not-a-number', 100)).toBe(100);
    });

    it('clamps huge values to the ceiling (authenticated DoS via limit=1e7)', () => {
      expect(clampLimit(1e7, 100, 100)).toBe(100);
      expect(clampLimit('10000000', 100, 100)).toBe(100);
    });

    it('clamps zero and negatives to the floor', () => {
      expect(clampLimit(0, 100, 100)).toBe(1);
      expect(clampLimit(-5, 100, 100)).toBe(1);
    });

    it('passes through in-range values unchanged', () => {
      expect(clampLimit(50, 100, 100)).toBe(50);
      expect(clampLimit('25', 100, 100)).toBe(25);
    });
  });
});
