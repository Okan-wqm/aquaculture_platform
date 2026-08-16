import { assertExactAuthoritySetV1 } from './authority-exact-set';
import {
  FEEDING_CONTROL_PLANE_RELATION_AUTHORITIES,
  FEEDING_DURABLE_RELATION_AUTHORITY,
  FEEDING_FIXED_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES,
  FEEDING_FIXED_SCHEMA_RELATION_AUTHORITIES,
  FEEDING_TENANT_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES,
  FEEDING_TENANT_SCHEMA_RELATION_AUTHORITIES,
} from './feeding-durable-relation-authority';

function coordinates(relations: readonly { readonly coordinate: string }[]): readonly string[] {
  return relations.map((relation) => relation.coordinate);
}

describe('feeding durable relation physical-scope projections', () => {
  it('partitions every governed relation into exactly one physical scope', () => {
    const full = coordinates(FEEDING_DURABLE_RELATION_AUTHORITY);
    const projected = [
      ...coordinates(FEEDING_TENANT_SCHEMA_RELATION_AUTHORITIES),
      ...coordinates(FEEDING_FIXED_SCHEMA_RELATION_AUTHORITIES),
    ];

    expect([...projected].sort()).toEqual([...full].sort());
    expect(new Set(projected).size).toBe(full.length);
    expect(
      FEEDING_TENANT_SCHEMA_RELATION_AUTHORITIES.every(
        (relation) => relation.physical.scope === 'tenant_schema',
      ),
    ).toBe(true);
    expect(
      FEEDING_FIXED_SCHEMA_RELATION_AUTHORITIES.every(
        (relation) =>
          relation.physical.scope === 'fixed_schema' && relation.physical.schema === 'farm',
      ),
    ).toBe(true);
  });

  it('keeps fixed-schema ACL inventory and tenant provenance as disjoint typed projections', () => {
    const controlPlane = coordinates(FEEDING_CONTROL_PLANE_RELATION_AUTHORITIES);
    const fixed = coordinates(FEEDING_FIXED_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES);
    const tenant = coordinates(FEEDING_TENANT_SCHEMA_CONTROL_PLANE_RELATION_AUTHORITIES);

    expect([...fixed, ...tenant].sort()).toEqual([...controlPlane].sort());
    expect(new Set([...fixed, ...tenant]).size).toBe(controlPlane.length);
    expect(tenant).toContain('farm.feeding_historical_provenance_events');
    expect(fixed).not.toContain('farm.feeding_historical_provenance_events');
  });

  it('fails closed on a duplicate or orphaned physical-scope projection', () => {
    const expected = coordinates(FEEDING_DURABLE_RELATION_AUTHORITY);
    const exact = [
      ...coordinates(FEEDING_TENANT_SCHEMA_RELATION_AUTHORITIES),
      ...coordinates(FEEDING_FIXED_SCHEMA_RELATION_AUTHORITIES),
    ];
    const first = exact[0];
    if (!first) throw new Error('feeding durable relation authority must not be empty');

    expect(() =>
      assertExactAuthoritySetV1([...exact, first], expected, 'test physical projection'),
    ).toThrow(/duplicate coordinates/i);
    expect(() =>
      assertExactAuthoritySetV1(exact.slice(1), expected, 'test physical projection'),
    ).toThrow(/registry differs/i);
  });
});
