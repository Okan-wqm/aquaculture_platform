import { DataSource } from 'typeorm';

import { TenantSchemaSyncService } from '../tenant-schema-sync.service';

function dataSourceDouble(query?: jest.Mock): DataSource {
  const dataSource = new DataSource({
    type: 'postgres',
    database: 'tenant-schema-sync-spec',
  });
  if (query) {
    jest.spyOn(dataSource, 'query').mockImplementation(query);
  }
  return dataSource;
}

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
    const service = new TenantSchemaSyncService(dataSourceDouble());
    jest.spyOn(service, 'detectAllTenantSchemas').mockResolvedValue({
      tablesMissing: 0,
      columnsMissing: 1,
      drift: [],
      errors: ['tenant_abcd1234abcd1234.code_sequences: missing tenantId'],
    });

    await expect(service.onApplicationBootstrap()).rejects.toThrow(/tenant-schema drift detected/);
  });

  it('fails application bootstrap when strict mode sees detector errors', async () => {
    process.env['STRICT_TENANT_SCHEMA_DRIFT'] = 'true';
    const service = new TenantSchemaSyncService(dataSourceDouble());
    jest.spyOn(service, 'detectAllTenantSchemas').mockResolvedValue({
      tablesMissing: 0,
      columnsMissing: 0,
      drift: [],
      errors: ['source schema missing from search_path'],
    });

    await expect(service.onApplicationBootstrap()).rejects.toThrow(/tenant-schema drift detected/);
  });

  it('keeps legacy non-strict bootstrap observable without hiding the error log path', async () => {
    process.env['STRICT_TENANT_SCHEMA_DRIFT'] = 'false';
    const service = new TenantSchemaSyncService(dataSourceDouble());
    jest
      .spyOn(service, 'detectAllTenantSchemas')
      .mockRejectedValue(new Error('catalog unavailable'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('records an error when tenant schemas exist but source schema is missing', async () => {
    const dataSource = dataSourceDouble(
      jest
        .fn()
        .mockResolvedValueOnce([{ schema_name: 'tenant_0123456789abcdef' }])
        .mockResolvedValueOnce([{ search_path: 'public' }]),
    );
    const service = new TenantSchemaSyncService(dataSource);

    await expect(service.detectAllTenantSchemas()).resolves.toMatchObject({
      tablesMissing: 0,
      columnsMissing: 0,
      errors: [
        'Could not detect source schema from connection search_path; tenant drift scan cannot determine the source SSoT.',
      ],
    });
  });

  it('records an error when source schema is not declared in MODULE_SCHEMAS', async () => {
    const dataSource = dataSourceDouble(
      jest
        .fn()
        .mockResolvedValueOnce([{ schema_name: 'tenant_0123456789abcdef' }])
        .mockResolvedValueOnce([{ search_path: 'unknown_schema_xyz,public' }]),
    );
    const service = new TenantSchemaSyncService(dataSource);

    await expect(service.detectAllTenantSchemas()).resolves.toMatchObject({
      tablesMissing: 0,
      columnsMissing: 0,
      errors: [
        'No MODULE_SCHEMAS entry for source schema "unknown_schema_xyz"; tenant drift scan cannot determine table ownership.',
      ],
    });
  });
});
