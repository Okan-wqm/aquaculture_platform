import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource, EntityMetadata } from 'typeorm';

import {
  createSchemaDriftValidator,
  SCHEMA_DRIFT_CLEAN_SIGNAL,
} from '../schema-drift-validator.service';

type ValidatorCtor = new (
  dataSource: DataSource,
  configService: ConfigService,
) => OnApplicationBootstrap;

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      const value = values[key];
      return value === undefined ? defaultValue : value;
    }),
  } as unknown as ConfigService;
}

function validator(
  dataSource: DataSource,
  configService: ConfigService,
  serviceName = 'auth',
  schemaName?: string,
): OnApplicationBootstrap {
  const Validator = createSchemaDriftValidator(
    serviceName,
    schemaName,
  ) as unknown as ValidatorCtor;
  return new Validator(dataSource, configService);
}

describe('SchemaDriftValidator boot signal contract', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits the exact schema drift clean boot signal when no violations exist', async () => {
    const dataSource = {
      entityMetadatas: [],
      query: jest.fn(),
    } as unknown as DataSource;

    await validator(
      dataSource,
      config({ NODE_ENV: 'production' }),
    ).onApplicationBootstrap();

    expect(logSpy).toHaveBeenCalledWith(
      SCHEMA_DRIFT_CLEAN_SIGNAL,
      expect.objectContaining({
        bootSignal: 'schema_drift_clean',
        status: 'ok',
        serviceName: 'auth',
        schemaName: 'auth',
        checkedOwnedEntities: 0,
        skippedCrossSchemaReadViews: 0,
        warningViolations: 0,
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('fails production startup by default when error-level drift exists', async () => {
    const entity = {
      synchronize: true,
      schema: 'auth',
      tableName: 'users',
      columns: [],
      checks: [],
    } as unknown as EntityMetadata;
    const dataSource = {
      entityMetadatas: [entity],
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM pg_tables')) {
          return [{ schemaname: 'public' }];
        }
        if (sql.includes('FROM observability.emergency_overrides')) {
          return [];
        }
        return [];
      }),
    } as unknown as DataSource;

    await expect(
      validator(dataSource, config({ NODE_ENV: 'production' }))
        .onApplicationBootstrap(),
    ).rejects.toThrow(/Schema drift detected in 1 place/);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('schema.drift.detected service="auth"'),
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      SCHEMA_DRIFT_CLEAN_SIGNAL,
      expect.anything(),
    );
  });

  it('refuses production startup when schema drift validation is disabled', async () => {
    const dataSource = {
      entityMetadatas: [],
      query: jest.fn(),
    } as unknown as DataSource;

    await expect(
      validator(
        dataSource,
        config({
          NODE_ENV: 'production',
          SCHEMA_DRIFT_ENABLED: 'false',
        }),
      ).onApplicationBootstrap(),
    ).rejects.toThrow(/Schema drift validator disabled/);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalledWith(
      SCHEMA_DRIFT_CLEAN_SIGNAL,
      expect.anything(),
    );
  });

  it('refuses staging startup when schema drift validation is disabled', async () => {
    const dataSource = {
      entityMetadatas: [],
      query: jest.fn(),
    } as unknown as DataSource;

    await expect(
      validator(
        dataSource,
        config({
          AQUA_ENV: 'staging',
          SCHEMA_DRIFT_ENABLED: 'false',
        }),
      ).onApplicationBootstrap(),
    ).rejects.toThrow(/Schema drift validator disabled/);

    expect(logSpy).not.toHaveBeenCalledWith(
      SCHEMA_DRIFT_CLEAN_SIGNAL,
      expect.anything(),
    );
  });

  it('emits clean with structured warning count for warn-only drift', async () => {
    const entity = {
      synchronize: true,
      schema: 'auth',
      tableName: 'users',
      columns: [],
      checks: [],
    } as unknown as EntityMetadata;
    const dataSource = {
      entityMetadatas: [entity],
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM pg_tables')) {
          return [{ schemaname: 'auth' }];
        }
        if (sql.includes('information_schema.columns')) {
          return [
            {
              column_name: 'legacy_column',
              data_type: 'text',
              is_nullable: 'YES',
            },
          ];
        }
        if (sql.includes('FROM pg_constraint')) {
          return [];
        }
        return [];
      }),
    } as unknown as DataSource;

    await validator(
      dataSource,
      config({ NODE_ENV: 'production' }),
    ).onApplicationBootstrap();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('schema.drift.warn service="auth"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      SCHEMA_DRIFT_CLEAN_SIGNAL,
      expect.objectContaining({
        bootSignal: 'schema_drift_clean',
        status: 'ok',
        warningViolations: 1,
      }),
    );
  });

  it('uses schemaName for tenant-aware source schema resolution', async () => {
    const entity = {
      synchronize: true,
      schema: undefined,
      tableName: 'alert_incidents',
      columns: [],
      checks: [],
    } as unknown as EntityMetadata;
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM pg_tables')) {
        return [{ schemaname: 'alert' }];
      }
      if (
        sql.includes('information_schema.columns') ||
        sql.includes('FROM pg_constraint')
      ) {
        return [];
      }
      return [];
    });
    const dataSource = {
      entityMetadatas: [entity],
      query,
    } as unknown as DataSource;

    await validator(
      dataSource,
      config({ NODE_ENV: 'production' }),
      'alert-engine',
      'alert',
    ).onApplicationBootstrap();

    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'alert_incidents',
      'alert',
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      SCHEMA_DRIFT_CLEAN_SIGNAL,
      expect.objectContaining({
        serviceName: 'alert-engine',
        schemaName: 'alert',
      }),
    );
  });

  it('does not emit clean when an emergency bypass suppresses fatal drift', async () => {
    const entity = {
      synchronize: true,
      schema: 'auth',
      tableName: 'users',
      columns: [],
      checks: [],
    } as unknown as EntityMetadata;
    const dataSource = {
      entityMetadatas: [entity],
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM pg_tables')) {
          return [{ schemaname: 'public' }];
        }
        if (sql.includes('FROM observability.emergency_overrides')) {
          return [
            {
              id: 'override-1',
              service_name: 'auth',
              kind: 'drift_fatal_bypass',
              reason: 'breakglass',
              actor: 'operator',
              expires_at: new Date(Date.now() + 60_000),
              environment: 'production',
            },
          ];
        }
        return [];
      }),
    } as unknown as DataSource;

    await validator(
      dataSource,
      config({ NODE_ENV: 'production' }),
    ).onApplicationBootstrap();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('schema.drift.bypassed service="auth"'),
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      SCHEMA_DRIFT_CLEAN_SIGNAL,
      expect.anything(),
    );
  });

  it('does not emit clean when an owned table is missing', async () => {
    const entity = {
      synchronize: true,
      schema: 'auth',
      tableName: 'users',
      columns: [],
      checks: [],
    } as unknown as EntityMetadata;
    const dataSource = {
      entityMetadatas: [entity],
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM pg_tables')) {
          return [];
        }
        if (sql.includes('FROM observability.emergency_overrides')) {
          return [];
        }
        return [];
      }),
    } as unknown as DataSource;

    await expect(
      validator(dataSource, config({ NODE_ENV: 'production' }))
        .onApplicationBootstrap(),
    ).rejects.toThrow(/Schema drift detected/);

    expect(logSpy).not.toHaveBeenCalledWith(
      SCHEMA_DRIFT_CLEAN_SIGNAL,
      expect.anything(),
    );
  });
});
