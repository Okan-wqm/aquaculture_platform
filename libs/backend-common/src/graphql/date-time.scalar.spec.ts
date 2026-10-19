/**
 * DateTimeScalar unit specs — the date representations the platform actually
 * produces must serialize (the production crash was a date-only string from a
 * TypeORM `date` column reaching the default scalar).
 */
import { DateTimeScalar } from './date-time.scalar';

describe('DateTimeScalar (platform SSoT)', () => {
  describe('serialize', () => {
    it('serializes Date instances', () => {
      expect(DateTimeScalar.serialize(new Date('2026-10-17T12:00:00.000Z'))).toBe(
        '2026-10-17T12:00:00.000Z',
      );
    });

    it('serializes date-only strings from TypeORM date columns (the prod crash)', () => {
      expect(DateTimeScalar.serialize('2026-10-17')).toBe('2026-10-17T00:00:00.000Z');
    });

    it('serializes ISO datetime strings and epoch numbers', () => {
      expect(DateTimeScalar.serialize('2026-10-17T12:00:00.000Z')).toBe('2026-10-17T12:00:00.000Z');
      expect(DateTimeScalar.serialize(1760683200000)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns null for invalid values instead of throwing', () => {
      expect(DateTimeScalar.serialize('not-a-date')).toBeNull();
      expect(DateTimeScalar.serialize({})).toBeNull();
    });
  });

  describe('parseValue / parseLiteral', () => {
    it('parses strings into Dates', () => {
      expect(DateTimeScalar.parseValue('2026-10-17')).toEqual(new Date('2026-10-17'));
    });

    it('throws a GraphQLError for non-date input', () => {
      expect(() => DateTimeScalar.parseValue(true)).toThrow(/DateTime cannot represent/);
    });
  });
});
