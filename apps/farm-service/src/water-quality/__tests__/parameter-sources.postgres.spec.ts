/**
 * The parameter-source writers and readers on real PostgreSQL (FARM-HIGH-373).
 *
 * The tenant schema is derived from the entities (synchronize into `farm`,
 * then LIKE … INCLUDING ALL, as tenant schemas are cloned) and then migrated
 * by 1822000000000, which adds what LIKE does not copy (the quantity trigger).
 * The writers run through the real tenant transaction, so the generated point
 * key, the live-row uniques, the CHECKs and the parameter lock are the ones
 * production runs against.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { withTenantContext } from '@aquaculture/backend-common/context';
import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
} from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { FIXTURE_ENTITIES } from '../../__tests__/e2e/helpers/farm-tenant-fixture';
import { createTenantSchemaDerived } from '../../__tests__/e2e/helpers/tenant-schema-harness';
import { ExtendParamEquipmentToChannelSources1822000000000 } from '../../database/migrations/1822000000000-ExtendParamEquipmentToChannelSources';
import { BulkMapParamsEquipmentCommand } from '../commands/bulk-map-params-equipment.command';
import { CreateParamEquipmentCommand } from '../commands/create-param-equipment.command';
import { DeleteParamEquipmentCommand } from '../commands/delete-param-equipment.command';
import { ParameterQuantityDeclaration } from '../entities/parameter-quantity-declaration.entity';
import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { BulkMapParamsEquipmentHandler } from '../handlers/bulk-map-params-equipment.handler';
import { CreateParamEquipmentHandler } from '../handlers/create-param-equipment.handler';
import { DeleteParamEquipmentHandler } from '../handlers/delete-param-equipment.handler';
import { ListParamEquipmentQuery } from '../queries/list-param-equipment.query';
import { ListParamEquipmentHandler } from '../query-handlers/list-param-equipment.handler';
import { mappedCodesForUnit } from '../services/measurement-plan';

import { seedSourceTopology, type SourceTopology } from './helpers/source-topology';

jest.setTimeout(180_000);

const TENANT = '5b9c2a10-7c1d-4e2f-8a3b-9c0d1e2f3a4b';
const USER = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';

const SOURCE_ENTITIES = [
  ...FIXTURE_ENTITIES,
  WaterQualityMeasurement,
  WaterQualityParameterConfig,
  WaterQualityParamEquipment,
  ParameterQuantityDeclaration,
];

describe('parameter sources — real Postgres', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let topology: SourceTopology;
  const schema = getTenantSchemaName(TENANT);

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    await pg.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-wq-sources-${randomBytes(4).toString('hex')}`,
      entities: SOURCE_ENTITIES,
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();
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
    topology = await seedSourceTopology(dataSource, schema, TENANT, USER);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  const create = (
    unitId: string,
    parameterConfigId: string,
    sensorId?: string,
  ): Promise<WaterQualityParamEquipment> =>
    withTenantContext(TENANT, () =>
      new CreateParamEquipmentHandler(dataSource).execute(
        new CreateParamEquipmentCommand(
          TENANT,
          { parameterConfigId, equipmentId: unitId, sensorId },
          USER,
        ),
      ),
    );

  it('plans a parameter at a tank as a tank point — the unit the old handler answered 404 for', async () => {
    const line = await create(topology.tankId, topology.configs.ph);
    expect(line).toEqual(
      expect.objectContaining({ tankId: topology.tankId, equipmentId: null, boundBy: USER }),
    );
    await expect(create(topology.tankId, topology.configs.ph)).rejects.toThrow(
      /already in the plan/,
    );
    await expect(
      create(topology.tankId, topology.configs.temperature, topology.sensorId),
    ).rejects.toThrow(/bindParameterChannel/);
    const codes = await withTenantContext(TENANT, () =>
      dataSource.transaction((manager) => mappedCodesForUnit(manager, TENANT, topology.tankId)),
    );
    expect([...codes]).toEqual(['ph']);
  });

  it('removes a plan line by unbinding it, keeps it as history, and lets it be planned again', async () => {
    const line = await create(topology.biofilterId, topology.configs.temperature);
    expect(line.equipmentId).toBe(topology.biofilterId);
    await withTenantContext(TENANT, () =>
      new DeleteParamEquipmentHandler(dataSource).execute(
        new DeleteParamEquipmentCommand(TENANT, line.id, USER),
      ),
    );
    await create(topology.biofilterId, topology.configs.temperature);
    const rows: Array<{ unbound: boolean; unboundBy: string | null }> = await dataSource.query(
      `SELECT "unboundAt" IS NOT NULL AS unbound, "unboundBy"
         FROM "${schema}".water_quality_param_equipment
        WHERE "equipmentId" = $1 ORDER BY "boundAt"`,
      [topology.biofilterId],
    );
    expect(rows).toEqual([
      { unbound: true, unboundBy: USER },
      { unbound: false, unboundBy: null },
    ]);
    const listed = await withTenantContext(TENANT, () =>
      new ListParamEquipmentHandler(dataSource).execute(
        new ListParamEquipmentQuery(TENANT, { equipmentId: topology.biofilterId }),
      ),
    );
    expect(listed).toHaveLength(1);
  });

  it('bulk-plans at a tank, skipping what is planned and parameters the tenant lacks', async () => {
    const plan = await withTenantContext(TENANT, () =>
      new BulkMapParamsEquipmentHandler(dataSource).execute(
        new BulkMapParamsEquipmentCommand(
          TENANT,
          {
            equipmentId: topology.tankId,
            parameterConfigIds: [
              topology.configs.ph,
              topology.configs.temperature,
              'ffffffff-ffff-4fff-8fff-ffffffffffff',
            ],
          },
          USER,
        ),
      ),
    );
    expect(plan.map((line) => line.parameterConfigId).sort()).toEqual(
      [topology.configs.ph, topology.configs.temperature].sort(),
    );
    expect(plan.every((line) => line.tankId === topology.tankId)).toBe(true);
  });
});
