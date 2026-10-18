/**
 * A tank emptied by a harvest keeps its history, against a real PostgreSQL
 * (FARM-CRITICAL-454 verification).
 *
 * ## The defect being pinned
 *
 * TankBatchService now writes `primaryBatchId = null` when a tank empties. It
 * used to write `undefined`, which TypeORM skips, so an emptied tank kept naming
 * the batch that left. Three readers used that leftover as history:
 *
 * - HarvestCompletedListener found the tanks a final harvest cleared by
 *   `primaryBatchId = batchId`, so TankCleared stopped being published.
 * - The biomass draft listed a batch under `/stockings` only while a site tank
 *   named it, so a batch stocked and emptied within the month dropped out.
 * - The disease draft scoped an outbreak to a site the same way, so an
 *   unresolved outbreak of a batch with no fish left dropped out.
 *
 * ## What is asserted
 *
 * After the final harvest of a batch held in one tank, through the production
 * harvest handler:
 * - exactly one TankCleared for that tank, counting both the outbox rows the
 *   harvest committed and what the BatchHarvested listener publishes when it
 *   consumes the harvest's event;
 * - the batch stays under `/stockings` of the month it was stocked;
 * - the batch's unresolved outbreak stays in the site's disease draft.
 *
 * ## Why this needs a real database
 *
 * The leftover marker existed only in the row PostgreSQL stored: the unit specs
 * mock the emptied row, and a mock can keep a primary the writer never leaves.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { BatchHarvestedEvent, TankClearedEvent } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { makeMockEventBus } from '../../events/listeners/__tests__/make-mock-event-bus';
import {
  HealthEvent,
  HealthEventStatus,
  HealthEventType,
} from '../../fish-health/entities/health-event.entity';
import { CreateHarvestRecordCommand } from '../../harvest/commands/create-harvest-record.command';
import { QualityClass } from '../../harvest/entities/harvest-record.entity';
import {
  createFarmTenantFixture,
  createFixtureBatchWriters,
  createFixtureHarvestWriters,
  createFixtureRegulatoryAssemblers,
  FarmTenantFixture,
  FIXTURE_ENTITIES,
  FixtureHarvestWriters,
  FixtureRegulatoryAssemblers,
  HARVEST_ENTITIES,
} from './helpers/farm-tenant-fixture';
import {
  createFarmOutboxTable,
  createFarmStockReadModelTables,
  createTenantSchemaDerived,
} from './helpers/tenant-schema-harness';

const USER_ID = '9d4b2e6f-1a3c-4e58-b7d0-2c6a8e4f1b37';
const TENANT = 'f3a7c1e5-2b9d-4c68-a0e4-7b1d5f3a9c26';
const HOUR_MS = 3_600_000;

jest.setTimeout(180_000);

describe('A tank emptied by a harvest keeps its history — real Postgres (FARM-CRITICAL-454)', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  let harvest: FixtureHarvestWriters;
  let drafts: FixtureRegulatoryAssemblers;
  let fixture: FarmTenantFixture;
  let outbreak: HealthEvent;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-emptied-tank-${randomBytes(4).toString('hex')}`,
      entities: [...FIXTURE_ENTITIES, ...HARVEST_ENTITIES],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);
    await createFarmStockReadModelTables(dataSource);

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT));

    harvest = createFixtureHarvestWriters(dataSource);
    drafts = createFixtureRegulatoryAssemblers(dataSource);

    // 500 fish at 10 g, stocked 2026-04-29, in one tank of the site.
    fixture = await createFarmTenantFixture(dataSource, createFixtureBatchWriters(dataSource), {
      tenantId: TENANT,
      codePrefix: 'CLR',
      userId: USER_ID,
      initialQuantity: 500,
      initialAvgWeightG: 10,
    });

    // An outbreak recorded on the batch, not yet resolved.
    const manager = dataSource.manager;
    outbreak = await withTenantContext(TENANT, () =>
      manager.save(
        manager.create(HealthEvent, {
          tenantId: TENANT,
          batchId: fixture.batch.id,
          title: 'Gill disease outbreak',
          diseaseName: 'Amoebic gill disease',
          eventType: HealthEventType.DISEASE_OUTBREAK,
          eventDate: new Date(Date.now() - 2 * 24 * HOUR_MS),
          status: HealthEventStatus.ACTIVE,
          reportedBy: USER_ID,
        }),
      ),
    );

    // The final harvest: every fish of the batch, out of its only tank.
    await withTenantContext(TENANT, () =>
      harvest.createHarvest.execute(
        new CreateHarvestRecordCommand(
          TENANT,
          {
            batchId: fixture.batch.id,
            tankId: fixture.tank.id,
            quantityHarvested: 500,
            averageWeight: 10,
            totalBiomass: 5,
            qualityClass: QualityClass.SUPERIOR,
            harvestDate: new Date(Date.now() - HOUR_MS),
          },
          USER_ID,
          [Role.MODULE_MANAGER],
          [],
        ),
      ),
    );
  }, 240_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  it('empties the tank, which names no batch', async () => {
    const row = await withTenantContext(TENANT, () =>
      dataSource.manager.findOneOrFail(TankBatch, {
        where: { tenantId: TENANT, tankId: fixture.tank.id },
      }),
    );
    expect(Number(row.totalQuantity)).toBe(0);
    expect(row.primaryBatchId).toBeNull();
  });

  it('publishes TankCleared for the emptied tank exactly once', async () => {
    const cleared: Array<{ payload: TankClearedEvent }> = await dataSource.query(
      `SELECT "payload" FROM "farm"."outbox_events"
        WHERE "tenantId" = $1 AND "eventType" = 'TankCleared'`,
      [TENANT],
    );
    const harvested: Array<{ payload: BatchHarvestedEvent }> = await dataSource.query(
      `SELECT "payload" FROM "farm"."outbox_events"
        WHERE "tenantId" = $1 AND "eventType" = 'BatchHarvested'`,
      [TENANT],
    );
    expect(harvested).toHaveLength(1);
    expect(harvested[0]!.payload.isFinal).toBe(true);

    // The listener consumes the harvest's event as the bus delivers it.
    const bus = makeMockEventBus();
    await harvest.harvestListener(bus).handle(harvested[0]!.payload);
    const published = bus.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventType === 'TankCleared');

    const tankCleared = [...cleared.map((row) => row.payload), ...published];
    expect(tankCleared).toHaveLength(1);
    expect(tankCleared[0]).toMatchObject({
      eventType: 'TankCleared',
      tenantId: TENANT,
      tankId: fixture.tank.id,
      previousBatchId: fixture.batch.id,
    });
  });

  it('keeps the batch under the stockings of the month it was stocked', async () => {
    const { draftPayload } = await drafts.biomass.assemble(TENANT, fixture.site.id, 2026, 4);
    expect(draftPayload.stockings).toEqual([
      expect.objectContaining({ date: '2026-04-29', fishCount: 500, notes: 'CLR-BATCH' }),
    ]);
  });

  it("keeps the batch's unresolved outbreak in the site's disease draft", async () => {
    const { draftPayload } = await drafts.disease.assemble(TENANT, fixture.site.id);
    expect(draftPayload.healthEventId).toBe(outbreak.id);
  });
});
