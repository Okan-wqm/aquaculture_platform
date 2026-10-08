import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
} from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { FIXTURE_ENTITIES } from '../../../__tests__/e2e/helpers/farm-tenant-fixture';
import { createFarmOutboxTable } from '../../../__tests__/e2e/helpers/tenant-schema-harness';
import { ExtendParamEquipmentToChannelSources1822000000000 } from '../../../database/migrations/1822000000000-ExtendParamEquipmentToChannelSources';
import { ParameterQuantityDeclaration } from '../../entities/parameter-quantity-declaration.entity';
import { WaterQualityMeasurement } from '../../entities/water-quality-measurement.entity';
import { WaterQualityParamEquipment } from '../../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../../entities/water-quality-parameter-config.entity';

/**
 * A real Postgres with one tenant schema shaped the way production's is: the
 * entities synchronized into the `farm` source schema, each per-tenant table
 * cloned from it with its constraints and its indexes UNDER THEIR OWN NAMES
 * (production builds tenant schemas by migration replay, so an index is
 * `UQ_wqpe_manual_source` there, and the commands name the rule they hit
 * from that name — LIKE … INCLUDING INDEXES would rename every copy), then
 * migrated by 1822000000000, which adds what a clone does not carry (the
 * parameter quantity trigger).
 */
export interface SourceDatabase {
  readonly pg: HarnessContext;
  readonly dataSource: DataSource;
  readonly schema: string;
}

export async function bootSourceDatabase(tenantId: string): Promise<SourceDatabase> {
  const pg = await bootPostgresContainer({ startTimeoutMs: 120_000 });
  await pg.dataSource.query('CREATE SCHEMA farm');
  await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  // The outbox is migration-owned (synchronize: false); the point-delete
  // handlers enqueue into it.
  await createFarmOutboxTable(pg.dataSource);
  const dataSource = new DataSource({
    type: 'postgres',
    ...pg.connectionOptions,
    name: `farm-service-wq-sources-${randomBytes(4).toString('hex')}`,
    entities: [
      ...FIXTURE_ENTITIES,
      WaterQualityMeasurement,
      WaterQualityParameterConfig,
      WaterQualityParamEquipment,
      ParameterQuantityDeclaration,
    ],
    synchronize: true,
    logging: false,
    extra: { options: '-c search_path=farm,public' },
  });
  await dataSource.initialize();
  const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
  new TenantConnectionBootstrap(dataSource).onModuleInit();
  const schema = getTenantSchemaName(tenantId);
  await cloneTenantSchema(dataSource, schema);
  const runner = dataSource.createQueryRunner();
  try {
    await runner.query(`SET search_path TO "${schema}", public`);
    await runner.startTransaction();
    await new ExtendParamEquipmentToChannelSources1822000000000().up(runner);
    await runner.commitTransaction();
  } finally {
    await runner.release();
  }
  return { pg, dataSource, schema };
}

export async function shutdownSourceDatabase(database: SourceDatabase | undefined): Promise<void> {
  if (database === undefined) return;
  if (database.dataSource.isInitialized) await database.dataSource.destroy();
  await shutdownHarness(database.pg);
}

async function cloneTenantSchema(dataSource: DataSource, schema: string): Promise<void> {
  await dataSource.query(`CREATE SCHEMA "${schema}"`);
  const crossTenant = new Set(
    dataSource.entityMetadatas
      .filter((metadata) => metadata.schema !== undefined)
      .map((metadata) => metadata.tableName),
  );
  const tables: Array<{ table_name: string }> = await dataSource.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'farm' AND table_type = 'BASE TABLE'`,
  );
  for (const { table_name: table } of tables) {
    if (crossTenant.has(table)) continue;
    await dataSource.query(
      `CREATE TABLE "${schema}"."${table}" (LIKE "farm"."${table}"
         INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED INCLUDING IDENTITY)`,
    );
    const indexes: Array<{ indexdef: string }> = await dataSource.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'farm' AND tablename = $1`,
      [table],
    );
    for (const { indexdef } of indexes) {
      await dataSource.query(
        indexdef
          .replace(` ON farm.`, ` ON "${schema}".`)
          .replace(` ON "farm".`, ` ON "${schema}".`),
      );
    }
  }
}
