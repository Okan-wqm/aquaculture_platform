/**
 * The feeding engine under the production row security, on REAL Postgres.
 *
 * ## The defect this pins
 *
 * Every tenant table — and the cross-tenant ledgers `farm.feeding_job_runs` and
 * `farm.tenant_localization` — carries FORCED row-level security (policy:
 * `tenantId = app.current_tenant`, or the audited bypass). A cron tick has no
 * request, so the pool is deny-by-default: a query on a bare QueryRunner sees
 * ZERO rows and an INSERT is refused. The hourly tick's tenant discovery,
 * its `feeding_job_runs` claim and its zone read were all bare, so on
 * production the engine found no tenant, wrote no run and generated no day
 * plan: `farm.feeding_job_runs` stayed empty and the tenant had one day plan
 * ever. No unit spec could see it (mocks do not enforce RLS) and the other
 * farm postgres specs run as the owner role, which bypasses RLS.
 *
 * ## The stage
 *
 * Non-owner runtime role (what `farm_service` is), FORCE RLS armed by the
 * platform helper exactly as db-migrate arms it, the platform tenant↔schema
 * mapping the cross-tenant workers read, six tenants, and the real services:
 * `FeedingCronV2Service` (discovery + hourly tick), `FeedingJobRunService`,
 * `SiteTimeZoneService`, `TenantLocalizationProjectionListener`. Only the job
 * BODIES (plan generation …) are replaced — this spec is about whether the
 * tick reaches a tenant and records the run, not about plan arithmetic.
 *
 * Every refusal is paired with an acceptance on the same stage, so a
 * deny-everything implementation fails this spec as surely as a leaky one.
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';

import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  armTenantRls,
  publishActiveTenantMappings,
  publishRetainedTenantMappings,
} from '@aquaculture/backend-common/database/testing';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import { stub } from '@aquaculture/testing';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { TenantUpdatedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { SiteTimeZoneService } from '../../localization/services/site-time-zone.service';
import { TenantLocalizationProjectionListener } from '../../localization/listeners/tenant-localization-projection.listener';
import { TenantLocalization } from '../../localization/entities/tenant-localization.entity';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FeedingJobRun } from '../entities/feeding-job-run.entity';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { FeedingClockService } from '../services/feeding-clock.service';
import { FeedingCronV2Service } from '../services/feeding-cron-v2.service';
import { FeedingJobRunService } from '../services/feeding-job-run.service';
import { MealFinalizationService } from '../services/meal-finalization.service';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { ProtocolFeedForecastService } from '../services/protocol-feed-forecast.service';

/** Stocked tank, NO assignment: the new tenant that must not open feedless. */
const STOCKED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** An active batch and nothing else. */
const BATCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** Nothing at all. */
const IDLE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** A paused assignment (a full harvest, an operator pause) and nothing else. */
const PAUSED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
/** A recent day plan, and an Oslo localization row (06:10 local at 04:10Z in July). */
const OSLO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
/** A day plan older than the rollup window: history only. */
const OLD_PLAN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
/** Suspended by the platform: in the retained ledger, not in the active one. */
const SUSPENDED = '99999999-9999-4999-8999-999999999999';

const ACTIVE = [STOCKED, BATCH, IDLE, PAUSED, OSLO, OLD_PLAN];
const RETAINED = [...ACTIVE, SUSPENDED];

interface Stage {
  readonly harness: HarnessContext;
  readonly admin: DataSource;
  readonly runtime: DataSource;
}

/**
 * Only the columns the discovery probes read: the probes are plain SQL over
 * these tables, and the entity-backed raw-SQL gate keeps their real columns
 * honest. The two cross-tenant ledgers below are built from the REAL entities.
 */
const tenantDdl = (schema: string): string[] => [
  `CREATE SCHEMA "${schema}"`,
  `CREATE TABLE "${schema}"."feeding_protocol_assignments" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL, status text NOT NULL)`,
  `CREATE TABLE "${schema}"."feeding_day_plans" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL, "planDate" date NOT NULL)`,
  `CREATE TABLE "${schema}"."tank_batches" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL, "totalQuantity" numeric NOT NULL DEFAULT 0)`,
  `CREATE TABLE "${schema}"."batches_v2" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL, "isActive" boolean NOT NULL DEFAULT false)`,
  `CREATE TABLE "${schema}"."farm_mobile_command_receipts" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL)`,
  `CREATE TABLE "${schema}"."feeding_forecast_snapshots" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL)`,
];

async function bootStage(): Promise<Stage> {
  const harness = await bootPostgresContainer({ startTimeoutMs: 180_000 });
  const admin = harness.dataSource;
  const role = `farm_rls_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');

  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await admin.query('CREATE SCHEMA IF NOT EXISTS farm');
  await admin.query('CREATE SCHEMA IF NOT EXISTS platform');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);

  // The cross-tenant ledgers, from the real entities (schema: 'farm').
  const sourceDdl = new DataSource({
    type: 'postgres',
    ...harness.connectionOptions,
    name: `farm-rls-source-${role}`,
    entities: [FeedingJobRun, TenantLocalization],
    synchronize: true,
    logging: false,
  });
  await sourceDdl.initialize();
  await sourceDdl.destroy();
  await armTenantRls(admin, {
    schemaOverride: 'farm',
    includeTables: ['feeding_job_runs', 'tenant_localization'],
  });
  await admin.query(
    `GRANT USAGE ON SCHEMA farm, platform, public TO ${role};
     GRANT SELECT, INSERT, UPDATE, DELETE ON farm.feeding_job_runs, farm.tenant_localization TO ${role}`,
  );

  for (const tenantId of RETAINED) {
    const schema = getTenantSchemaName(tenantId);
    for (const statement of tenantDdl(schema)) await admin.query(statement);
    await armTenantRls(admin, { schemaOverride: schema });
    await admin.query(
      `GRANT USAGE ON SCHEMA "${schema}" TO ${role};
       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`,
    );
  }

  await publishActiveTenantMappings(admin, ACTIVE);
  await publishRetainedTenantMappings(admin, RETAINED);
  await admin.query(
    `GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO ${role};
     GRANT EXECUTE ON FUNCTION platform.list_retained_tenant_schema_mappings() TO ${role}`,
  );

  const runtime = new DataSource({
    type: 'postgres',
    ...harness.connectionOptions,
    username: role,
    password,
    name: `farm-rls-runtime-${role}`,
    entities: [FeedingJobRun, TenantLocalization],
    synchronize: false,
    logging: false,
  });
  await runtime.initialize();
  return { harness, admin, runtime };
}

/** Seed through the owner connection (it bypasses RLS, as db-migrate and the seeds do). */
async function seed(admin: DataSource): Promise<void> {
  const insert = (
    tenantId: string,
    table: string,
    columns: string,
    values: string,
  ): Promise<unknown> =>
    admin.query(
      `INSERT INTO "${getTenantSchemaName(tenantId)}"."${table}" ("tenantId"${columns}) VALUES ('${tenantId}'${values})`,
    );
  await insert(STOCKED, 'tank_batches', ', "totalQuantity"', ', 1000');
  await insert(BATCH, 'batches_v2', ', "isActive"', ', true');
  await insert(PAUSED, 'feeding_protocol_assignments', ', status', `, 'paused'`);
  await insert(OSLO, 'feeding_day_plans', ', "planDate"', ', CURRENT_DATE - 10');
  await insert(OLD_PLAN, 'feeding_day_plans', ', "planDate"', ', CURRENT_DATE - 400');
  await insert(SUSPENDED, 'feeding_day_plans', ', "planDate"', ', CURRENT_DATE - 3');
  await admin.query(
    `INSERT INTO farm.tenant_localization ("tenantId", "timezone", "updatedAt")
     VALUES ('${OSLO}', 'Europe/Oslo', now())`,
  );
}

describe('feeding engine under FORCE RLS (real Postgres, non-owner runtime role)', () => {
  let stage: Stage;
  let cron: FeedingCronV2Service;
  let jobRuns: FeedingJobRunService;
  let zones: SiteTimeZoneService;
  const generate = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    stage = await bootStage();
    await seed(stage.admin);

    jobRuns = new FeedingJobRunService(stage.runtime);
    zones = new SiteTimeZoneService(stage.runtime);
    cron = new FeedingCronV2Service(
      stage.runtime,
      createScheduledJobTestExecutor().executor,
      stub<MealPlanGeneratorService>({}),
      stub<BiomassGrowthApplierService>({}),
      stub<WaterTemperatureService>({}),
      stub<FCRCalculationService>({}),
      stub<OutboxPublisher>({}),
      stub<ProtocolFeedForecastService>({}),
      stub<DayPlanRecalcService>({}),
      stub<MealFinalizationService>({}),
      stub<FeedingClockService>({}),
      jobRuns,
      zones,
    );
    // The job BODY is replaced by a recording double: what is under test is
    // the tick reaching each tenant and recording the run, not the plan maths.
    Object.defineProperty(cron, 'generateForTenant', { value: generate });
  });

  afterAll(async () => {
    if (stage.runtime.isInitialized) await stage.runtime.destroy();
    await shutdownHarness(stage.harness);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Only Date is faked: the pg driver keeps its real timers. */
  const at = (iso: string): void => {
    jest.useFakeTimers({
      now: new Date(iso),
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  };

  const runs = async (): Promise<Array<Record<string, unknown>>> =>
    stage.admin.query(
      `SELECT "tenantId", "jobName", "localDate"::text AS "localDate", "timezone", "status", "attempts"
         FROM farm.feeding_job_runs ORDER BY "tenantId", "jobName"`,
    );

  describe('the failure this fixes (controls)', () => {
    it('a bare QueryRunner sees NO row of a tenant that has one — what the cron did', async () => {
      const probe = `SELECT 1 WHERE EXISTS (
        SELECT 1 FROM "${getTenantSchemaName(STOCKED)}"."tank_batches" WHERE "totalQuantity" > 0)`;

      // The owner (db-migrate, seeds) bypasses RLS: the row is there.
      await expect(stage.admin.query(probe)).resolves.toHaveLength(1);
      // The runtime role outside any tenant context: nothing.
      await expect(stage.runtime.query(probe)).resolves.toEqual([]);
    });

    it('a bare INSERT into the run ledger is refused', async () => {
      await expect(
        stage.runtime.query(
          `INSERT INTO farm.feeding_job_runs ("tenantId", "jobName", "localDate", "timezone", "status", "attempts", "startedAt")
           VALUES ('${STOCKED}', 'generate-day-plans', CURRENT_DATE, 'UTC', 'running', 1, now())`,
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('tenant discovery', () => {
    it('finds exactly the tenants that have something to feed — every arm of the probe', async () => {
      const tenants = (await cron.feedingTenants()).sort();

      // STOCKED: a tank with fish and no assignment (FARM-MEDIUM-284); BATCH: an
      // active batch; PAUSED: a paused assignment; OSLO: a plan inside the window.
      expect(tenants).toEqual([STOCKED, BATCH, PAUSED, OSLO].sort());
    });

    it('leaves out an idle tenant, a plan older than the window and a suspended tenant', async () => {
      const tenants = await cron.feedingTenants();

      expect(tenants).not.toContain(IDLE);
      expect(tenants).not.toContain(OLD_PLAN);
      expect(tenants).not.toContain(SUSPENDED);
    });

    it('retention discovery reaches history and suspended tenants, but not an idle one', async () => {
      const tenants = (await cron.tenantsForRetention()).sort();

      expect(tenants).toEqual([OSLO, OLD_PLAN, SUSPENDED].sort());
    });
  });

  describe('the hourly tick, end to end', () => {
    it('reads the tenant zone under RLS, claims and settles the run in that tenant', async () => {
      generate.mockClear();
      // 04:10Z in July = 06:10 in Oslo (CEST): only the Oslo tenant is on its hour.
      at('2026-07-20T04:10:00Z');

      await cron.hourlyTick();

      expect(generate.mock.calls).toEqual([[OSLO]]);
      expect(await runs()).toEqual([
        {
          tenantId: OSLO,
          jobName: 'generate-day-plans',
          localDate: '2026-07-20',
          timezone: 'Europe/Oslo',
          status: 'succeeded',
          attempts: 1,
        },
      ]);
    });

    it('serves every discovered tenant on its own hour and records each run', async () => {
      generate.mockClear();
      at('2026-07-20T06:10:00Z'); // 06:10 UTC: the tenants with no localization row

      await cron.hourlyTick();

      expect(generate.mock.calls.map((call) => call[0]).sort()).toEqual(
        [STOCKED, BATCH, PAUSED].sort(),
      );
      const ledger = (await runs()).filter((row) => row['tenantId'] !== OSLO);
      expect(ledger.map((row) => [row['tenantId'], row['timezone'], row['status']]).sort()).toEqual(
        [STOCKED, BATCH, PAUSED].sort().map((tenantId) => [tenantId, 'UTC', 'succeeded']),
      );
    });

    it('a tenant whose run already succeeded today is not run again', async () => {
      generate.mockClear();
      at('2026-07-20T06:40:00Z');

      await cron.hourlyTick();

      expect(generate).not.toHaveBeenCalled();
    });
  });

  describe('the run ledger is tenant-scoped', () => {
    it("one tenant's context cannot see another tenant's runs", async () => {
      const seen: Array<{ tenantId: string }> = await stage.runtime.transaction(async (manager) => {
        await manager.query(`SELECT set_config('app.current_tenant', $1, true)`, [BATCH]);
        return manager.query(`SELECT "tenantId" FROM farm.feeding_job_runs`);
      });

      expect(seen).toEqual([expect.objectContaining({ tenantId: BATCH })]);
    });

    it('the monthly purge removes only the tenant’s own expired runs', async () => {
      await stage.admin.query(
        `INSERT INTO farm.feeding_job_runs ("tenantId", "jobName", "localDate", "timezone", "status", "attempts", "startedAt")
         VALUES ('${STOCKED}', 'old', CURRENT_DATE - 300, 'UTC', 'failed', 1, now() - interval '200 days'),
                ('${BATCH}',   'old', CURRENT_DATE - 300, 'UTC', 'failed', 1, now() - interval '200 days')`,
      );

      await expect(jobRuns.purgeOlderThanRetention(STOCKED)).resolves.toBe(1);

      const old = await stage.admin.query(
        `SELECT "tenantId" FROM farm.feeding_job_runs WHERE "jobName" = 'old'`,
      );
      expect(old).toEqual([{ tenantId: BATCH }]);
      // The 4 succeeded runs are untouched; only BATCH's own expired row is left besides them.
      expect((await runs()).filter((row) => row['status'] === 'succeeded')).toHaveLength(4);
    });
  });

  describe('tenant localization', () => {
    it('zone reads are per tenant: a tenant with a row gets it, the rest get UTC', async () => {
      const map = await zones.tenantZones([OSLO, IDLE]);

      expect([...map]).toEqual([
        [OSLO, 'Europe/Oslo'],
        [IDLE, 'UTC'],
      ]);
    });

    it('the projection writes under the tenant context, and the zone is then readable', async () => {
      const listener = new TenantLocalizationProjectionListener(stage.runtime);

      await listener.handle(
        stub<TenantUpdatedEvent>({
          eventType: 'TenantUpdated',
          tenantId: IDLE,
          timezone: 'Europe/Istanbul',
          locale: 'tr-TR',
          timestamp: '2026-07-20T00:00:00.000Z',
        }),
      );

      expect((await zones.tenantZones([IDLE])).get(IDLE)).toBe('Europe/Istanbul');
    });
  });
});
