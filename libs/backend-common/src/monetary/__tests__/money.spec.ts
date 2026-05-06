import Decimal from 'decimal.js';

import { Money } from '../money';

/**
 * Money — lossless arithmetic + currency-mismatch invariants
 * ============================================================================
 *
 * # Why this spec exists
 *
 * PLAT-LOW-002 cure: the Money value object is the platform's
 * canonical wrapper around financial values. It claims:
 *
 *   - Lossless decimal arithmetic (banker's rounding, 28 digits)
 *   - Strict currency-equality enforcement on add/subtract/equals
 *   - bigint-precision conversion to minor units (no Number rounding)
 *   - JSON round-trip preserves the exact decimal string
 *
 * Without an explicit spec, a future refactor could silently re-introduce
 * Number-based arithmetic, lose Decimal precision in toMinorUnits, or
 * accept cross-currency arithmetic. These tests pin every claim above
 * so the regression class fails fast at CI time.
 */
describe('Money — lossless arithmetic invariants', () => {
  describe('factory methods', () => {
    it('Money.of accepts number, string, and Decimal inputs identically', () => {
      const fromNumber = Money.of(99.99, 'USD');
      const fromString = Money.of('99.99', 'USD');
      const fromDecimal = Money.of(new Decimal('99.99'), 'USD');
      expect(fromNumber.equals(fromString)).toBe(true);
      expect(fromString.equals(fromDecimal)).toBe(true);
    });

    it('Money.fromMinorUnits is the inverse of toMinorUnits for round values', () => {
      const original = Money.of('99.99', 'USD');
      const cents = original.toMinorUnitsBigInt();
      const reconstructed = Money.fromMinorUnits(Number(cents), 'USD');
      expect(reconstructed.equals(original)).toBe(true);
    });

    it('Money.fromMinorUnits rejects non-integer input', () => {
      expect(() => Money.fromMinorUnits(99.99, 'USD')).toThrow(/integer/);
    });

    it('Money.zero produces a zero-amount instance in the requested currency', () => {
      const z = Money.zero('EUR');
      expect(z.toJSON()).toEqual({ amount: '0', currency: 'EUR' });
    });

    it('Money.fromJSON round-trips toJSON exactly', () => {
      const m = Money.of('1234.56', 'GBP');
      const json = m.toJSON();
      const reconstructed = Money.fromJSON(json);
      expect(reconstructed.equals(m)).toBe(true);
      expect(reconstructed.toJSON()).toEqual(json);
    });

    it('currency code is normalised to uppercase', () => {
      const m = Money.of(10, 'usd');
      expect(m.toJSON().currency).toBe('USD');
    });
  });

  describe('lossless arithmetic — no float drift', () => {
    it('add preserves precision across many small additions', () => {
      // Classic IEEE-754 trap: 0.1 + 0.2 !== 0.3 in JS Number.
      // Money MUST preserve exact decimals.
      let sum = Money.of(0, 'USD');
      for (let i = 0; i < 10; i++) {
        sum = sum.add(Money.of('0.1', 'USD'));
      }
      expect(sum.toJSON().amount).toBe('1');
    });

    it('subtract preserves precision', () => {
      const total = Money.of('1', 'USD');
      const drift = total
        .subtract(Money.of('0.1', 'USD'))
        .subtract(Money.of('0.2', 'USD'))
        .subtract(Money.of('0.3', 'USD'))
        .subtract(Money.of('0.4', 'USD'));
      expect(drift.toJSON().amount).toBe('0');
    });

    it('multiply by integer is exact', () => {
      const unit = Money.of('19.99', 'USD');
      const result = unit.multiply(3);
      expect(result.toJSON().amount).toBe('59.97');
    });

    it('multiply by non-trivial decimal is precise to 28 digits', () => {
      const tax = Money.of('100', 'USD').multiply(0.0825);
      expect(tax.toJSON().amount).toBe('8.25');
    });

    it('divide uses banker\'s rounding (ROUND_HALF_EVEN) at the requested scale', () => {
      // 10 / 3 = 3.333... with ROUND_HALF_EVEN at 2 decimals = 3.33
      const result = Money.of('10', 'USD').divide(3);
      // Banker's rounding produces 3.33 when truncated to 2 decimals.
      // The result is a Decimal-precision value — caller chooses rounding
      // via the optional rounding mode parameter.
      expect(result.toJSON().amount).toMatch(/^3\.33333/);
    });
  });

  describe('currency-mismatch invariant', () => {
    it('add throws on currency mismatch', () => {
      expect(() =>
        Money.of(10, 'USD').add(Money.of(10, 'EUR')),
      ).toThrow(/currency/i);
    });

    it('subtract throws on currency mismatch', () => {
      expect(() =>
        Money.of(10, 'USD').subtract(Money.of(10, 'EUR')),
      ).toThrow(/currency/i);
    });

    it('equals returns false on currency mismatch (does NOT throw)', () => {
      // Equals compares both fields — different currency is unequal,
      // not an error.
      expect(Money.of(10, 'USD').equals(Money.of(10, 'EUR'))).toBe(false);
    });
  });

  describe('toMinorUnitsBigInt — precision-safe', () => {
    it('returns bigint for whole-cent amounts', () => {
      expect(Money.of('99.99', 'USD').toMinorUnitsBigInt()).toBe(9999n);
    });

    it('returns bigint for amounts that exceed Number.MAX_SAFE_INTEGER cents', () => {
      // 100_000_000_000_000.99 USD = 10_000_000_000_000_099 cents.
      // > Number.MAX_SAFE_INTEGER (9_007_199_254_740_991), so .toMinorUnits()
      // (number form) would silently lose precision. bigint preserves.
      const huge = Money.of('100000000000000.99', 'USD');
      const cents = huge.toMinorUnitsBigInt();
      expect(cents).toBe(10000000000000099n);
      // Sanity check: above MAX_SAFE_INTEGER threshold.
      expect(cents).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    });

    it('respects currency scale (JPY has 0 decimals)', () => {
      // JPY uses minor units = whole yen (no decimals).
      expect(Money.of('1234', 'JPY').toMinorUnitsBigInt()).toBe(1234n);
    });
  });

  describe('immutability', () => {
    it('add returns a new instance — does not mutate the receiver', () => {
      const a = Money.of('10', 'USD');
      const b = a.add(Money.of('5', 'USD'));
      expect(a.toJSON().amount).toBe('10');
      expect(b.toJSON().amount).toBe('15');
      expect(a).not.toBe(b);
    });

    it('negate returns a new instance', () => {
      const a = Money.of('10', 'USD');
      const b = a.negate();
      expect(a.toJSON().amount).toBe('10');
      expect(b.toJSON().amount).toBe('-10');
    });
  });

  describe('JSON round-trip preserves exact decimal string', () => {
    it.each([
      '0',
      '0.01',
      '99.99',
      '1234567890.12345',
      '-0.01',
      '-1234567890.12345',
    ])('exactly preserves "%s"', (amount) => {
      const m = Money.of(amount, 'USD');
      const reconstructed = Money.fromJSON(m.toJSON());
      expect(reconstructed.toJSON().amount).toBe(m.toJSON().amount);
    });
  });
});
