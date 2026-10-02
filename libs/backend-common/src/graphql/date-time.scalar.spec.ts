import { GraphQLISODateTime } from '@nestjs/graphql';

import { installDateOnlyDateTimeScalar } from './date-time.scalar';

/**
 * FARM-HIGH-358: TypeORM `date` columns arrive as 'YYYY-MM-DD' strings and the
 * stock @nestjs/graphql DateTime scalar serialised every non-Date value to
 * null, so a non-null date field (Batch.stockedAt, HarvestPlan.plannedDate)
 * crashed the whole list query. The wrapper is installed once per service on
 * the scalar instance the schema builder actually uses.
 */
describe('installDateOnlyDateTimeScalar', () => {
  const unpatchedDateOnly = GraphQLISODateTime.serialize('2026-09-21');

  beforeAll(() => {
    installDateOnlyDateTimeScalar();
  });

  it('documents the defect: the stock scalar turns a date-only string into null', () => {
    expect(unpatchedDateOnly).toBeNull();
  });

  it('serialises a date-only column value verbatim on the shared instance', () => {
    expect(GraphQLISODateTime.serialize('2026-09-21')).toBe('2026-09-21');
  });

  it('keeps Date values on the ISO-8601 path', () => {
    expect(GraphQLISODateTime.serialize(new Date('2026-09-21T10:15:00.000Z'))).toBe(
      '2026-09-21T10:15:00.000Z',
    );
  });

  it('parses a date-only input as UTC midnight', () => {
    expect(GraphQLISODateTime.parseValue('2027-04-01')).toEqual(
      new Date('2027-04-01T00:00:00.000Z'),
    );
  });

  it('is idempotent: a second install does not wrap the wrapper', () => {
    installDateOnlyDateTimeScalar();
    expect(GraphQLISODateTime.serialize('2026-09-21')).toBe('2026-09-21');
    expect(GraphQLISODateTime.parseValue('2027-04-01')).toEqual(
      new Date('2027-04-01T00:00:00.000Z'),
    );
  });
});
