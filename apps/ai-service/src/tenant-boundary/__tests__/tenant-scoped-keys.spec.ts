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
  ])('flags %s', (name) => {
    expect(isTenantScopedKey(name)).toBe(true);
  });

  it.each(['tankId', 'siteId', 'batchId', 'systemId', 'limit', 'contentSchemaVersion'])(
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
});
