/**
 * decimal-transformer invariant (FARM-MEDIUM-057)
 * ============================================================================
 * node-postgres returns a NUMERIC column as a JS STRING. Without a
 * DecimalTransformer the loaded entity instance holds a string while the
 * GraphQL @Field is Float — so any server-side arithmetic/comparison silently
 * string-concatenates ('250.5' + 1 === '250.51'). These specs assert the
 * transformer IS attached to every NUMERIC column on Farm + Pond, reading the
 * TypeORM column metadata (no DB needed). They would FAIL against the
 * pre-fix entities (no transformer) — proving the fix, guarding the regression.
 */
import { getMetadataArgsStorage } from 'typeorm';

import { Farm } from '../farm.entity';
import { Pond } from '../pond.entity';

type DecimalColumn = { entity: Function; property: string };

const DECIMAL_COLUMNS: readonly DecimalColumn[] = [
  { entity: Farm, property: 'totalArea' },
  { entity: Pond, property: 'capacity' },
  { entity: Pond, property: 'depth' },
  { entity: Pond, property: 'surfaceArea' },
];

describe('decimal-transformer invariant (Farm / Pond NUMERIC columns)', () => {
  const columns = getMetadataArgsStorage().columns;

  it.each(DECIMAL_COLUMNS)(
    '$entity.name.$property declares a DecimalTransformer so NUMERIC loads as a number, not a string',
    ({ entity, property }) => {
      const col = columns.find(
        (c) => c.target === entity && c.propertyName === property,
      );
      expect(col).toBeDefined();
      // The column must still be a decimal/numeric type...
      expect(col?.options.type).toBe('decimal');
      // ...and MUST carry a transformer (the whole point of the fix).
      expect(col?.options.transformer).toBeDefined();
    },
  );

  it('round-trips a NUMERIC string to a number via the attached transformer', () => {
    const col = columns.find(
      (c) => c.target === Pond && c.propertyName === 'capacity',
    );
    const transformer = col?.options.transformer;
    // transformer may be declared as a single object or an array; normalize.
    const one = Array.isArray(transformer) ? transformer[0] : transformer;
    expect(one).toBeDefined();
    // from() is the DB->entity read path that fixes the string bug.
    const fromResult = one?.from('250.50');
    expect(typeof fromResult).toBe('number');
    expect(fromResult).toBe(250.5);
  });
});
