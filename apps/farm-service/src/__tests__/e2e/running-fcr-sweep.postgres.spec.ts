/**
 * The 18:00 running-FCR sweep, verified against REAL Postgres.
 *
 * WHY this file exists at all: the sweep shipped with a predicate that could
 * never be true —
 *
 *     WHERE "isActive" = true
 *       AND status IN ('ACTIVE','GROWING')
 *       AND (fcr->>'actual')::numeric > 0
 *
 * `fcr.actual` has exactly one writer (CloseBatchHandler) and it runs in the
 * same block that sets `status = CLOSED` / `isActive = false`, so a live batch
 * always carried its create-time 0 and a nonzero row was always closed. Not one
 * FCRAlert was ever emitted in production, for months, while the consumer
 * (alert-engine FcrAlertEventHandler) sat waiting. The unit spec never caught
 * it because it mocked `manager.query` and returned rows directly — it never
 * executed the predicate, so it stayed green while the feature was dead.
 *
 * So the contract below runs the EXACT exported production SQL
 * (LIVE_BATCH_FCR_SCOPE_SQL), the REAL FCRCalculationService and the REAL
 * FeedingCronV2Service.sweepFcrForTenant against a real database, on a fixture
 * whose live batches carry `fcr.actual = 0` exactly as BatchService leaves them.
 *
 * WHY the fixture is raw SQL and the services come from Nest DI: raw TypeORM
 * repository acquisition off a DataSource is banned repo-wide
 * (tools/gates/banned-construct.ts) — it is the call that bypasses tenant
 * isolation, and spec files are deliberately NOT exempt. So:
 *   - Fixtures and read-back assertions go through `manager.query(...)` inside
 *     `runInTenantTransaction` / `runInTenantRead`, the same tenant-pinned
 *     boundaries production uses. This is the established pattern for the
 *     Postgres specs in this directory.
 *   - The service under test keeps its REAL repositories, resolved through the
 *     production DI wiring (`TypeOrmModule.forFeature` + `@InjectRepository`)
 *     rather than hand-positional construction. That is strictly stronger than
 *     what this file did before: a reordered constructor parameter used to be
 *     invisible here, and now it cannot be.
 * The create-time `weight` / `fcr` / summary documents are declared against the
 * PRODUCTION interfaces (`BatchWeight`, `BatchFCR`, …), so a shape change to
 * what `BatchService.createBatch` writes breaks this file at COMPILE time
 * instead of drifting silently into a fixture that no longer resembles a real
 * batch.
 *
 * RED-ON-REGRESSION: the scope assertions run against TENANT_A, which is never
 * swept, so every one of its batches still has `fcr.actual = 0`. Re-adding
 * `AND (fcr->>'actual')::numeric > 0` to LIVE_BATCH_FCR_SCOPE_SQL makes the
 * scope return zero rows and this suite fails immediately. The
 * `historical predicate` test pins the same fact from the other direction, and
 * the end-to-end sweep fails too because no alert would be produced.
 *
 * Runs in CI (needs Docker Postgres); not part of the unit suite.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';

import { createTenantConnectionBootstrap, getTenantSchemaName } from '@aquaculture/backend-common';
import { runInTenantRead, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import {
  bootPostgresContainer,
  HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { BatchLocation } from '../../batch/entities/batch-location.entity';
import {
  Batch,
  BatchInputType,
  BatchStatus,
  OPERATIONAL_BATCH_STATUSES,
  type BatchFCR,
  type BatchFeedingSummary,
  type BatchGrowthMetrics,
  type BatchMortalitySummary,
  type BatchWeight,
} from '../../batch/entities/batch.entity';
import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { TankAllocation } from '../../batch/entities/tank-allocation.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { OperationType, TankOperation } from '../../batch/entities/tank-operation.entity';
import { BatchDomainService } from '../../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../../batch/services/batch-lifecycle-policy.service';
import { Department } from '../../department/entities/department.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { FeedingRecord, FeedingMethod } from '../../feeding/entities/feeding-record.entity';
import { FeedingProgram } from '../../feeding/entities/feeding-program.entity';
import { FeedingProgramTank } from '../../feeding/entities/feeding-program-tank.entity';
import { BiomassGrowthApplierService } from '../../feeding-protocol/services/biomass-growth-applier.service';
import { FeedingCronV2Service } from '../../feeding-protocol/services/feeding-cron-v2.service';
import { MealPlanGeneratorService } from '../../feeding-protocol/services/meal-plan-generator.service';
import { ProtocolFeedForecastService } from '../../feeding-protocol/services/protocol-feed-forecast.service';
import { ProtocolRateService } from '../../feeding-protocol/services/protocol-rate.service';
import { GrowthMeasurement } from '../../growth/entities/growth-measurement.entity';
import {
  FCRCalculationService,
  LIVE_BATCH_FCR_SCOPE_SQL,
} from '../../growth/services/fcr-calculation.service';
import { FarmOutbox } from '../../outbox/farm-outbox.entity';
import { Site } from '../../site/entities/site.entity';
import {
  Species,
  SpeciesCategory,
  SpeciesStatus,
  SpeciesWaterType,
} from '../../species/entities/species.entity';
import { Supplier } from '../../supplier/entities/supplier.entity';
import { SubSystem } from '../../system/entities/sub-system.entity';
import { System } from '../../system/entities/system.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';

jest.setTimeout(240_000);

/** Never swept — its batches keep the pristine `fcr.actual = 0` of a fresh batch. */
const TENANT_A = '2c8f0e5a-1d3b-4a71-9c02-7f6b1e4d0a11';
/** Swept end to end — proves an alert is finally emitted and the projection lands. */
const TENANT_B = '9a41d7c3-6b28-4f0e-8d55-3e2c9b7a1044';
const USER_ID = 'f1b7b266-5e20-4c37-8ab2-b7ef18db3a21';

/**
 * The predicate EXACTLY as it shipped, kept here as executable evidence.
 *
 * WHY keep a dead query in the tree: a comment claiming "this could never
 * match" is an assertion nobody can check. Running it against a fixture full of
 * healthy, fed, live batches and getting zero rows is proof, and it keeps the
 * regression shape legible to the next reader.
 */
const HISTORICAL_UNSATISFIABLE_SQL = `
  SELECT b.id, (b.fcr->>'actual')::numeric AS actual
    FROM "batches_v2" b
   WHERE b."tenantId" = $1
     AND b."isActive" = true
     AND b.status IN ('ACTIVE', 'GROWING')
     AND (b.fcr->>'actual')::numeric > 0`;

/** Narrow a hand-built collaborator to its interface — no `any`, no double cast. */
function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

interface SeededBatch {
  readonly id: string;
  readonly status: BatchStatus;
}

interface OutboxRow {
  readonly eventType: string;
  readonly payload: {
    eventType: string;
    batchId: string;
    currentFCR: number;
    targetFCR: number;
    variancePercent: number;
    alertLevel: string;
    trend: string;
  };
}

/**
 * `batches_v2.fcr` as POSTGRES hands it back.
 *
 * WHY not reuse `BatchFCR`: that interface types `lastUpdatedAt` as `Date`
 * because the entity hydrator revives it. A raw `SELECT` returns the jsonb
 * document verbatim, so the timestamp arrives as the ISO string the projection
 * wrote (`to_jsonb($4::text)`). Typing the row honestly is what lets the
 * freshness assertion read `Date.parse(fcr.lastUpdatedAt)` with no cast.
 */
interface PersistedFcr {
  readonly target: number;
  readonly actual: number;
  readonly theoretical: number;
  readonly isUserOverride: boolean;
  readonly lastUpdatedAt: string;
}

/** The lifecycle columns `LIVE_BATCH_FCR_SCOPE_SQL` and `isOperational` read. */
interface BatchLifecycleRow {
  readonly id: string;
  readonly status: BatchStatus;
  readonly isActive: boolean;
  readonly currentQuantity: number;
}

describe('Running FCR sweep on real Postgres', () => {
  let pg: HarnessContext | undefined;
  let dataSource: DataSource | undefined;
  let moduleRef: TestingModule | undefined;
  let sweep: FeedingCronV2Service;
  const batchDomain = new BatchDomainService(new BatchLifecyclePolicyService());

  /** TENANT_A: one batch per BatchStatus, all `isActive = true`. */
  const statusMatrix: SeededBatch[] = [];
  /** TENANT_A: GROWING but retired — isolates the `isActive` clause. */
  let inactiveGrowingId = '';
  /** TENANT_B fixtures. */
  let overTargetId = '';
  let ledgerCorrectedId = '';
  let freshId = '';
  let sweepStartedAt = 0;

  /** Fail loudly instead of leaking a `undefined` DataSource into a query. */
  function requireDataSource(): DataSource {
    if (!dataSource) {
      throw new Error('Postgres harness DataSource has not been initialised');
    }
    return dataSource;
  }

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-running-fcr-${randomBytes(4).toString('hex')}`,
      entities: [
        Site,
        Department,
        Tank,
        Species,
        Batch,
        BatchDocument,
        BatchLocation,
        TankAllocation,
        TankBatch,
        TankOperation,
        Feed,
        Supplier,
        FeedingRecord,
        FeedingProgram,
        FeedingProgramTank,
        Equipment,
        EquipmentSystem,
        EquipmentType,
        System,
        SubSystem,
        GrowthMeasurement,
        FarmOutbox,
      ],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();
    await createFarmOutboxTable(dataSource);

    const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
    new TenantConnectionBootstrap(dataSource).onModuleInit();

    await createTenantSchema(dataSource, getTenantSchemaName(TENANT_A));
    await createTenantSchema(dataSource, getTenantSchemaName(TENANT_B));

    // The FCR authority is built by Nest, from the SAME @InjectRepository
    // tokens the running service resolves. `dataSourceFactory` hands the
    // module the harness DataSource that has already been synchronised and
    // pool-patched, so the repositories route through TenantConnectionBootstrap
    // exactly like production ones do.
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRootAsync({
          useFactory: (): TypeOrmModuleOptions => ({ type: 'postgres' }),
          dataSourceFactory: async (): Promise<DataSource> => requireDataSource(),
        }),
        TypeOrmModule.forFeature([
          Batch,
          BatchLocation,
          FeedingRecord,
          FeedingProgram,
          FeedingProgramTank,
          GrowthMeasurement,
          Species,
          TankOperation,
        ]),
      ],
      providers: [FCRCalculationService, ProtocolRateService],
    }).compile();
    const fcrCalculation = moduleRef.get(FCRCalculationService);

    // Only the FCR authority, the outbox and the DataSource participate in the
    // 18:00 sweep. The other constructor collaborators belong to the 05:30 /
    // 06:00 / 07:00 jobs and are never reached from this entry point, so they
    // are declared as empty stubs rather than fabricated behaviour that could
    // quietly satisfy an assertion.
    sweep = new FeedingCronV2Service(
      dataSource,
      stub<MealPlanGeneratorService>({}),
      stub<BiomassGrowthApplierService>({}),
      stub<WaterTemperatureService>({}),
      fcrCalculation,
      new OutboxPublisher(FarmOutbox),
      stub<ProtocolFeedForecastService>({}),
    );

    // ── TENANT_A: the status matrix ────────────────────────────────────────
    // Every status gets a batch with `isActive = true`, INCLUDING the terminal
    // ones. A CLOSED-but-active row is not a state production can reach; it is
    // deliberate here so the assertion isolates the STATUS dimension of the
    // predicate from the `isActive` dimension, which the extra batch below
    // covers on its own.
    const speciesA = await seedSpecies(TENANT_A, 'SP-A');
    let seq = 0;
    for (const status of Object.values(BatchStatus)) {
      seq += 1;
      const batchId = await createLiveBatch(TENANT_A, speciesA, `A-${seq}`, 500, 50);
      await setLifecycle(TENANT_A, batchId, status, true);
      statusMatrix.push({ id: batchId, status });
    }
    inactiveGrowingId = await createLiveBatch(TENANT_A, speciesA, 'A-INACTIVE', 500, 50);
    await setLifecycle(TENANT_A, inactiveGrowingId, BatchStatus.GROWING, false);

    // ── TENANT_B: three live batches with real feed + ledger history ───────
    const speciesB = await seedSpecies(TENANT_B, 'SP-B');

    // 1000 fish @ 100 g = 100 kg start; grown to 200 g = 200 kg ⇒ 100 kg growth.
    // 180 kg of recorded feed ⇒ FCR 1.80 against a 1.20 target = +50% ⇒ critical.
    overTargetId = await createLiveBatch(TENANT_B, speciesB, 'B-OVER', 1000, 100);
    await growTo(overTargetId, TENANT_B, 200, 1000);
    await recordFeed(TENANT_B, overTargetId, 180);

    // Ledger case: 100 fish died carrying 20 kg of biomass that FEED PAID FOR.
    // 900 fish @ 200 g = 180 kg live + 20 kg exited − 100 kg start = 100 kg
    // realized growth; 130 kg feed ⇒ FCR 1.30 = +8.3% ⇒ under the warning
    // threshold, so it must be PROJECTED but must NOT raise an alert.
    ledgerCorrectedId = await createLiveBatch(TENANT_B, speciesB, 'B-LEDGER', 1000, 100);
    await growTo(ledgerCorrectedId, TENANT_B, 200, 900);
    await recordFeed(TENANT_B, ledgerCorrectedId, 130);
    await recordMortalityOperation(TENANT_B, ledgerCorrectedId, 100, 20);

    // Never fed, never grown ⇒ realized growth 0 ⇒ FCR 0. Must be projected as
    // 0 (an honest "nothing to measure yet") and must not alert: without the
    // guard its variance is −100%, which reads as a flawless conversion.
    freshId = await createLiveBatch(TENANT_B, speciesB, 'B-FRESH', 1000, 100);

    for (const id of [overTargetId, ledgerCorrectedId, freshId]) {
      // Pin the target on the batch itself (an operator override) so
      // getTargetFCR resolves at step 1 of the P-14 chain. The v2-protocol
      // and legacy-program links are a different contract with their own
      // coverage; resolving them here would test those tables, not this sweep.
      await pinOperatorTargetFcr(TENANT_B, id, BatchStatus.GROWING, 1.2);
    }
  });

  afterAll(async () => {
    // Closing the module releases the DataSource it adopted; the guarded
    // destroy below still covers the path where compile() never ran.
    await moduleRef?.close();
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await shutdownHarness(pg);
  });

  // ==========================================================================
  // SCOPE — the predicate that used to be unsatisfiable
  // ==========================================================================

  it('selects live operational batches even though every one of them has fcr.actual = 0', async () => {
    const rows = await scopeOf(TENANT_A);

    // These rows were seeded with the create-time document BatchService writes,
    // so their `fcr.actual` is 0. Under the historical predicate this list was
    // necessarily empty; re-adding the `> 0` clause empties it again and fails
    // right here.
    const expected = statusMatrix
      .filter((b) => OPERATIONAL_BATCH_STATUSES.includes(b.status))
      .map((b) => b.id)
      .sort();
    expect(rows.map((r) => r.batchId).sort()).toEqual(expected);
    expect(expected).toHaveLength(4);

    const untouched = await readFcr(TENANT_A, rows[0]!.batchId);
    expect(Number(untouched.actual)).toBe(0);
  });

  it('the historical predicate returns NOTHING on that same live, healthy fixture', async () => {
    const dead = await runInTenantRead(requireDataSource(), 'farm', TENANT_A, (qr) =>
      qr.manager.query(HISTORICAL_UNSATISFIABLE_SQL, [TENANT_A]),
    );
    expect(dead).toEqual([]);
  });

  it('scopes exactly the batches that may be fed — no status may be feedable but unwatched', async () => {
    const scoped = new Set((await scopeOf(TENANT_A)).map((r) => r.batchId));

    for (const seeded of statusMatrix) {
      const batch = await readLifecycle(TENANT_A, seeded.id);
      // `assertFeedable` permits feed exactly when `isOperational` holds. Feed
      // recorded against a batch outside the sweep's scope would accumulate
      // into an FCR nobody ever looks at — the drift that let PRE_HARVEST and
      // HARVESTING batches be fed while `IN ('ACTIVE','GROWING')` ignored them.
      expect(scoped.has(seeded.id)).toBe(batchDomain.isOperational(batch));
    }
  });

  it('excludes a retired batch even while its status still reads GROWING', async () => {
    const scoped = new Set((await scopeOf(TENANT_A)).map((r) => r.batchId));
    expect(scoped.has(inactiveGrowingId)).toBe(false);
  });

  // ==========================================================================
  // END TO END — compute, alert, project
  // ==========================================================================

  it('recomputes, alerts on and projects the running FCR of every live batch', async () => {
    expect(await outboxEvents(TENANT_B)).toEqual([]); // no FCRAlert has ever existed here
    sweepStartedAt = Date.now() - 1;

    await sweep.sweepFcrForTenant(TENANT_B);

    // ── The alert production never once emitted ─────────────────────────
    const alerts = await outboxEvents(TENANT_B);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!.payload;
    expect(alert.eventType).toBe('FCRAlert');
    expect(alert.batchId).toBe(overTargetId);
    expect(alert.currentFCR).toBeCloseTo(1.8, 3); // 180 kg feed / 100 kg growth
    expect(alert.targetFCR).toBeCloseTo(1.2, 3);
    expect(alert.variancePercent).toBeCloseTo(50, 3);
    expect(alert.alertLevel).toBe('critical');

    // ── The projection the UI reads ─────────────────────────────────────
    // 1.30 = 130 kg feed / (180 kg live + 20 kg exited − 100 kg start). The
    // exited biomass counts because feed paid for its growth; dropping it gives
    // 1.625 and overstates the loss.
    for (const [id, expected] of [
      [overTargetId, 1.8],
      [ledgerCorrectedId, 1.3],
      [freshId, 0],
    ] as const) {
      const fcr = await readFcr(TENANT_B, id);
      expect(Number(fcr.actual)).toBeCloseTo(expected, 6);
      expect(Date.parse(fcr.lastUpdatedAt)).toBeGreaterThan(sweepStartedAt);
      // Untouched keys of the same jsonb document survive the partial update.
      expect(Number(fcr.target)).toBeCloseTo(1.2, 6);
      expect(fcr.isUserOverride).toBe(true);
    }

    // The 1.30 batch sits 8.3% over its target — under the 10% warning line —
    // so it is PROJECTED but must not alert. The fresh batch has no realized
    // growth: FCR 0 means "nothing to measure", and without the guard its
    // −100% variance would have read as a flawless conversion.
    const alerted = alerts.map((row) => row.payload.batchId);
    expect(alerted).not.toContain(ledgerCorrectedId);
    expect(alerted).not.toContain(freshId);
  });

  it('leaves a LIVE batch carrying a nonzero fcr.actual — the state the old predicate needed and could never reach', async () => {
    // Deliberately ordered after the sweep: this is the "and now it would have
    // worked" epilogue. Before the projection existed, no execution of the
    // sweep on any fixture could put a live row into this state.
    const revived: Array<{ id: string }> = await runInTenantRead(
      requireDataSource(),
      'farm',
      TENANT_B,
      (qr) => qr.manager.query(HISTORICAL_UNSATISFIABLE_SQL, [TENANT_B]),
    );
    expect(revived.map((r) => r.id).sort()).toEqual([overTargetId, ledgerCorrectedId].sort());
  });

  // ==========================================================================
  // HELPERS
  //
  // Every fixture write goes through `runInTenantTransaction` and every
  // read-back through `runInTenantRead`: both pin `search_path` to the tenant
  // schema and ASSERT the connection actually resolved there before the
  // statement runs, so a fixture that silently landed in the source schema
  // fails loudly instead of producing a green test on the wrong rows.
  // ==========================================================================

  async function scopeOf(tenantId: string): Promise<Array<{ batchId: string }>> {
    return runInTenantRead(requireDataSource(), 'farm', tenantId, (qr) =>
      qr.manager.query(LIVE_BATCH_FCR_SCOPE_SQL, [tenantId, [...OPERATIONAL_BATCH_STATUSES]]),
    );
  }

  async function outboxEvents(tenantId: string): Promise<OutboxRow[]> {
    return requireDataSource().query(
      `SELECT "eventType", "payload" FROM "farm"."outbox_events"
        WHERE "tenantId" = $1 ORDER BY "id"`,
      [tenantId],
    );
  }

  /** @returns the seeded species id — the only thing a batch needs from it. */
  async function seedSpecies(tenantId: string, code: string): Promise<string> {
    const id = randomUUID();
    await runInTenantTransaction(requireDataSource(), 'farm', tenantId, (qr) =>
      qr.manager.query(
        `INSERT INTO "species" (
           "id", "tenantId", "code", "scientificName", "commonName",
           "category", "waterType", "status",
           "isActive", "isCleanerFish", "isDeleted", "tags",
           "createdBy", "updatedBy", "version")
         VALUES ($1, $2, $3, 'Salmo salar', 'Atlantic Salmon',
                 $4, $5, $6,
                 true, false, false, '[]'::jsonb,
                 $7, $7, 1)`,
        [
          id,
          tenantId,
          code,
          SpeciesCategory.FISH,
          SpeciesWaterType.SALTWATER,
          SpeciesStatus.ACTIVE,
          USER_ID,
        ],
      ),
    );
    return id;
  }

  /**
   * A batch exactly as production creates one: live, QUARANTINE, fcr.actual = 0.
   *
   * The five jsonb documents are declared against the PRODUCTION interfaces, so
   * they are the same shape `BatchService.createBatch` persists and a change to
   * either side is a compile error here rather than silent fixture drift.
   * `version` is supplied explicitly because `@VersionColumn` is NOT NULL with
   * no database default — TypeORM seeds it on save, raw SQL must not skip it.
   *
   * @returns the new batch id.
   */
  async function createLiveBatch(
    tenantId: string,
    speciesId: string,
    batchNumber: string,
    quantity: number,
    avgWeightG: number,
  ): Promise<string> {
    const id = randomUUID();
    const initialBiomass = (quantity * avgWeightG) / 1000;
    const stampedAt = new Date();

    const weight: BatchWeight = {
      initial: {
        avgWeight: avgWeightG,
        totalBiomass: initialBiomass,
        measuredAt: stampedAt,
      },
      theoretical: {
        avgWeight: avgWeightG,
        totalBiomass: initialBiomass,
        lastCalculatedAt: stampedAt,
        basedOnFCR: 1.2,
      },
      actual: {
        avgWeight: avgWeightG,
        totalBiomass: initialBiomass,
        lastMeasuredAt: stampedAt,
        sampleSize: 0,
        confidencePercent: 0,
      },
      variance: {
        weightDifference: 0,
        percentageDifference: 0,
        isSignificant: false,
      },
    };
    const fcr: BatchFCR = {
      target: 1.2,
      actual: 0,
      theoretical: 1.2,
      isUserOverride: false,
      lastUpdatedAt: stampedAt,
    };
    const feedingSummary: BatchFeedingSummary = { totalFeedGiven: 0, totalFeedCost: 0 };
    const growthMetrics: BatchGrowthMetrics = {
      growthRate: { actual: 0, target: 0, variancePercent: 0 },
      daysInProduction: 0,
      projections: { confidenceLevel: 'low' },
    };
    const mortalitySummary: BatchMortalitySummary = { totalMortality: 0, mortalityRate: 0 };

    await runInTenantTransaction(requireDataSource(), 'farm', tenantId, (qr) =>
      qr.manager.query(
        `INSERT INTO "batches_v2" (
           "id", "tenantId", "batchNumber", "speciesId", "inputType",
           "initialQuantity", "currentQuantity", "totalMortality", "cullCount",
           "totalFeedConsumed", "totalFeedCost", "stockedAt", "currency",
           "status", "isActive",
           "weight", "fcr", "feedingSummary", "growthMetrics", "mortalitySummary",
           "createdBy", "version")
         VALUES ($1, $2, $3, $4, $5,
                 $6, $6, 0, 0,
                 0, 0, $7, 'USD',
                 $8, true,
                 $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
                 $14, 1)`,
        [
          id,
          tenantId,
          batchNumber,
          speciesId,
          BatchInputType.FRY,
          quantity,
          '2026-05-01',
          BatchStatus.QUARANTINE,
          JSON.stringify(weight),
          JSON.stringify(fcr),
          JSON.stringify(feedingSummary),
          JSON.stringify(growthMetrics),
          JSON.stringify(mortalitySummary),
          USER_ID,
        ],
      ),
    );
    return id;
  }

  /** Move the batch onto the exact lifecycle coordinates the scope predicate reads. */
  async function setLifecycle(
    tenantId: string,
    batchId: string,
    status: BatchStatus,
    isActive: boolean,
  ): Promise<void> {
    await runInTenantTransaction(requireDataSource(), 'farm', tenantId, (qr) =>
      qr.manager.query(
        `UPDATE "batches_v2"
            SET "status" = $3, "isActive" = $4
          WHERE "id" = $1 AND "tenantId" = $2`,
        [batchId, tenantId, status, isActive],
      ),
    );
  }

  /**
   * An operator override of the FCR target — step 1 of the P-14 target chain.
   *
   * `jsonb_set` (not a whole-document rewrite) so the assertion that the sweep's
   * partial projection leaves neighbouring keys alone is testing the SWEEP, not
   * a fixture that happened to write the same values.
   */
  async function pinOperatorTargetFcr(
    tenantId: string,
    batchId: string,
    status: BatchStatus,
    target: number,
  ): Promise<void> {
    await runInTenantTransaction(requireDataSource(), 'farm', tenantId, (qr) =>
      qr.manager.query(
        `UPDATE "batches_v2"
            SET "status" = $3,
                "fcr" = jsonb_set(
                          jsonb_set("fcr", '{target}', to_jsonb($4::numeric)),
                          '{isUserOverride}', 'true'::jsonb)
          WHERE "id" = $1 AND "tenantId" = $2`,
        [batchId, tenantId, status, target],
      ),
    );
  }

  /** Move the batch's authoritative (measured) weight and live count forward. */
  async function growTo(
    batchId: string,
    tenantId: string,
    avgWeightG: number,
    currentQuantity: number,
  ): Promise<void> {
    await runInTenantTransaction(requireDataSource(), 'farm', tenantId, (qr) =>
      qr.manager.query(
        `UPDATE "batches_v2"
            SET "weight" = jsonb_set(
                             jsonb_set("weight", '{actual,avgWeight}', to_jsonb($3::numeric)),
                             '{actual,totalBiomass}', to_jsonb($4::numeric)),
                "currentQuantity" = $5
          WHERE "id" = $1 AND "tenantId" = $2`,
        [batchId, tenantId, avgWeightG, (currentQuantity * avgWeightG) / 1000, currentQuantity],
      ),
    );
  }

  /**
   * Feed recorded against the batch — the numerator of `calculateCumulativeFCR`.
   *
   * `feedId` / `tankId` here are synthetic uuids rather than seeded rows: the
   * per-tenant tables are cloned with `LIKE ... INCLUDING ALL`, which does not
   * copy foreign keys, and the FCR ledger reads neither the feed nor the tank —
   * only `batchId`, `actualAmount`, `operationType` and `biomassKg`. Seeding a
   * site → department → tank → feed chain would add fixture surface that this
   * contract does not exercise and cannot fail on.
   */
  async function recordFeed(tenantId: string, batchId: string, kg: number): Promise<void> {
    await runInTenantTransaction(requireDataSource(), 'farm', tenantId, (qr) =>
      qr.manager.query(
        `INSERT INTO "feeding_records" (
           "id", "tenantId", "batchId", "feedId",
           "feedingDate", "feedingTime", "feedingSequence", "totalMealsToday",
           "plannedAmount", "actualAmount", "variance", "variancePercent",
           "feedingMethod", "fedBy")
         VALUES ($1, $2, $3, $4,
                 '2026-06-01', '08:00', 1, 1,
                 $5, $5, 0, 0,
                 $6, $7)`,
        [randomUUID(), tenantId, batchId, randomUUID(), kg, FeedingMethod.MANUAL, USER_ID],
      ),
    );
  }

  /** Mortality on the TankOperation ledger — biomass that grew on feed and left. */
  async function recordMortalityOperation(
    tenantId: string,
    batchId: string,
    quantity: number,
    biomassKg: number,
  ): Promise<void> {
    await runInTenantTransaction(requireDataSource(), 'farm', tenantId, (qr) =>
      qr.manager.query(
        `INSERT INTO "tank_operations" (
           "id", "tenantId", "tankId", "batchId",
           "operationType", "operationDate", "quantity", "biomassKg",
           "isCleanerFishOperation", "isDeleted", "performedBy")
         VALUES ($1, $2, $3, $4,
                 $5, '2026-06-15', $6, $7,
                 false, false, $8)`,
        [
          randomUUID(),
          tenantId,
          randomUUID(),
          batchId,
          OperationType.MORTALITY,
          quantity,
          biomassKg,
          USER_ID,
        ],
      ),
    );
  }

  /** Read the persisted FCR projection back out of the tenant schema. */
  async function readFcr(tenantId: string, batchId: string): Promise<PersistedFcr> {
    const rows: Array<{ fcr: PersistedFcr }> = await runInTenantRead(
      requireDataSource(),
      'farm',
      tenantId,
      (qr) =>
        qr.manager.query(`SELECT "fcr" FROM "batches_v2" WHERE "id" = $1 AND "tenantId" = $2`, [
          batchId,
          tenantId,
        ]),
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`batch ${batchId} not found in tenant ${tenantId}`);
    }
    return row.fcr;
  }

  /**
   * Hydrate the domain object `BatchDomainService.isOperational` judges.
   *
   * It reads `status` only, but the row carries the whole lifecycle tuple so
   * the comparison is made against what POSTGRES holds, never against the
   * in-memory expectation the fixture loop built.
   */
  async function readLifecycle(tenantId: string, batchId: string): Promise<Batch> {
    const rows: BatchLifecycleRow[] = await runInTenantRead(
      requireDataSource(),
      'farm',
      tenantId,
      (qr) =>
        qr.manager.query(
          `SELECT "id", "status", "isActive", "currentQuantity"
             FROM "batches_v2" WHERE "id" = $1 AND "tenantId" = $2`,
          [batchId, tenantId],
        ),
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`batch ${batchId} not found in tenant ${tenantId}`);
    }
    return Object.assign(new Batch(), row);
  }
});

/**
 * Clone every tenant-owned table into a tenant schema.
 *
 * Derived from the DataSource metadata rather than a hand-written list: an
 * entity that declares `schema:` is cross-tenant infrastructure (the outbox)
 * and must stay in `farm`, everything else is per-tenant (ADR-011). A hardcoded
 * list would silently miss a table added later.
 */
async function createTenantSchema(dataSource: DataSource, schema: string): Promise<void> {
  await dataSource.query(`CREATE SCHEMA "${schema}"`);
  for (const meta of dataSource.entityMetadatas) {
    if (meta.schema || !meta.synchronize) continue;
    await dataSource.query(
      `CREATE TABLE "${schema}"."${meta.tableName}" (LIKE "farm"."${meta.tableName}" INCLUDING ALL)`,
    );
  }
}

async function createFarmOutboxTable(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS "farm"."outbox_events" (
      "id" BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      "eventType" VARCHAR(100) NOT NULL,
      "tenantId" UUID NULL,
      "aggregateId" UUID NULL,
      "payload" JSONB NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "publishedAt" TIMESTAMPTZ NULL,
      "retryCount" INTEGER NOT NULL DEFAULT 0,
      "lastError" TEXT NULL,
      "nextAttemptAt" TIMESTAMPTZ NULL,
      "idempotencyKey" VARCHAR(255) NULL,
      "isDeadLettered" BOOLEAN NOT NULL DEFAULT false,
      "leasedAt" TIMESTAMPTZ NULL,
      "leasedBy" VARCHAR(128) NULL
    )
  `);
}
