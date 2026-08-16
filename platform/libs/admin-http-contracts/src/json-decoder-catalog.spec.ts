import {
  ADMIN_JSON_DECODER_CATALOG,
  ADMIN_SCHEMALESS_JSON_DECODER_REGISTRY,
  ADMIN_SCHEMALESS_JSON_REASONS,
  AdminHttpContractError,
  adminJsonDecoderDefinitionFor,
  adminResponse,
  projectAdminResponse,
  validateAdminJsonDecoderCatalogV1,
} from './index';

describe('admin schemaless JSON decoder catalog V1', () => {
  it('is the immutable one-to-one authority for every admitted reason', () => {
    expect(ADMIN_JSON_DECODER_CATALOG.schemaVersion).toBe('admin-json-decoder-catalog.v1');
    expect(ADMIN_SCHEMALESS_JSON_REASONS).toEqual(
      ADMIN_JSON_DECODER_CATALOG.entries.map((entry) => entry.reason),
    );
    expect(Object.isFrozen(ADMIN_JSON_DECODER_CATALOG)).toBe(true);
    expect(Object.isFrozen(ADMIN_JSON_DECODER_CATALOG.entries)).toBe(true);

    for (const definition of ADMIN_JSON_DECODER_CATALOG.entries) {
      const decoder = ADMIN_SCHEMALESS_JSON_DECODER_REGISTRY[definition.reason];
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(decoder)).toBe(true);
      expect(decoder).toEqual(expect.objectContaining(definition));
      expect(typeof decoder.decode).toBe('function');
    }
  });

  it('pins the resolved decoder coordinate into every executable JSON contract', () => {
    const definition = adminJsonDecoderDefinitionFor('security-audit-context');
    const contract = adminResponse.json('security-audit-context');

    expect(contract).toEqual({ kind: 'json', ...definition });
    expect(projectAdminResponse(contract, { actor: 'admin-1' })).toEqual({
      actor: 'admin-1',
    });
  });

  it('enforces decoder-specific root semantics after the shared structural budget', () => {
    const scalar = adminResponse.json('database-scalar');

    expect(projectAdminResponse(scalar, 'value')).toBe('value');
    expect(projectAdminResponse(scalar, null)).toBeNull();
    expect(() => projectAdminResponse(scalar, { nested: true })).toThrow(
      new AdminHttpContractError('$', 'expected a JSON scalar'),
    );
    expect(() => projectAdminResponse(scalar, ['value'])).toThrow('expected a JSON scalar');
  });

  it.each([
    {
      name: 'unknown schema version',
      mutate: () => ({ ...ADMIN_JSON_DECODER_CATALOG, schemaVersion: 'v2' }),
    },
    {
      name: 'duplicate reason and decoder ID',
      mutate: () => ({
        ...ADMIN_JSON_DECODER_CATALOG,
        entries: [
          ...ADMIN_JSON_DECODER_CATALOG.entries,
          { ...ADMIN_JSON_DECODER_CATALOG.entries[0] },
        ],
      }),
    },
    {
      name: 'stale decoder coordinate',
      mutate: () => ({
        ...ADMIN_JSON_DECODER_CATALOG,
        entries: ADMIN_JSON_DECODER_CATALOG.entries.map((entry, index) =>
          index === 0 ? { ...entry, decoderId: 'admin-json.stale.v1' } : { ...entry },
        ),
      }),
    },
    {
      name: 'unsupported root policy',
      mutate: () => ({
        ...ADMIN_JSON_DECODER_CATALOG,
        entries: ADMIN_JSON_DECODER_CATALOG.entries.map((entry, index) =>
          index === 0 ? { ...entry, rootPolicy: 'object-ish' } : { ...entry },
        ),
      }),
    },
    {
      name: 'unversioned extra field',
      mutate: () => ({
        ...ADMIN_JSON_DECODER_CATALOG,
        entries: ADMIN_JSON_DECODER_CATALOG.entries.map((entry, index) =>
          index === 0 ? { ...entry, compatibility: true } : { ...entry },
        ),
      }),
    },
  ])('rejects $name', ({ mutate }) => {
    expect(() => validateAdminJsonDecoderCatalogV1(mutate())).toThrow();
  });

  it('fails closed when a contract asks for an unregistered reason', () => {
    expect(() => adminJsonDecoderDefinitionFor('missing-reason')).toThrow(
      'unregistered admin JSON decoder reason',
    );
  });
});
