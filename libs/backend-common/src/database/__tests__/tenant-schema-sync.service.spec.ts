import { DataSource } from 'typeorm';

import { TenantSchemaSyncService } from '../tenant-schema-sync.service';

describe('TenantSchemaSyncService strict mode', () => {
  const originalStrict = process.env['TENANT_SCHEMA_SYNC_STRICT'];

  afterEach(() => {
    if (originalStrict === undefined) {
      delete process.env['TENANT_SCHEMA_SYNC_STRICT'];
    } else {
      process.env['TENANT_SCHEMA_SYNC_STRICT'] = originalStrict;
    }
    jest.restoreAllMocks();
  });

  it('fails application bootstrap when strict mode sees tenant sync errors', async () => {
    process.env['TENANT_SCHEMA_SYNC_STRICT'] = 'true';
    const service = new TenantSchemaSyncService({} as DataSource);
    jest.spyOn(service, 'detectAllTenantSchemas').mockResolvedValue({
      tablesMissing: 0,
      columnsMissing: 1,
      drift: [],
      errors: ['tenant_abcd1234abcd1234.code_sequences: missing tenantId'],
    });

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      /tenant-schema drift detected/,
    );
  });

  it('keeps legacy non-strict bootstrap observable without hiding the error log path', async () => {
    process.env['TENANT_SCHEMA_SYNC_STRICT'] = 'false';
    const service = new TenantSchemaSyncService({} as DataSource);
    jest.spyOn(service, 'detectAllTenantSchemas').mockRejectedValue(new Error('catalog unavailable'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
