import 'reflect-metadata';

import {
  AllowTenantDelta,
  SourceOnlyMigration,
  TENANT_FANOUT_META_KEY,
  TenantFanOut,
  getAllowedTenantDeltaPrefixes,
  getSourceOnlyMigrationMetadata,
  getTenantFanOutMetadata,
  isSourceOnlyMigration,
  isTenantDeltaAllowed,
} from '../tenant-fanout.decorator';

describe('@TenantFanOut decorator', () => {
  it('attaches metadata for tenant-local class', () => {
    @TenantFanOut({ lockClass: 'tenant-local', concurrency: 4 })
    class M {}
    const meta = getTenantFanOutMetadata(M);
    expect(meta).not.toBeNull();
    expect(meta?.lockClass).toBe('tenant-local');
    expect(meta?.concurrency).toBe(4);
    expect(meta?.effectiveConcurrency).toBe(4);
  });

  it('forces concurrency=1 for lockClass=catalog regardless of declared value', () => {
    @TenantFanOut({ lockClass: 'catalog', concurrency: 16 })
    class CatalogMig {}
    const meta = getTenantFanOutMetadata(CatalogMig);
    expect(meta?.concurrency).toBe(16); // original preserved
    expect(meta?.effectiveConcurrency).toBe(1); // override applied
  });

  it('clamps tenant-local concurrency to [1, 32]', () => {
    @TenantFanOut({ lockClass: 'tenant-local', concurrency: 1 })
    class LowEnd {}
    expect(getTenantFanOutMetadata(LowEnd)?.effectiveConcurrency).toBe(1);

    // Decoration-time validation already rejects out-of-range values,
    // but the clamp is belt-and-braces for metadata injected via
    // Reflect.defineMetadata directly (e.g. migration-harness tests).
    class RawMig {}
    Reflect.defineMetadata(
      TENANT_FANOUT_META_KEY,
      { lockClass: 'tenant-local', concurrency: 999, target: RawMig },
      RawMig,
    );
    expect(getTenantFanOutMetadata(RawMig)?.effectiveConcurrency).toBe(32);
  });

  it('returns null for undecorated class', () => {
    class Plain {}
    expect(getTenantFanOutMetadata(Plain)).toBeNull();
  });

  it('rejects invalid lockClass at decoration time', () => {
    expect(() =>
      TenantFanOut({
        lockClass: 'nonsense' as 'tenant-local',
        concurrency: 4,
      }),
    ).toThrow(/lockClass/);
  });

  it('rejects concurrency outside [1, 32]', () => {
    expect(() =>
      TenantFanOut({ lockClass: 'tenant-local', concurrency: 0 }),
    ).toThrow(/\[1, 32\]/);
    expect(() =>
      TenantFanOut({ lockClass: 'tenant-local', concurrency: 100 }),
    ).toThrow(/\[1, 32\]/);
  });

  it('concurrency defaults to 8 when omitted', () => {
    @TenantFanOut({ lockClass: 'tenant-local' })
    class DefaultM {}
    expect(getTenantFanOutMetadata(DefaultM)?.effectiveConcurrency).toBe(8);
  });
});

describe('@AllowTenantDelta decorator', () => {
  it('attaches prefix allowlist to an entity class', () => {
    @AllowTenantDelta({ columnPrefix: ['enterprise_', 'custom_'] })
    class EmpEntity {}
    const prefixes = getAllowedTenantDeltaPrefixes(EmpEntity);
    expect(prefixes).toEqual(['enterprise_', 'custom_']);
  });

  it('isTenantDeltaAllowed matches on startsWith', () => {
    @AllowTenantDelta({ columnPrefix: ['enterprise_'] })
    class E {}
    expect(isTenantDeltaAllowed(E, 'enterprise_sla_tier')).toBe(true);
    expect(isTenantDeltaAllowed(E, 'enterprise_')).toBe(true);
    expect(isTenantDeltaAllowed(E, 'random_field')).toBe(false);
  });

  it('undecorated entity has empty prefix list', () => {
    class Plain {}
    expect(getAllowedTenantDeltaPrefixes(Plain)).toEqual([]);
    expect(isTenantDeltaAllowed(Plain, 'anything')).toBe(false);
  });

  it('rejects empty columnPrefix array', () => {
    expect(() => AllowTenantDelta({ columnPrefix: [] })).toThrow(/non-empty/);
  });

  it('rejects non-string prefix entries', () => {
    expect(() =>
      AllowTenantDelta({
        columnPrefix: ['ok', 42 as unknown as string],
      }),
    ).toThrow(/non-empty string/);
    expect(() =>
      AllowTenantDelta({
        columnPrefix: ['ok', ''],
      }),
    ).toThrow(/non-empty string/);
  });

  it('empty-string column matches no prefix (sanity)', () => {
    @AllowTenantDelta({ columnPrefix: ['enterprise_'] })
    class E {}
    expect(isTenantDeltaAllowed(E, '')).toBe(false);
  });
});

describe('@SourceOnlyMigration decorator', () => {
  it('attaches source-only metadata to a migration class', () => {
    @SourceOnlyMigration({ reason: 'outbox is source-owned infrastructure' })
    class SourceOnly {}

    expect(isSourceOnlyMigration(SourceOnly)).toBe(true);
    expect(getSourceOnlyMigrationMetadata(SourceOnly)).toMatchObject({
      reason: 'outbox is source-owned infrastructure',
      target: SourceOnly,
    });
  });

  it('returns null for undecorated classes', () => {
    class Plain {}
    expect(isSourceOnlyMigration(Plain)).toBe(false);
    expect(getSourceOnlyMigrationMetadata(Plain)).toBeNull();
  });

  it('requires a reason', () => {
    expect(() => SourceOnlyMigration({ reason: '' })).toThrow(/reason/);
  });
});
