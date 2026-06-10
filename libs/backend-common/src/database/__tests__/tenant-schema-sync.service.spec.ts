import { DataSource } from 'typeorm';

import { TenantSchemaSyncService } from '../tenant-schema-sync.service';

describe('TenantSchemaSyncService strict mode', () => {
  const originalStrict = process.env['STRICT_TENANT_SCHEMA_DRIFT'];

  afterEach(() => {
    if (originalStrict === undefined) {
      delete process.env['STRICT_TENANT_SCHEMA_DRIFT'];
    } else {
      process.env['STRICT_TENANT_SCHEMA_DRIFT'] = originalStrict;
    }
    jest.restoreAllMocks();
  });

  it('fails application bootstrap when strict mode sees tenant sync errors', async () => {
    process.env['STRICT_TENANT_SCHEMA_DRIFT'] = 'true';
    const service = new TenantSchemaSyncService({} as DataSource);
    jest.spyOn(service, 'detectAllTenantSchemas').mockResolvedValue({
      tablesMissing: 0,
      columnsMissing: 1,
      drift: [],
      errors: ['tenant_abcd1234abcd1234.code_sequences: missing tenantId'],
    });

    await expect(service.onApplicationBootstrap()).rejects.toThrow(/tenant-schema drift detected/);
  });

  it('keeps legacy non-strict bootstrap observable without hiding the error log path', async () => {
    process.env['STRICT_TENANT_SCHEMA_DRIFT'] = 'false';
    const service = new TenantSchemaSyncService({} as DataSource);
    jest
      .spyOn(service, 'detectAllTenantSchemas')
      .mockRejectedValue(new Error('catalog unavailable'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
