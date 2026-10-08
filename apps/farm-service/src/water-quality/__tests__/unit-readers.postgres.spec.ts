/**
 * The water-quality unit readers against a real PostgreSQL (FARM-HIGH-372,
 * FARM-HIGH-367).
 *
 * The dashboard's critical list (criticalWaterQuality) joined its "latest per
 * unit" subquery on unquoted `latest.tankId` / `latest.maxDate`. TypeORM quotes
 * the subquery's column aliases ("tankId", "maxDate") but leaves references to
 * a derived table untouched, so Postgres folded them to lowercase and every
 * call failed with `column latest.tankid does not exist`. A mocked
 * EntityManager returns whatever it is handed, so the unit specs stayed green;
 * only the SQL the query builder generates, run on Postgres, proves the join.
 *
 * Rows are seeded in each shape the writers have produced: a tank filed as
 * tankId, a non-tank unit filed as equipmentId, and a tank the old batch writer
 * filed only as equipmentId. Each reader must find each one by its unit.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

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
import {
  WaterQualityMeasurement,
  WaterQualityStatus,
} from '../entities/water-quality-measurement.entity';
import { GetLatestWaterQualityHandler } from '../query-handlers/get-latest-water-quality.handler';
import { GetTankWaterQualityStatisticsHandler } from '../query-handlers/get-tank-water-quality-statistics.handler';
import { ListCriticalWaterQualityHandler } from '../query-handlers/list-critical-water-quality.handler';
import { ListWaterQualityHandler } from '../query-handlers/list-water-quality.handler';
import { GetLatestWaterQualityQuery } from '../queries/get-latest-water-quality.query';
import { GetTankWaterQualityStatisticsQuery } from '../queries/get-tank-water-quality-statistics.query';
import { ListCriticalWaterQualityQuery } from '../queries/list-critical-water-quality.query';
import { ListWaterQualityQuery } from '../queries/list-water-quality.query';

jest.setTimeout(120_000);

const TENANT = '6d0f3a41-5d0b-4c3e-9a51-0f6f3c1b7e21';
const TANK = '11111111-1111-4111-8111-111111111111';
const BIOFILTER = '22222222-2222-4222-8222-222222222222';
const BATCH_TANK = '33333333-3333-4333-8333-333333333333';

interface SeedRow {
  tankId: string | null;
  equipmentId: string | null;
  measuredAt: string;
  status: WaterQualityStatus;
}

const ROWS: SeedRow[] = [
  // The tank: an older critical row, then its latest — warning.
  {
    tankId: TANK,
    equipmentId: null,
    measuredAt: '2026-10-01T06:00:00Z',
    status: WaterQualityStatus.CRITICAL,
  },
  {
    tankId: TANK,
    equipmentId: null,
    measuredAt: '2026-10-02T06:00:00Z',
    status: WaterQualityStatus.WARNING,
  },
  // A non-tank unit: tankId NULL, latest critical.
  {
    tankId: null,
    equipmentId: BIOFILTER,
    measuredAt: '2026-10-03T06:00:00Z',
    status: WaterQualityStatus.CRITICAL,
  },
  // A tank filed by the old batch writer: equipmentId only, latest optimal.
  {
    tankId: null,
    equipmentId: BATCH_TANK,
    measuredAt: '2026-10-01T06:00:00Z',
    status: WaterQualityStatus.CRITICAL,
  },
  {
    tankId: null,
    equipmentId: BATCH_TANK,
    measuredAt: '2026-10-04T06:00:00Z',
    status: WaterQualityStatus.OPTIMAL,
  },
];

describe('water-quality unit readers — real Postgres', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-wq-unit-readers-${randomBytes(4).toString('hex')}`,
      entities: [...FIXTURE_ENTITIES, WaterQualityMeasurement],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();
    const schema = getTenantSchemaName(TENANT);
    await createTenantSchemaDerived(dataSource, schema);

    // Tenant schemas carry no FKs (LIKE … INCLUDING ALL copies none), so the
    // rows name units directly — the readers never join a unit table here.
    for (const row of ROWS) {
      await dataSource.query(
        `INSERT INTO "${schema}"."water_quality_measurements"
           ("tenantId", "tankId", "equipmentId", "measuredAt", "source", "parameters",
            "overallStatus", "hasAlarm")
         VALUES ($1, $2, $3, $4, 'manual', '{}'::jsonb, $5, false)`,
        [TENANT, row.tankId, row.equipmentId, row.measuredAt, row.status],
      );
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  it('the critical list runs and returns each unit’s latest non-optimal row', async () => {
    const rows = await new ListCriticalWaterQualityHandler(dataSource).execute(
      new ListCriticalWaterQualityQuery(TENANT),
    );

    const byUnit = rows.map((row) => [row.tankId ?? row.equipmentId, row.overallStatus]);
    expect(byUnit).toHaveLength(2);
    expect(byUnit).toEqual(
      expect.arrayContaining([
        [TANK, WaterQualityStatus.WARNING],
        [BIOFILTER, WaterQualityStatus.CRITICAL],
      ]),
    );
  });

  it('the list, latest and statistics find a unit wherever it was filed', async () => {
    const biofilter = await new ListWaterQualityHandler(dataSource).execute(
      new ListWaterQualityQuery(TENANT, { unitId: BIOFILTER }),
    );
    expect(biofilter.items.map((row) => row.equipmentId)).toEqual([BIOFILTER]);

    const batchTank = await new ListWaterQualityHandler(dataSource).execute(
      new ListWaterQualityQuery(TENANT, { tankId: BATCH_TANK }),
    );
    expect(batchTank.total).toBe(2);

    const latest = await new GetLatestWaterQualityHandler(dataSource).execute(
      new GetLatestWaterQualityQuery(TENANT, BATCH_TANK),
    );
    expect(latest?.overallStatus).toBe(WaterQualityStatus.OPTIMAL);

    const stats = await new GetTankWaterQualityStatisticsHandler(dataSource).execute(
      new GetTankWaterQualityStatisticsQuery(TENANT, TANK, 36_500),
    );
    expect(stats.measurementCount).toBe(2);
    expect(stats.criticalCount).toBe(1);
    expect(stats.lastMeasurement?.overallStatus).toBe(WaterQualityStatus.WARNING);
  });
});
