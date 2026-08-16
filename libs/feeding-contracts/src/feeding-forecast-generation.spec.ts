import {
  FEEDING_FORECAST_GENERATION_AUTHORITY,
  FEEDING_FORECAST_GENERATION_CATALOG_DIGEST,
  compileFeedingForecastGenerationExactSetProofV1,
} from './feeding-forecast-generation';

const SITE = '22222222-2222-4222-8222-222222222222';

describe('feeding forecast generation authority', () => {
  it('compiles a byte-stable exact set independent of input order', () => {
    const tenant = { siteScopeKey: 'tenant', poolScope: 'TENANT' as const, payload: { kg: 10 } };
    const site = { siteScopeKey: SITE, poolScope: 'SITE' as const, payload: { kg: 4 } };
    const first = compileFeedingForecastGenerationExactSetProofV1([tenant, site]);
    const second = compileFeedingForecastGenerationExactSetProofV1([site, tenant]);

    expect(second).toEqual(first);
    expect(first.catalogDigest).toBe(FEEDING_FORECAST_GENERATION_CATALOG_DIGEST);
    expect(first.exactSetDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.membershipDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.snapshots.map(({ siteScopeKey }) => siteScopeKey)).toEqual([SITE, 'tenant']);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.snapshots)).toBe(true);
  });

  it('binds payload bytes and rejects duplicate logical scopes', () => {
    const first = compileFeedingForecastGenerationExactSetProofV1([
      { siteScopeKey: 'tenant', poolScope: 'TENANT', payload: { kg: 10 } },
    ]);
    const changed = compileFeedingForecastGenerationExactSetProofV1([
      { siteScopeKey: 'tenant', poolScope: 'TENANT', payload: { kg: 11 } },
    ]);
    expect(changed.exactSetDigest).not.toBe(first.exactSetDigest);
    expect(changed.membershipDigest).not.toBe(first.membershipDigest);
    expect(() =>
      compileFeedingForecastGenerationExactSetProofV1([
        { siteScopeKey: 'tenant', poolScope: 'TENANT', payload: {} },
        { siteScopeKey: 'tenant', poolScope: 'TENANT', payload: {} },
      ]),
    ).toThrow('Duplicate forecast generation scope tenant');
  });

  it('publishes only the locked transition graph and guarded retention contract', () => {
    expect(FEEDING_FORECAST_GENERATION_AUTHORITY.transitions).toEqual([
      ['BUILDING', 'QUALIFIED'],
      ['QUALIFIED', 'ACTIVE'],
      ['ACTIVE', 'RETIRED'],
    ]);
    expect(FEEDING_FORECAST_GENERATION_AUTHORITY.retention).toEqual({
      deletableState: 'RETIRED',
      requiresActiveSuccessor: true,
    });
    expect(FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions).toEqual({
      qualify: 'qualify_feeding_forecast_generation_v1',
      activate: 'activate_feeding_forecast_generation_v1',
      purgeRetired: 'purge_feeding_forecast_generations_v1',
    });
  });
});
