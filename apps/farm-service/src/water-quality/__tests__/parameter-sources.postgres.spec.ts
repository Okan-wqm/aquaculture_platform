/**
 * The parameter-source writers and readers on real PostgreSQL (FARM-HIGH-373).
 *
 * The tenant schema is production-shaped (helpers/source-database.ts). The
 * writers run through the real tenant transaction, so the generated point
 * key, the live-row uniques, the CHECKs and the parameter lock are the ones
 * production runs against.
 */
import 'reflect-metadata';

import { withTenantContext } from '@aquaculture/backend-common/context';
import type { DataSource } from 'typeorm';

import { BulkMapParamsEquipmentCommand } from '../commands/bulk-map-params-equipment.command';
import { CreateParamEquipmentCommand } from '../commands/create-param-equipment.command';
import { DeleteParamEquipmentCommand } from '../commands/delete-param-equipment.command';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';
import { BulkMapParamsEquipmentHandler } from '../handlers/bulk-map-params-equipment.handler';
import { CreateParamEquipmentHandler } from '../handlers/create-param-equipment.handler';
import { DeleteParamEquipmentHandler } from '../handlers/delete-param-equipment.handler';
import { ListParamEquipmentQuery } from '../queries/list-param-equipment.query';
import { ListParamEquipmentHandler } from '../query-handlers/list-param-equipment.handler';
import { mappedCodesForUnit } from '../services/measurement-plan';

import {
  bootSourceDatabase,
  shutdownSourceDatabase,
  type SourceDatabase,
} from './helpers/source-database';
import { seedSourceTopology, type SourceTopology } from './helpers/source-topology';

jest.setTimeout(180_000);

const TENANT = '5b9c2a10-7c1d-4e2f-8a3b-9c0d1e2f3a4b';
const USER = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';

describe('parameter sources — real Postgres', () => {
  let database: SourceDatabase | undefined;
  let dataSource: DataSource;
  let schema: string;
  let topology: SourceTopology;

  beforeAll(async () => {
    database = await bootSourceDatabase(TENANT);
    ({ dataSource, schema } = database);
    topology = await seedSourceTopology(dataSource, schema, TENANT, USER);
  });

  afterAll(async () => {
    await shutdownSourceDatabase(database);
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
