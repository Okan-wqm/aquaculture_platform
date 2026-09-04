import Decimal from 'decimal.js';

import { DecimalValueTransformer } from '../decimal-column.decorator';

/**
 * DecimalValueTransformer — lossless write/read cycle
 * ============================================================================
 *
 * # Why this spec exists
 *
 * PLAT-LOW-002 cure (companion to money.spec.ts). The transformer
 * sits at the boundary between TypeORM and PostgreSQL NUMERIC; any
 * regression that re-introduces parseFloat or Number coercion would
 * silently lose precision on every read/write cycle. These tests pin:
 *
 *   - Write path returns the exact decimal string for PostgreSQL
 *   - Read path returns a Decimal instance with full precision
 *   - null / undefined round-trip cleanly (not coerced to 0)
 *   - Edge values that would fail under Number-based arithmetic
 *     (0.1 + 0.2, > MAX_SAFE_INTEGER, very-small fractions) are
 *     preserved bit-for-bit through the transformer
 */
describe('DecimalValueTransformer — lossless precision', () => {
  let transformer: DecimalValueTransformer;

  beforeEach(() => {
    transformer = new DecimalValueTransformer();
  });

  describe('write path (Decimal → PostgreSQL string)', () => {
    it('returns the exact string representation', () => {
      expect(transformer.to(new Decimal('99.99'))).toBe('99.99');
    });

    it('preserves precision for IEEE-754 hostile values', () => {
      // 0.1 + 0.2 in Number is 0.30000000000000004; Decimal preserves '0.3'.
      const sum = new Decimal('0.1').plus('0.2');
      expect(transformer.to(sum)).toBe('0.3');
    });

    it('preserves very-small fractions', () => {
      expect(transformer.to(new Decimal('0.00000001'))).toBe('1e-8');
    });

    it('preserves values above Number.MAX_SAFE_INTEGER', () => {
      const huge = new Decimal('9007199254740993'); // MAX_SAFE_INTEGER + 2
      expect(transformer.to(huge)).toBe('9007199254740993');
    });

    it('returns null for null input, because clearing a column is deliberate', () => {
      expect(transformer.to(null)).toBeNull();
    });

    it('returns undefined for undefined input, so the column DEFAULT applies', () => {
      // Collapsing undefined into null makes TypeORM write an explicit NULL
      // instead of omitting the column, and every `NOT NULL DEFAULT '0'` money
      // column then rejects the insert. See the transformer's own docblock.
      expect(transformer.to(undefined)).toBeUndefined();
    });

    it('preserves negative values', () => {
      expect(transformer.to(new Decimal('-1234.5678'))).toBe('-1234.5678');
    });
  });

  describe('read path (PostgreSQL string → Decimal)', () => {
    it('returns a Decimal instance for a string', () => {
      const result = transformer.from('99.99');
      expect(result).toBeInstanceOf(Decimal);
      expect(result?.toString()).toBe('99.99');
    });

    it('preserves precision through the read path', () => {
      const result = transformer.from('100000000000000.99');
      expect(result?.toString()).toBe('100000000000000.99');
    });

    it('returns null for null input', () => {
      expect(transformer.from(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(transformer.from(undefined)).toBeNull();
    });

    it('preserves negative values', () => {
      const result = transformer.from('-9999.0001');
      expect(result?.toString()).toBe('-9999.0001');
    });
  });

  describe('round-trip — write then read returns identical Decimal', () => {
    it.each([
      '0',
      '0.01',
      '99.99',
      '1234567890.12345',
      '-0.01',
      '-1234567890.12345',
      '9007199254740993',
    ])('round-trips "%s" exactly', (input) => {
      const original = new Decimal(input);
      const written = transformer.to(original);
      expect(written).not.toBeNull();
      const read = transformer.from(written);
      expect(read?.equals(original)).toBe(true);
    });
  });
});
