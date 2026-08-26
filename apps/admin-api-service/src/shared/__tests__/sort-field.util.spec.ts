import { resolveSortField, clampLimit } from '../sort-field.util';

describe('sort-field.util (SEC-HIGH-056 / SEC-MEDIUM-072 — 2026-08-23 scan №1/№17)', () => {
  const ALLOWED = ['createdAt', 'severity', 'action'] as const;

  describe('resolveSortField', () => {
    it('passes through a column on the allowlist', () => {
      expect(resolveSortField('severity', ALLOWED, 'createdAt')).toBe('severity');
    });

    it('falls back on a column NOT on the allowlist (ORDER BY injection payload)', () => {
      expect(resolveSortField('createdAt, (SELECT pg_sleep(60))', ALLOWED, 'createdAt')).toBe(
        'createdAt',
      );
    });

    it('falls back on undefined and empty input', () => {
      expect(resolveSortField(undefined, ALLOWED, 'createdAt')).toBe('createdAt');
      expect(resolveSortField('', ALLOWED, 'createdAt')).toBe('createdAt');
    });
  });

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
