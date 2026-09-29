/**
 * FARM-HIGH-334 — the mortality daily-rate alarm counts the day's deaths, on
 * real Postgres.
 *
 * WHY Postgres: the defect lived in the meeting of a `date` column and a
 * timestamp parameter. `recordDate: MoreThan(<midnight>)` compares the stored
 * DATE (read as that day 00:00) with a midnight TIMESTAMP, and "today 00:00 >
 * today 00:00" is false — so every row of the current day was excluded and the
 * daily-rate alarm could never fire. Only the database decides that comparison,
 * so only a database can prove it and its fix.
 *
 * The chain under test is production's: RecordMortalityHandler writes the
 * record and enqueues MortalityRecorded; the listener, reading through
 * MortalityAlertContextReader, raises MortalityAlertRaised — with the tank's
 * site (ALERT-MEDIUM-007) — and fires the cumulative rate only on a crossing.
 */
// Production containers run in UTC (no TZ is set in the compose files); pin it
// so the pre-fix exclusion reproduces the way it does in production.
process.env.TZ = 'UTC';

import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';

import {
  createTenantConnectionBootstrap,
  getTenantSchemaName,
  withTenantContext,
} from '@aquaculture/backend-common';
import { Role } from '@aquaculture/backend-common/decorators';
import type { IEvent, IEventBus } from '@platform/event-bus';
import type { MortalityAlertRaisedEvent, MortalityRecordedEvent } from '@platform/event-contracts';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, MoreThan } from 'typeorm';

import {
  MortalityReason,
  RecordMortalityCommand,
} from '../../batch/commands/record-mortality.command';
import { makeMockEventBus } from '../../events/listeners/__tests__/make-mock-event-bus';
import { FarmMobileCommandReceipt } from '../../mobile-command/entities/farm-mobile-command-receipt.entity';
import {
  FIXTURE_ENTITIES,
  createFarmTenantFixture,
  createFixtureBatchWriters,
  type FarmTenantFixture,
} from './helpers/farm-tenant-fixture';
import {
  createMortalityAlertHarness,
  type MortalityAlertHarness,
} from './helpers/mortality-alert-harness';
import {
  createFarmOutboxTable,
  createFarmStockReadModelTables,
  createSourceEquipmentTypesReferenceTable,
  createTenantSchemaDerived,
} from './helpers/tenant-schema-harness';

const TENANT_ID = '5d0c1a52-8b6e-4f7a-9c3d-2e1f0a9b8c7d';
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';

jest.setTimeout(120_000);

/** The listener's bus double (the real bus is NATS); `published` = what it raised. */
function recordingBus(): { bus: jest.Mocked<IEventBus>; published: () => IEvent[] } {
  const bus = makeMockEventBus();
  return { bus, published: () => bus.publish.mock.calls.map(([event]) => event) };
}

function isMortalityAlert(event: IEvent): event is MortalityAlertRaisedEvent {
  return event.eventType === 'MortalityAlertRaised';
}

describe('Mortality daily window on real Postgres (FARM-HIGH-334)', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let harness: MortalityAlertHarness;
  let fixture: FarmTenantFixture;

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');
    await createSourceEquipmentTypesReferenceTable(pg.dataSource);

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-mortality-window-${randomBytes(4).toString('hex')}`,
      // The mortality writer is stock-mutating: it refuses a command without an
      // idempotency envelope and records the envelope's receipt, so the receipt
      // table is part of what this suite's writes touch.
      entities: [...FIXTURE_ENTITIES, FarmMobileCommandReceipt],
      synchronize: true,
      logging: false,
      // UTC session, as the production database runs.
      extra: { options: '-c search_path=farm,public -c TimeZone=UTC' },
    });
    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);
    await createFarmStockReadModelTables(dataSource);

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();
    await createTenantSchemaDerived(dataSource, getTenantSchemaName(TENANT_ID));

    const writers = createFixtureBatchWriters(dataSource);
    fixture = await createFarmTenantFixture(dataSource, writers, {
      tenantId: TENANT_ID,
      codePrefix: 'MW',
      userId: USER_ID,
      initialQuantity: 1000,
    });

    harness = createMortalityAlertHarness(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  /** Record deaths through the production writer; return the event it enqueued. */
  async function record(quantity: number, observedAt: Date): Promise<MortalityRecordedEvent> {
    await withTenantContext(TENANT_ID, () =>
      harness.recordMortality.execute(
        new RecordMortalityCommand(
          TENANT_ID,
          fixture.batch.id,
          {
            tankId: fixture.tank.id,
            quantity,
            avgWeightG: 10,
            reason: MortalityReason.WATER_QUALITY,
            observedAt,
            notes: 'mortality window proof',
          },
          USER_ID,
          [Role.MODULE_MANAGER],
          [],
          // Production fronts make the envelope mandatory (FARM-HIGH-052); one
          // fresh command id per record, as a client would mint.
          {
            clientCommandId: randomUUID(),
            payloadHash: randomBytes(32).toString('hex'),
            operationType: 'recordMortality',
          },
        ),
      ),
    );
    const rows = await harness.outbox.find({
      where: { eventType: 'MortalityRecorded' },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    const payload: unknown = rows[0]?.payload;
    // The outbox payload IS the wire event; round-trip it as the bus delivers it.
    return JSON.parse(JSON.stringify(payload));
  }

  it("excluded today's deaths with the pre-fix filter and counts them with the stored-day window", async () => {
    // SCENARIO: 20 of 1000 fish die today; the record is stored as a `date`.
    // EXPECTS: the pre-fix predicate (recordDate > today's midnight) finds NONE of
    //          today's rows on real Postgres — the defect — while the stored-day
    //          window counts all 20 and rates them against the day's start
    //          population (20 / 1000 = 2%).
    const event = await record(20, new Date());

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const preFixRows = await withTenantContext(TENANT_ID, () =>
      harness.mortalityRecords.find({
        where: { batchId: fixture.batch.id, recordDate: MoreThan(midnight) },
      }),
    );
    const allRows = await withTenantContext(TENANT_ID, () =>
      harness.mortalityRecords.find({ where: { batchId: fixture.batch.id } }),
    );
    expect(allRows).toHaveLength(1);
    expect(preFixRows).toHaveLength(0);

    const daily = await withTenantContext(TENANT_ID, () => harness.reader.dailyMortality(event));
    expect(daily.todayCount).toBe(20);
    expect(daily.todayRate).toBeCloseTo(2, 5);
  });

  it('raises a site-scoped daily-rate alarm, and the cumulative alarm only on its crossing', async () => {
    // SCENARIO: the batch is at 2% (20 dead); 40 more die (6% ≥ 5% warning), then 5 more (6.5%).
    // EXPECTS: the 40-fish record raises daily_rate (critical: 60/1000 = 6% ≥ 1%) and
    //          cumulative_rate (warning, the crossing) — both naming the tank's site;
    //          the 5-fish record raises NO cumulative alarm (already above).
    const first = recordingBus();
    await harness.listener(first.bus).handle(await record(40, new Date()));
    const firstAlerts = first.published().filter(isMortalityAlert);

    expect(firstAlerts.find((a) => a.alertType === 'daily_rate')).toMatchObject({
      severity: 'critical',
      siteId: fixture.site.id,
    });
    expect(firstAlerts.find((a) => a.alertType === 'cumulative_rate')).toMatchObject({
      severity: 'warning',
      siteId: fixture.site.id,
    });

    const second = recordingBus();
    await harness.listener(second.bus).handle(await record(5, new Date()));
    const secondAlerts = second.published().filter(isMortalityAlert);
    expect(secondAlerts.filter((a) => a.alertType === 'cumulative_rate')).toHaveLength(0);
  });
});
