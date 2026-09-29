import {
  findTenantScopedKeys,
  findTenantScopedParameters,
  isTenantScopedKey,
} from '../tenant-scoped-keys';

/** The tenant/schema selector name SSoT shared by the schema invariant, the executor and the client (K10). */
describe('tenant-scoped key detection', () => {
  it.each([
    'tenant',
    'tenantId',
    'tenant_id',
    'TENANT-ID',
    'tenantIds',
    'schema',
    'schemaName',
    'search_path',
    'searchPath',
    // V-T1a-9: substring match — every spelling of a tenant selector is refused.
    'tenantUuid',
    'x-tenant-id',
    'targetTenantId',
    'ownerTenant',
    'targetSchema',
  ])('flags %s', (name) => {
    expect(isTenantScopedKey(name)).toBe(true);
  });

  it.each(['tankId', 'siteId', 'batchId', 'systemId', 'limit', 'harvestDate'])(
    'does not flag %s',
    (name) => {
      expect(isTenantScopedKey(name)).toBe(false);
    },
  );

  it('finds selectors at any depth in a value, arrays included', () => {
    expect(
      findTenantScopedKeys({ tankId: 'x', filter: { tenant_id: 'b' }, rows: [{ schema: 's' }] }),
    ).toEqual(['filter.tenant_id', 'rows[0].schema']);
    expect(findTenantScopedKeys({ tankId: 'x', days: 7 })).toEqual([]);
  });

  it('walks JSON Schema parameters, not JSON Schema keywords', () => {
    // SCENARIO: `$schema` is a keyword; `tenantId` hides under items/anyOf/required.
    // EXPECTS: only real parameter names are reported.
    expect(
      findTenantScopedParameters({ $schema: 'x', type: 'object', properties: { tankId: {} } }),
    ).toEqual([]);
    expect(
      findTenantScopedParameters({
        type: 'object',
        required: ['tenantId'],
        properties: {
          rows: { type: 'array', items: { type: 'object', properties: { search_path: {} } } },
          pick: { anyOf: [{ type: 'object', properties: { Schema: {} } }] },
        },
      }).sort(),
    ).toEqual(['pick.<anyOf[0]>.Schema', 'rows.<items>.search_path', 'tenantId'].sort());
  });

  it.each([
    [
      '$defs (a local $ref target)',
      {
        type: 'object',
        properties: { filter: { $ref: '#/$defs/Filter' } },
        $defs: { Filter: { type: 'object', properties: { tenantUuid: {} } } },
      },
      '<$defs.Filter>.tenantUuid',
    ],
    [
      'definitions',
      { definitions: { F: { properties: { 'x-tenant-id': {} } } } },
      '<definitions.F>.x-tenant-id',
    ],
    [
      'if / then / else',
      { if: { properties: { a: {} } }, then: { properties: { targetTenantId: {} } } },
      '<then>.targetTenantId',
    ],
    [
      'dependentSchemas',
      { dependentSchemas: { a: { properties: { tenant: {} } } } },
      '<dependentSchemas.a>.tenant',
    ],
    [
      'propertyNames enum',
      { propertyNames: { enum: ['tankId', 'tenantId'] } },
      '<propertyNames:tenantId>',
    ],
    ['propertyNames pattern', { propertyNames: { pattern: '^.*$' } }, '<propertyNames:^.*$>'],
    ['patternProperties', { patternProperties: { '^t.*': {} } }, '<patternProperties:^t.*>'],
    [
      'a non-local $ref',
      { properties: { x: { $ref: 'https://example.com/s.json' } } },
      'x.<unverifiable $ref https://example.com/s.json>',
    ],
  ])('walks %s', (_keyword, schema, expected) => {
    // SCENARIO (V-T1a-9): a tenant parameter hidden behind a keyword the first walk skipped.
    // EXPECTS: the walk reports it (or the $ref it cannot follow).
    expect(findTenantScopedParameters(schema)).toContain(expected);
  });

  it('does not flag a pattern that cannot match a tenant or schema name', () => {
    expect(findTenantScopedParameters({ patternProperties: { '^[0-9]+$': {} } })).toEqual([]);
    expect(findTenantScopedParameters({ propertyNames: { pattern: '^(tankId|limit)$' } })).toEqual(
      [],
    );
  });
});
