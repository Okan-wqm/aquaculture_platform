import Decimal from 'decimal.js';
import { Kind } from 'graphql';

import { DecimalScalar } from './decimal.scalar';

/**
 * The `Decimal` scalar is the platform money wire type (ADR-0004 / DATA-MEDIUM-009).
 * It must serialise number | Decimal | string to an EXACT decimal string with no
 * IEEE-754 artefacts for fixed-scale money values, and reject non-numeric input.
 */
describe('DecimalScalar', () => {
  describe('serialize (resolver value → wire string)', () => {
    it('serialises a fixed-scale money number exactly (no float artefact)', () => {
      expect(DecimalScalar.serialize(12345.67)).toBe('12345.67');
      expect(DecimalScalar.serialize(0.1)).toBe('0.1');
      expect(DecimalScalar.serialize(1000)).toBe('1000');
      expect(DecimalScalar.serialize(-42.5)).toBe('-42.5');
    });

    it('serialises a Decimal.js instance (the @MoneyColumn shape) exactly', () => {
      expect(DecimalScalar.serialize(new Decimal('19.99'))).toBe('19.99');
      expect(DecimalScalar.serialize(new Decimal('100000000000.0001'))).toBe('100000000000.0001');
    });

    it('passes a decimal string through unchanged (canonicalised)', () => {
      expect(DecimalScalar.serialize('12345.67')).toBe('12345.67');
      expect(DecimalScalar.serialize('0.30')).toBe('0.3');
    });

    it('returns null for null/undefined (nullable money fields)', () => {
      expect(DecimalScalar.serialize(null)).toBeNull();
      expect(DecimalScalar.serialize(undefined)).toBeNull();
    });

    it('throws on a non-numeric value rather than emitting garbage', () => {
      expect(() => DecimalScalar.serialize('not-a-number')).toThrow(/non-numeric/);
      expect(() => DecimalScalar.serialize({})).toThrow();
    });
  });

  describe('parseValue (inbound variable → canonical string)', () => {
    it('accepts a string or number and canonicalises', () => {
      expect(DecimalScalar.parseValue('42.50')).toBe('42.5');
      expect(DecimalScalar.parseValue(42.5)).toBe('42.5');
    });

    it('rejects non-string/number input', () => {
      expect(() => DecimalScalar.parseValue(true)).toThrow(/must be a string or number/);
    });

    it('rejects a numeric-looking but invalid string', () => {
      expect(() => DecimalScalar.parseValue('12,34')).toThrow(/non-numeric/);
    });
  });

  describe('parseLiteral (inbound AST literal → canonical string)', () => {
    it('accepts string, int, and float literals', () => {
      expect(DecimalScalar.parseLiteral({ kind: Kind.STRING, value: '42.50' }, undefined)).toBe(
        '42.5',
      );
      expect(DecimalScalar.parseLiteral({ kind: Kind.INT, value: '1000' }, undefined)).toBe('1000');
      expect(DecimalScalar.parseLiteral({ kind: Kind.FLOAT, value: '3.14' }, undefined)).toBe(
        '3.14',
      );
    });

    it('rejects non-scalar literals (e.g. a list/object)', () => {
      expect(() =>
        DecimalScalar.parseLiteral({ kind: Kind.BOOLEAN, value: true }, undefined),
      ).toThrow(/can only parse/);
    });
  });
});
