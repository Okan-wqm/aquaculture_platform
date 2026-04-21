import { getMetadataArgsStorage } from 'typeorm';

import { EmergencyOverrideEntity } from '../emergency-override.entity';

describe('EmergencyOverrideEntity', () => {
  it('declares schema=observability + table=emergency_overrides', () => {
    const t = getMetadataArgsStorage().tables.find(
      (ta) => ta.target === EmergencyOverrideEntity,
    );
    expect(t?.schema).toBe('observability');
    expect(t?.name).toBe('emergency_overrides');
  });

  it('kind enum covers the 3 override types', () => {
    const col = getMetadataArgsStorage().columns.find(
      (c) =>
        c.target === EmergencyOverrideEntity && c.propertyName === 'kind',
    );
    expect(col?.options.enum).toEqual([
      'drift_fatal_bypass',
      'migration_skip',
      'validator_disable',
    ]);
  });

  it('reason + actor + expires_at are NOT NULL (audit contract)', () => {
    const cols = getMetadataArgsStorage().columns.filter(
      (c) => c.target === EmergencyOverrideEntity,
    );
    const reason = cols.find((c) => c.propertyName === 'reason');
    const actor = cols.find((c) => c.propertyName === 'actor');
    const expiresAt = cols.find((c) => c.propertyName === 'expiresAt');
    expect(reason?.options.nullable).toBeUndefined();
    expect(actor?.options.nullable).toBeUndefined();
    expect(expiresAt?.options.nullable).toBeUndefined();
  });

  it('revocation fields are nullable (only set on explicit revoke)', () => {
    const cols = getMetadataArgsStorage().columns.filter(
      (c) => c.target === EmergencyOverrideEntity,
    );
    const revokedReason = cols.find(
      (c) => c.propertyName === 'revokedReason',
    );
    const revokedAt = cols.find((c) => c.propertyName === 'revokedAt');
    expect(revokedReason?.options.nullable).toBe(true);
    expect(revokedAt?.options.nullable).toBe(true);
  });

  it('declares the full 10-column shape', () => {
    const cols = getMetadataArgsStorage().columns.filter(
      (c) => c.target === EmergencyOverrideEntity,
    );
    const names = cols.map((c) => c.propertyName).sort();
    expect(names).toEqual([
      'actor',
      'createdAt',
      'environment',
      'expiresAt',
      'id',
      'kind',
      'reason',
      'revokedAt',
      'revokedReason',
      'serviceName',
    ]);
  });
});
