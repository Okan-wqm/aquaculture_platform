/**
 * DateTimeCustomScalar provider specs — the federation-driver registration
 * path (ScalarsExplorer via @Scalar metadata) plus delegation to the
 * platform SSoT serialisation, including the prod-crash input.
 */
import { SCALAR_NAME_METADATA } from '@nestjs/graphql/dist/graphql.constants';
import { DateTimeCustomScalar } from './datetime.custom-scalar';

describe('DateTimeCustomScalar (federation provider)', () => {
  it('carries the @Scalar("DateTime", () => Date) metadata the ScalarsExplorer requires', () => {
    expect(Reflect.getMetadata(SCALAR_NAME_METADATA, DateTimeCustomScalar)).toBe('DateTime');
  });

  it('serialises the date-only strings TypeORM date columns produce (the prod crash input)', () => {
    const scalar = new DateTimeCustomScalar();
    expect(scalar.serialize('2026-10-17')).toBe('2026-10-17T00:00:00.000Z');
    expect(scalar.serialize(new Date('2026-10-17T12:00:00.000Z'))).toBe('2026-10-17T12:00:00.000Z');
    expect(scalar.serialize('not-a-date')).toBeNull();
  });

  it('parses wire values into Date instances', () => {
    const scalar = new DateTimeCustomScalar();
    expect(scalar.parseValue('2026-10-17')).toEqual(new Date('2026-10-17'));
  });
});
