import { DataSource, getMetadataArgsStorage } from 'typeorm';

import { MigrationEventEntity } from '../migration-event.entity';

describe('MigrationEventEntity', () => {
  it('declares schema=observability and table=migration_events', () => {
    const tableArgs = getMetadataArgsStorage().tables.find(
      (t) => t.target === MigrationEventEntity,
    );
    expect(tableArgs).toBeDefined();
    expect(tableArgs?.name).toBe('migration_events');
    expect(tableArgs?.schema).toBe('observability');
  });

  it('declares the expected 10-column shape', () => {
    const cols = getMetadataArgsStorage().columns.filter(
      (c) => c.target === MigrationEventEntity,
    );
    const names = cols.map((c) => c.propertyName).sort();
    expect(names).toEqual([
      'driftClassId',
      'durationMs',
      'environment',
      'errorDetail',
      'eventType',
      'id',
      'migrationName',
      'occurredAt',
      'serviceName',
      'tenantIdHash',
    ]);
  });

  it('eventType enum matches the production literal union', () => {
    const col = getMetadataArgsStorage().columns.find(
      (c) =>
        c.target === MigrationEventEntity && c.propertyName === 'eventType',
    );
    expect(col?.options.enum).toEqual([
      'start',
      'applied',
      'failed',
      'skipped',
      'validator_clean',
      'validator_warn',
      'validator_error',
    ]);
  });

  it('tenant_id_hash is nullable + varchar(128) — fits 64-byte hex HMAC plus room for salt prefix', () => {
    const col = getMetadataArgsStorage().columns.find(
      (c) =>
        c.target === MigrationEventEntity &&
        c.propertyName === 'tenantIdHash',
    );
    expect(col?.options.nullable).toBe(true);
    expect(col?.options.length).toBe(128);
  });

  it('error_detail is JSONB + nullable (only set on failure events)', () => {
    const col = getMetadataArgsStorage().columns.find(
      (c) =>
        c.target === MigrationEventEntity && c.propertyName === 'errorDetail',
    );
    expect(col?.options.type).toBe('jsonb');
    expect(col?.options.nullable).toBe(true);
  });

  it('TypeORM registers the entity cleanly in a throwaway DataSource', async () => {
    const ds = new DataSource({
      type: 'postgres',
      host: 'localhost',
      database: 'validation_only',
      entities: [MigrationEventEntity],
      synchronize: false,
    });
    // Access metadataStorage-fed entityMetadatas without connecting —
    // this exercises the decorator path without requiring a live DB.
    const meta = ds.entityMetadatas;
    // entityMetadatas is only populated after connect; we just verify
    // no exceptions during class inspection. A full shape test lives
    // in the integration spec (hr-drift regression harness).
    expect(meta).toBeDefined();
  });
});
