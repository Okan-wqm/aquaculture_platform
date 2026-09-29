/**
 * Farm-signal alarms reach delivery — on real Postgres
 * (ALERT-CRITICAL-004, ALERT-CRITICAL-009, ALERT-MEDIUM-006/007).
 *
 * WHY Postgres: every defect this PR closes is a database fact that mocked
 * repositories had hidden for months —
 *   - `alert_incidents.rule_id` was a uuid FK, so a farm-signal insert failed;
 *   - "at most one default policy" and "one open incident per signal" are
 *     unique-index invariants;
 *   - the seed and the reconcile run under the runtime role's RLS, through the
 *     verified tenant fan-out.
 *
 * The schema is built by replaying alert-engine's OWN migrations into the
 * source schema and each tenant schema (the provisioner's replay), and every
 * service runs as a non-superuser role through the production pool patches
 * (search_path + RLS GUC), so RLS applies exactly as in production.
 *
 * Delivery hand-off: the escalation enqueues AlertEscalated on alert_outbox;
 * the row is validated with the SAME trust-boundary schema notification-service
 * enforces (its consumer is unit-proven against that schema — a service's test
 * cannot import another service).
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';

import { withTenantContext } from '@aquaculture/backend-common/context';
import {
  createRlsConnectionBootstrap,
  createTenantConnectionBootstrap,
  getTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import {
  checkAlertEscalatedEvent,
  createBaseEvent,
  signalKey,
  type TenantProvisionedEvent,
  type WaterQualityCriticalEvent,
} from '@platform/event-contracts';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, Repository, type MigrationInterface } from 'typeorm';

import { WaterQualityCriticalEventHandler } from '../../alert/event-handlers/water-quality-critical.handler';
import { AlertHistory } from '../../alert/entities/alert-history.entity';
import { FarmSignalIncidentService } from '../../alert/services/farm-signal-incident.service';
import { WaterQualityCriticalAlertService } from '../../alert/services/water-quality-critical-alert.service';
import { AlertIncident, IncidentStatus } from '../../database/entities/alert-incident.entity';
import { AlertRule, AlertSeverity } from '../../database/entities/alert-rule.entity';
import { EscalationPolicy } from '../../database/entities/escalation-policy.entity';
import { Baseline1800000000000 } from '../../database/migrations/1800000000000-Baseline';
import { AlignAlertTenantColumnsToUuid1800100000000 } from '../../database/migrations/1800100000000-AlignAlertTenantColumnsToUuid';
import { CreateAlertOutbox1800200000000 } from '../../database/migrations/1800200000000-CreateAlertOutbox';
import { AddAlertHistorySourceEventId1801100000000 } from '../../database/migrations/1801100000000-AddAlertHistorySourceEventId';
import { FarmSignalIncidentDelivery1801200000000 } from '../../database/migrations/1801200000000-FarmSignalIncidentDelivery';
import { DefaultPolicyProvisioningHandler } from '../../escalation/default-policy-provisioning.handler';
import { DefaultPolicyReconcilerService } from '../../escalation/default-policy-reconciler.service';
import { EscalationManagerService } from '../../escalation/escalation-manager.service';
import { EscalationPolicyService } from '../../escalation/escalation-policy.service';
import { AlertOutbox } from '../../outbox/alert-outbox.entity';
import { createRedisServiceMock } from '../support/redis-service.mock';

const TENANT_A = '6a1f0e2d-3c4b-4a59-8687-9a0b1c2d3e4f';
const TENANT_B = '7b2e1f3a-4d5c-4b6a-9798-0a1b2c3d4e5f';
const TENANT_C = '8c3f2a4b-5e6d-4c7b-8a99-1b2c3d4e5f60';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const TANK_A = '22222222-2222-4222-8222-222222222222';
const RUNTIME_ROLE = 'alert_runtime_s1';

jest.setTimeout(180_000);

/** Migrations a tenant schema receives (the source-only outbox/ledger ones excluded). */
const TENANT_MIGRATIONS: MigrationInterface[] = [
  new Baseline1800000000000(),
  new AlignAlertTenantColumnsToUuid1800100000000(),
  new AddAlertHistorySourceEventId1801100000000(),
  new FarmSignalIncidentDelivery1801200000000(),
];

async function replay(
  admin: DataSource,
  schema: string,
  migrations: MigrationInterface[],
): Promise<void> {
  // The replay plays aqua-db-migrate's part: the Baseline's RLS install is gated
  // to that process, so the authority is held only while migrations run.
  const previousAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
  process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
  const runner = admin.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    await runner.query(`SELECT pg_catalog.set_config('search_path', $1, true)`, [
      `"${schema}", public`,
    ]);
    for (const migration of migrations) {
      await migration.up(runner);
    }
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    if (previousAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
    else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousAuthority;
  }
}

async function provisionTenant(admin: DataSource, tenantId: string): Promise<void> {
  const schema = getTenantSchemaName(tenantId);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await replay(admin, schema, TENANT_MIGRATIONS);
  await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${RUNTIME_ROLE}`);
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${RUNTIME_ROLE}`,
  );
}

/** The db-migrate ledger's verified mapping, as a fixed set of committed tenants. */
async function publishLedger(admin: DataSource, tenantIds: string[]): Promise<void> {
  const rows = tenantIds
    .map((id) => `('${getTenantSchemaName(id)}'::text, '${id}'::uuid, true, true)`)
    .join(', ');
  await admin.query(
    `CREATE OR REPLACE FUNCTION platform.list_active_tenant_schema_mappings()
       RETURNS TABLE(schema_name text, tenant_id uuid, schema_exists boolean, committed_proof boolean)
       LANGUAGE sql STABLE SECURITY DEFINER AS $fn$ VALUES ${rows} $fn$`,
  );
  await admin.query(
    `GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO ${RUNTIME_ROLE}`,
  );
}

describe('farm-signal delivery on real Postgres', () => {
  let harness: HarnessContext | undefined;
  let moduleClose: (() => Promise<void>) | undefined;
  let admin: DataSource;
  let manager: EscalationManagerService;
  let policies: EscalationPolicyService;
  let incidents: FarmSignalIncidentService;
  let wqHandler: WaterQualityCriticalEventHandler;
  let reconciler: DefaultPolicyReconcilerService;
  let incidentRepository: Repository<AlertIncident>;
  let provisioning: DefaultPolicyProvisioningHandler;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    admin = harness.dataSource;
    const password = randomBytes(24).toString('hex');

    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'`);
    await admin.query('CREATE SCHEMA alert');
    await admin.query('CREATE SCHEMA platform');
    await admin.query(`GRANT USAGE ON SCHEMA alert, platform TO ${RUNTIME_ROLE}`);

    // Source schema: every migration, the source-only outbox included.
    await replay(admin, 'alert', [
      new Baseline1800000000000(),
      new AlignAlertTenantColumnsToUuid1800100000000(),
      new CreateAlertOutbox1800200000000(),
      new AddAlertHistorySourceEventId1801100000000(),
      new FarmSignalIncidentDelivery1801200000000(),
    ]);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA alert TO ${RUNTIME_ROLE}`,
    );
    await provisionTenant(admin, TENANT_A);
    await provisionTenant(admin, TENANT_B);
    await publishLedger(admin, [TENANT_A, TENANT_B]);

    const connection = harness.connectionOptions;
    // The lease/heartbeat runner is infrastructure; the job body runs inline.
    const scheduledJobs: ScheduledJobExecutor = {
      run: async (_name: string, work: () => Promise<void>) => {
        await work();
        return 'ran';
      },
    };
    // Repositories arrive the production way — TypeOrmModule DI into the services'
    // @InjectRepository parameters — on a runtime-role connection.
    const entities = [AlertRule, AlertIncident, AlertHistory, EscalationPolicy, AlertOutbox];
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: connection.host,
          port: connection.port,
          database: connection.database,
          username: RUNTIME_ROLE,
          password,
          entities,
          synchronize: false,
          logging: false,
          extra: { options: '-c search_path=alert,public' },
        }),
        TypeOrmModule.forFeature(entities),
      ],
      providers: [
        EscalationManagerService,
        EscalationPolicyService,
        FarmSignalIncidentService,
        WaterQualityCriticalAlertService,
        WaterQualityCriticalEventHandler,
        DefaultPolicyReconcilerService,
        DefaultPolicyProvisioningHandler,
        { provide: OutboxPublisher, useValue: new OutboxPublisher(AlertOutbox) },
        { provide: RedisService, useValue: createRedisServiceMock() },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: 'EVENT_BUS', useValue: { subscribeWildcard: jest.fn() } },
        { provide: ScheduledJobRunner, useValue: scheduledJobs },
      ],
    }).compile();

    const runtime = moduleRef.get(DataSource);
    moduleClose = () => moduleRef.close();
    // The production pool patches, in production's init order (RlsModule is an
    // imported module, so it patches before AppModule's TenantConnectionBootstrap):
    // RLS GUC + search_path from the ALS context on every checkout.
    new (createRlsConnectionBootstrap('alert'))(runtime).onModuleInit();
    new (createTenantConnectionBootstrap('alert'))(runtime).onModuleInit();
    incidentRepository = moduleRef.get(getRepositoryToken(AlertIncident));

    manager = moduleRef.get(EscalationManagerService);
    policies = moduleRef.get(EscalationPolicyService);
    incidents = moduleRef.get(FarmSignalIncidentService);
    wqHandler = moduleRef.get(WaterQualityCriticalEventHandler);
    reconciler = moduleRef.get(DefaultPolicyReconcilerService);
    provisioning = moduleRef.get(DefaultPolicyProvisioningHandler);
  });

  afterAll(async () => {
    manager?.onModuleDestroy();
    await moduleClose?.();
    await shutdownHarness(harness);
  });

  async function defaultsIn(tenantId: string): Promise<number> {
    const rows: Array<{ count: string }> = await admin.query(
      `SELECT COUNT(*)::text AS count FROM "${getTenantSchemaName(tenantId)}".escalation_policies WHERE is_default`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  describe('default escalation policy (ALERT-CRITICAL-004)', () => {
    it('reconciles every active tenant idempotently through the verified fan-out', async () => {
      // SCENARIO: tenants provisioned before this code — no default policy anywhere.
      // EXPECTS: first pass seeds both, second pass (and a concurrent pair) adds nothing.
      await expect(reconciler.reconcileAllTenants()).resolves.toEqual({
        tenants: 2,
        created: 2,
        failed: 0,
      });
      await expect(reconciler.reconcileAllTenants()).resolves.toEqual({
        tenants: 2,
        created: 0,
        failed: 0,
      });
      await Promise.all([reconciler.reconcileAllTenants(), reconciler.reconcileAllTenants()]);
      expect(await defaultsIn(TENANT_A)).toBe(1);
      expect(await defaultsIn(TENANT_B)).toBe(1);
    });

    it('seeds a newly provisioned tenant on TenantProvisioned, once', async () => {
      // SCENARIO: a tenant created after deploy; the event is delivered twice.
      // EXPECTS: one default policy; the redelivery is a no-op ack.
      await provisionTenant(admin, TENANT_C);
      const event: TenantProvisionedEvent = {
        ...createBaseEvent<TenantProvisionedEvent>('TenantProvisioned', TENANT_C),
        operationId: randomUUID(),
        name: 'Tenant C',
        slug: 'tenant-c',
      };

      await expect(provisioning.handle(event)).resolves.toEqual({ kind: 'ack' });
      await expect(provisioning.handle(event)).resolves.toEqual({ kind: 'ack' });
      expect(await defaultsIn(TENANT_C)).toBe(1);
    });
  });

  describe('migration replay', () => {
    it('re-applies FarmSignalIncidentDelivery on an already-migrated tenant schema as a no-op', async () => {
      // SCENARIO: the provisioner replays the migration into a tenant schema that
      //           already carries it (a retried provisioning job, a reconcile run).
      // EXPECTS: no duplicate-object / NOT NULL error, and the schema keeps exactly
      //          one xor check and a nullable rule_id.
      const schema = getTenantSchemaName(TENANT_B);
      await expect(
        replay(admin, schema, [new FarmSignalIncidentDelivery1801200000000()]),
      ).resolves.toBeUndefined();

      const checks: Array<{ count: string }> = await admin.query(
        `SELECT COUNT(*)::text AS count FROM pg_catalog.pg_constraint
          WHERE conname = 'CHK_alert_incidents_rule_xor_signal'
            AND conrelid = $1::regclass`,
        [`"${schema}".alert_incidents`],
      );
      expect(checks[0]?.count).toBe('1');
      const ruleId: Array<{ is_nullable: string }> = await admin.query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'alert_incidents' AND column_name = 'rule_id'`,
        [schema],
      );
      expect(ruleId[0]?.is_nullable).toBe('YES');
    });
  });

  describe('incident identity (ALERT-CRITICAL-009)', () => {
    const insert = (schema: string, ruleId: string | null, key: string | null): Promise<unknown> =>
      admin.query(
        `INSERT INTO "${schema}".alert_incidents (tenant_id, rule_id, signal_key, title, trigger_data)
         VALUES ($1, $2, $3, 'probe', '{}'::jsonb)`,
        [TENANT_A, ruleId, key],
      );

    it('accepts a farm-signal incident and keeps the rule FK for rule incidents', async () => {
      // SCENARIO: the insert that failed in production, and a rule id that points nowhere.
      // EXPECTS: the signal-keyed row lands; an unknown rule id is still an FK violation.
      const schema = getTenantSchemaName(TENANT_A);
      await expect(insert(schema, null, `water:equipment:${randomUUID()}`)).resolves.toBeDefined();
      await expect(insert(schema, randomUUID(), null)).rejects.toMatchObject({ code: '23503' });
    });

    it('rejects an incident with both identities or neither', async () => {
      // SCENARIO: an incident attributed twice, or to nothing.
      // EXPECTS: the CHECK refuses both (23514).
      const schema = getTenantSchemaName(TENANT_A);
      await expect(insert(schema, null, null)).rejects.toMatchObject({ code: '23514' });
      const ruleRows: Array<{ id: string }> = await admin.query(
        `INSERT INTO "${schema}".alert_rules (name, tenant_id, conditions) VALUES ('r', $1, '[]'::jsonb) RETURNING id`,
        [TENANT_A],
      );
      await expect(insert(schema, ruleRows[0]?.id ?? null, 'fcr:batch:x')).rejects.toMatchObject({
        code: '23514',
      });
    });

    it('keeps ONE open incident per signal: a delivery that missed the winner joins it', async () => {
      // SCENARIO: two deliveries of one condition race; the loser's "is there an open
      //           incident?" read ran before the winner committed, so it inserts too.
      // EXPECTS: the partial unique index refuses the second open row and the loser
      //          bumps the winner — one open incident, two occurrences.
      const key = signalKey({ kind: 'fcr', batchId: randomUUID() });
      const spec = {
        tenantId: TENANT_A,
        signalKey: key,
        siteId: null,
        title: 'race',
        description: 'race',
        severity: AlertSeverity.WARNING,
        triggerData: {},
        triggeredAt: new Date(),
        signalLabel: 'race',
      };
      await withTenantContext(TENANT_A, () => incidents.ensureIncident(spec));

      // The loser: a real repository whose FIRST open-incident read is stale (null).
      const real = incidentRepository;
      let stale = true;
      const loserRepo: Repository<AlertIncident> = Object.create(real);
      loserRepo.findOne = (options) => {
        if (stale) {
          stale = false;
          return Promise.resolve(null);
        }
        return real.findOne(options);
      };
      const loser = new FarmSignalIncidentService(loserRepo, manager);
      await withTenantContext(TENANT_A, () => loser.ensureIncident(spec));

      const rows: Array<{ status: string; occurrence_count: number }> = await admin.query(
        `SELECT status, occurrence_count FROM "${getTenantSchemaName(TENANT_A)}".alert_incidents WHERE signal_key = $1`,
        [key],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: IncidentStatus.NEW, occurrence_count: 2 });
    });

    it('allows a new open incident once the previous one for the signal is resolved', async () => {
      // SCENARIO: an incident for the signal was resolved; the condition recurs.
      // EXPECTS: the index only constrains OPEN incidents — the recurrence opens anew.
      const schema = getTenantSchemaName(TENANT_A);
      const key = `mortality:batch:${randomUUID()}`;
      await admin.query(
        `INSERT INTO "${schema}".alert_incidents (tenant_id, signal_key, title, trigger_data, status)
         VALUES ($1, $2, 'old', '{}'::jsonb, 'RESOLVED')`,
        [TENANT_A, key],
      );
      const open = `INSERT INTO "${schema}".alert_incidents (tenant_id, signal_key, title, trigger_data)
                    VALUES ($1, $2, 'new', '{}'::jsonb)`;
      await expect(admin.query(open, [TENANT_A, key])).resolves.toBeDefined();
      await expect(admin.query(open, [TENANT_A, key])).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('WaterQualityCritical → incident → AlertEscalated (ALERT-CRITICAL-004)', () => {
    it('opens a site-scoped, signal-keyed incident and hands delivery a contract-valid AlertEscalated', async () => {
      // SCENARIO: a critical DO reading on tank A of site A arrives for tenant A.
      // EXPECTS: one incident keyed water:equipment:{tank} with the site, escalated to
      //          level 1 under the seeded default policy, and an AlertEscalated row in
      //          alert_outbox that passes notification-service's boundary schema and
      //          names site managers at site A + every tenant admin, push + e-mail.
      const event: WaterQualityCriticalEvent = {
        ...createBaseEvent<WaterQualityCriticalEvent>('WaterQualityCritical', TENANT_A, {
          userId: 'operator-1',
        }),
        measurementId: randomUUID(),
        equipmentId: TANK_A,
        tankId: null,
        criticalParametersJson: JSON.stringify([
          {
            code: 'do',
            name: 'Dissolved Oxygen',
            value: 2.1,
            threshold: 4,
            direction: 'below',
            unit: 'mg/L',
          },
        ]),
        criticalParameterCount: 1,
        measuredAt: new Date().toISOString(),
        siteId: SITE_A,
      };

      await expect(wqHandler.handle(event)).resolves.toEqual({ kind: 'ack' });

      const key = signalKey({ kind: 'water', equipmentId: TANK_A });
      const incidentRows: Array<{
        id: string;
        rule_id: string | null;
        site_id: string;
        escalation_level: number;
      }> = await admin.query(
        `SELECT id, rule_id, site_id, escalation_level FROM "${getTenantSchemaName(TENANT_A)}".alert_incidents WHERE signal_key = $1`,
        [key],
      );
      expect(incidentRows).toHaveLength(1);
      expect(incidentRows[0]).toMatchObject({
        rule_id: null,
        site_id: SITE_A,
        escalation_level: 1,
      });

      const outboxRows: Array<{ payload: unknown }> = await admin.query(
        `SELECT payload FROM alert.alert_outbox WHERE "eventType" = 'AlertEscalated' AND "tenantId" = $1`,
        [TENANT_A],
      );
      expect(outboxRows).toHaveLength(1);
      const checked = checkAlertEscalatedEvent(outboxRows[0]?.payload);
      expect(checked.ok).toBe(true);
      expect(outboxRows[0]?.payload).toMatchObject({
        alertId: incidentRows[0]?.id,
        signalKey: key,
        ruleId: null,
        severity: 'critical',
        siteId: SITE_A,
        channels: ['push', 'email'],
        siteRecipientRoles: ['MODULE_MANAGER'],
        tenantWideRecipientRoles: ['TENANT_ADMIN'],
      });
    });

    it('seeds the default at point of use when an alarm beats the reconcile', async () => {
      // SCENARIO: a brand-new tenant with NO policy gets a critical reading first.
      // EXPECTS: the policy is created in the alarm's own tenant context and the
      //          incident is escalated on the very first occurrence.
      const tenantD = '9d4a3b5c-6f7e-4d8c-9baa-2c3d4e5f6071';
      await provisionTenant(admin, tenantD);
      policies.clearCache();
      const event: WaterQualityCriticalEvent = {
        ...createBaseEvent<WaterQualityCriticalEvent>('WaterQualityCritical', tenantD),
        measurementId: randomUUID(),
        equipmentId: TANK_A,
        tankId: null,
        criticalParametersJson: '[]',
        criticalParameterCount: 1,
        measuredAt: new Date().toISOString(),
      };

      await expect(wqHandler.handle(event)).resolves.toEqual({ kind: 'ack' });

      expect(await defaultsIn(tenantD)).toBe(1);
      const rows: Array<{ count: string }> = await admin.query(
        `SELECT COUNT(*)::text AS count FROM alert.alert_outbox WHERE "eventType" = 'AlertEscalated' AND "tenantId" = $1`,
        [tenantD],
      );
      expect(rows[0]?.count).toBe('1');
    });
  });
});
