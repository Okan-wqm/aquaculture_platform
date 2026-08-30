import {
  assertMarineProviderCredentialWritePolicy,
  resolveConfigurationUpsertLockKey,
  resolvePostgresUpsertConflictClause,
  resolveUpsertOverwriteColumns,
} from '../upsert-configuration.handler';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID,
} from '@platform/event-contracts';

import { UpsertConfigurationCommand } from '../../commands/upsert-configuration.command';
import { ConfigEnvironment } from '../../entities/configuration.entity';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function marineCommand(
  tenantId: string,
  userId: string,
  overrides: Partial<{
    value: string;
    environment: ConfigEnvironment;
    isSecret: boolean;
  }> = {},
): UpsertConfigurationCommand {
  return new UpsertConfigurationCommand(
    tenantId,
    'farm-service',
    'marine.cdse.credentials',
    overrides.value ?? '{"clientId":"id","clientSecret":"secret"}',
    overrides.environment ?? ConfigEnvironment.ALL,
    userId,
    overrides.isSecret ?? true,
    'credential write',
  );
}

describe('resolveUpsertOverwriteColumns', () => {
  it('preserves the stored value_type on a non-secret upsert', () => {
    // The public setConfiguration mutation carries no valueType argument. A
    // plain write must not downgrade a seeded number/boolean/json row to
    // string, or typed consumers of getTypedValue() silently regress to raw
    // strings.
    expect(resolveUpsertOverwriteColumns(false)).not.toContain('value_type');
  });

  it('stamps value_type on a secret upsert so redaction is enforced by type', () => {
    expect(resolveUpsertOverwriteColumns(true)).toContain('value_type');
  });

  it('always overwrites the value, audit actor and tombstone lifecycle columns', () => {
    for (const isSecret of [true, false]) {
      const columns = resolveUpsertOverwriteColumns(isSecret);
      for (const expected of [
        'value',
        'is_secret',
        'updated_by',
        'updated_at',
        'is_active',
        'deleted_at',
        'deleted_by',
        'delete_reason',
        'retention_until',
        'suppress_fallback',
      ]) {
        expect(columns).toContain(expected);
      }
    }
  });

  it('increments the persisted version instead of copying the insert default', () => {
    for (const isSecret of [true, false]) {
      const clause = resolvePostgresUpsertConflictClause(isSecret);

      expect(clause).toContain('"version" = "configurations"."version" + 1');
      expect(clause).not.toContain('"version" = EXCLUDED."version"');
    }
  });

  it('uses the complete natural key as non-secret advisory-lock material', () => {
    const first = resolveConfigurationUpsertLockKey(
      'tenant-a',
      'farm-service',
      'cdse_credentials',
      'all',
    );
    const second = resolveConfigurationUpsertLockKey(
      'tenant-a',
      'farm-service',
      'cmems_credentials',
      'all',
    );

    expect(first).not.toBe(second);
    expect(first).not.toContain('client-secret-value');
  });
});

describe('marine provider credential write policy', () => {
  it('allows the platform-admin SYSTEM bundle and the exact tenant cutover actor', () => {
    expect(() =>
      assertMarineProviderCredentialWritePolicy(
        marineCommand(CONFIG_RUNTIME_SYSTEM_TENANT_ID, 'platform-admin-user'),
      ),
    ).not.toThrow();
    expect(() =>
      assertMarineProviderCredentialWritePolicy(
        marineCommand(TENANT_ID, MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID),
      ),
    ).not.toThrow();
  });

  it('prevents public/admin paths from creating or rotating a tenant override', () => {
    expect(() =>
      assertMarineProviderCredentialWritePolicy(marineCommand(TENANT_ID, 'platform-admin-user')),
    ).toThrow(ForbiddenException);
  });

  it.each([
    { isSecret: false },
    { environment: ConfigEnvironment.PRODUCTION },
    { value: '{"clientId":"missing-secret"}' },
  ])('requires an atomic valid secret bundle in the ALL environment: %o', (overrides) => {
    expect(() =>
      assertMarineProviderCredentialWritePolicy(
        marineCommand(CONFIG_RUNTIME_SYSTEM_TENANT_ID, 'platform-admin-user', overrides),
      ),
    ).toThrow(BadRequestException);
  });
});
