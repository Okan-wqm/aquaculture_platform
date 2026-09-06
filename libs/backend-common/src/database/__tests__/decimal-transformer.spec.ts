/**
 * DecimalTransformer — the `undefined` vs `null` distinction.
 *
 * TypeORM runs `to()` on every column it is about to write. What the
 * transformer returns decides whether the column appears in the INSERT at all:
 * `undefined` leaves it out and the DEFAULT applies, anything else (including
 * `null`) is written literally.
 *
 * Collapsing the two made every `NOT NULL DEFAULT` decimal column unusable
 * unless the caller named it explicitly, across 44 column declarations. The
 * failure looked like an entity/migration mismatch and was neither — both
 * declared the default correctly.
 */
import { DecimalTransformer, numberOrUndefined } from '../decimal-transformer';

describe('DecimalTransformer', () => {
  const transformer = new DecimalTransformer();

  describe('to() — writing', () => {
    it('leaves an unprovided value out of the write so the column DEFAULT applies', () => {
      // The regression: returning null here writes an explicit NULL, which a
      // `NOT NULL DEFAULT 0` column rejects.
      expect(transformer.to(undefined)).toBeUndefined();
    });

    it('writes an explicit null, because clearing a nullable column is deliberate', () => {
      expect(transformer.to(null)).toBeNull();
    });

    it.each([0, -12.5, 1234.56])('passes %p through unchanged', (value) => {
      expect(transformer.to(value)).toBe(value);
    });

    it('does not confuse zero with absence', () => {
      // `0` is falsy; a truthiness check here would silently drop a real value.
      expect(transformer.to(0)).toBe(0);
      expect(transformer.to(0)).not.toBeUndefined();
    });
  });

  describe('from() — reading', () => {
    it('parses the string PostgreSQL returns for numeric columns', () => {
      expect(transformer.from('1.50')).toBe(1.5);
      expect(transformer.from('-3')).toBe(-3);
    });

    it('passes a number through unchanged', () => {
      expect(transformer.from(42)).toBe(42);
    });

    it.each([null, undefined])('reads %p as null', (value) => {
      expect(transformer.from(value)).toBeNull();
    });

    it('reads an unparseable value as null rather than NaN', () => {
      expect(transformer.from('not-a-number')).toBeNull();
    });
  });

  describe('numberOrUndefined() — mapping a read onto a response field', () => {
    it('keeps a measured zero, which a truthiness guard drops', () => {
      // The whole reason this helper exists: `v ? Number(v) : undefined` reports
      // a batch that did not grow, and a tank filled to the rim, as unmeasured.
      expect(numberOrUndefined(0)).toBe(0);
      expect(numberOrUndefined('0')).toBe(0);
      expect(numberOrUndefined('0.00')).toBe(0);
    });

    it.each([null, undefined])('maps %p — the schema\'s "unset" — to undefined', (value) => {
      expect(numberOrUndefined(value)).toBeUndefined();
    });

    it('coerces the string PostgreSQL returns, and keeps the sign', () => {
      expect(numberOrUndefined('1.50')).toBe(1.5);
      expect(numberOrUndefined(-3)).toBe(-3);
      expect(numberOrUndefined('-0.25')).toBe(-0.25);
    });

    it('round-trips what the transformer read', () => {
      // from() is the producer of the value this helper consumes, so the two
      // agree by construction rather than by coincidence.
      expect(numberOrUndefined(transformer.from('0.00'))).toBe(0);
      expect(numberOrUndefined(transformer.from(null))).toBeUndefined();
      expect(numberOrUndefined(transformer.from('12.5'))).toBe(12.5);
    });
  });
});
