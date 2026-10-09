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
import {
  createFarmOutboxTable,
  createTenantSchemaDerived,
} from '../../../__tests__/e2e/helpers/tenant-schema-harness';
import { ExtendParamEquipmentToChannelSources1822000000000 } from '../../../database/migrations/1822000000000-ExtendParamEquipmentToChannelSources';
import { ParameterQuantityDeclaration } from '../../entities/parameter-quantity-declaration.entity';
import { WaterQualityMeasurement } from '../../entities/water-quality-measurement.entity';
import { WaterQualityParamEquipment } from '../../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../../entities/water-quality-parameter-config.entity';

/**
 * A real Postgres with one tenant schema shaped the way prod's tenant schemas
 * are: cloned from the `farm` source with LIKE … INCLUDING ALL (prod
 * tenant_7f6b08ab90e246d3 was built so), every index under a Postgres-generated
 * name, then migrated by 1822000000000, which adds what LIKE does not carry
 * (the parameter quantity trigger) and its named indexes beside the cloned
 * ones. The source carries the Baseline's legacy unique (tenant, parameter,
 * equipment), so the clone holds it under a generated name too — the
 * migration must find and drop it by definition, or a backup or a re-added
 * source at an equipment point fails here as it would in prod.
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
  await dataSource.query(
    `CREATE UNIQUE INDEX "IDX_3283cafd2982b3e394ac021307"
       ON farm.water_quality_param_equipment ("tenantId", "parameterConfigId", "equipmentId")`,
  );
  await createTenantSchemaDerived(dataSource, schema);
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
