/**
 * The alarm site + module reads on real Postgres (ALERT-MEDIUM-010,
 * ALERT-LOW-015).
 *
 * countActiveAlerts groups with `getRawMany`: its column aliases, the group
 * a NULL site or module forms, and the enum strings Postgres hands back are
 * exactly what a mocked query builder cannot check. These run the real SQL
 * the query builder generates against the entity's own table, serve the rows
 * through the code-first GraphQL types, and pin that a count and the list it
 * opens hold the same rows. They also pin why the origin helpers parse a
 * site (ALERT-MEDIUM-013): Postgres refuses anything but a UUID in site_id.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { stub } from '@aquaculture/testing';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory, Query, Resolver } from '@nestjs/graphql';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { graphql, type GraphQLSchema } from 'graphql';
import { type Repository } from 'typeorm';

import { AlertRule, AlertSeverity } from '../../../database/entities/alert-rule.entity';
import { ActiveAlertCount, ActiveAlertCountDimension } from '../../dto/active-alert-count.type';
import { AlertHistoryOrder } from '../../dto/alert-history-order.enum';
import { AlertHistory } from '../../entities/alert-history.entity';
import { OWNER_MODULE, type OwnerModuleCode } from '@aquaculture/shared-contracts';
import { AlertEvaluationService } from '../alert-evaluation.service';
import { sensorOrigin } from '../alert-origin';
import { AlertRuleService } from '../alert-rule.service';

jest.setTimeout(180_000);

const TENANT = '6d0f3a41-5d0b-4c3e-9a51-0f6f3c1b7e21';
const OTHER_TENANT = '7e1f4b52-6e1c-4d4f-8b62-1a7a4d2c8f32';
const PANEL_TENANT = '8f2a5c63-7f2d-4e5a-9c73-2b8b5e3d9a43';
const SITE_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const SITE_B = '0b0b0b0b-0000-4000-8000-00000000000b';

/** Serves ActiveAlertCount rows through the code-first schema, as the subgraph does. */
@Resolver()
class ActiveAlertCountProbeResolver {
  @Query(() => [ActiveAlertCount])
  activeAlertCountsProbe(): ActiveAlertCount[] {
    return [];
  }
}

interface Seed {
  readonly severity: AlertSeverity;
  readonly acknowledged: boolean;
  readonly module: OwnerModuleCode | null;
  readonly siteId: string | null;
  readonly resolved?: boolean;
  readonly tenantId?: string;
}

const SEEDS: readonly Seed[] = [
  {
    severity: AlertSeverity.CRITICAL,
    acknowledged: false,
    module: OWNER_MODULE.SENSOR,
    siteId: SITE_A,
  },
  {
    severity: AlertSeverity.CRITICAL,
    acknowledged: false,
    module: OWNER_MODULE.SENSOR,
    siteId: SITE_A,
  },
  {
    severity: AlertSeverity.CRITICAL,
    acknowledged: true,
    module: OWNER_MODULE.SENSOR,
    siteId: SITE_B,
  },
  {
    severity: AlertSeverity.WARNING,
    acknowledged: false,
    module: OWNER_MODULE.FARM,
    siteId: SITE_A,
  },
  { severity: AlertSeverity.WARNING, acknowledged: false, module: OWNER_MODULE.FARM, siteId: null },
  // Recorded before alarms carried a module or a site.
  { severity: AlertSeverity.MEDIUM, acknowledged: false, module: null, siteId: null },
  // Not counted: resolved, or another tenant's.
  {
    severity: AlertSeverity.CRITICAL,
    acknowledged: false,
    module: OWNER_MODULE.SENSOR,
    siteId: SITE_A,
    resolved: true,
  },
  {
    severity: AlertSeverity.CRITICAL,
    acknowledged: false,
    module: OWNER_MODULE.SENSOR,
    siteId: SITE_A,
    tenantId: OTHER_TENANT,
  },
];

/** The list a GraphQL field served. */
function servedList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('the probe query served no list');
  return value;
}

/** Group order is Postgres's to choose; compare as sets. */
function sorted<T>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe('AlertRuleService site + module reads — real Postgres', () => {
  let harness: HarnessContext | undefined;
  let testing: TestingModule | undefined;
  let history: Repository<AlertHistory>;
  let service: AlertRuleService;
  let schema: GraphQLSchema;

  function alarm(seed: Seed): AlertHistory {
    return history.create({
      ruleId: `rule-${randomBytes(4).toString('hex')}`,
      ruleName: 'Rule',
      tenantId: seed.tenantId ?? TENANT,
      severity: seed.severity,
      acknowledged: seed.acknowledged,
      resolved: seed.resolved ?? false,
      module: seed.module,
      siteId: seed.siteId,
      message: 'alarm',
      triggeringData: {},
      triggeredAt: new Date('2026-10-17T06:00:00.000Z'),
    });
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    await harness.dataSource.query('CREATE SCHEMA alert');
    // Wired as alert-engine wires it: the service's history repository is the
    // one TypeOrmModule injects. The rule side is off these paths; its doubles
    // are plain stubs because Nest probes every provider for lifecycle hooks.
    testing = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...harness.connectionOptions,
          schema: 'alert',
          entities: [AlertHistory],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([AlertHistory]),
      ],
      providers: [
        AlertRuleService,
        {
          provide: getRepositoryToken(AlertRule),
          useValue: stub<Repository<AlertRule>>({}),
        },
        {
          provide: AlertEvaluationService,
          useValue: stub<AlertEvaluationService>({}),
        },
      ],
    }).compile();
    history = testing.get<Repository<AlertHistory>>(getRepositoryToken(AlertHistory));
    service = testing.get(AlertRuleService);
    await history.save(SEEDS.map(alarm));

    const app = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
      logger: false,
    });
    schema = await app
      .get(GraphQLSchemaFactory)
      .create([ActiveAlertCountProbeResolver], [], { skipCheck: true, orphanedTypes: [] });
    await app.close();
  });

  afterAll(async () => {
    if (testing) await testing.close();
    if (harness) await shutdownHarness(harness);
  });

  it('counts per severity and acknowledgement without a grouping, as the annunciator reads it', async () => {
    const counts = await service.countActiveAlerts(TENANT);

    expect(sorted(counts)).toEqual(
      sorted([
        { severity: AlertSeverity.CRITICAL, acknowledged: false, count: 2 },
        { severity: AlertSeverity.CRITICAL, acknowledged: true, count: 1 },
        { severity: AlertSeverity.WARNING, acknowledged: false, count: 2 },
        { severity: AlertSeverity.MEDIUM, acknowledged: false, count: 1 },
      ]),
    );
  });

  it('groups by module, alarms without one in their own null group', async () => {
    const counts = await service.countActiveAlerts(TENANT, {
      groupBy: [ActiveAlertCountDimension.MODULE],
    });

    expect(sorted(counts)).toEqual(
      sorted([
        {
          severity: AlertSeverity.CRITICAL,
          acknowledged: false,
          module: OWNER_MODULE.SENSOR,
          count: 2,
        },
        {
          severity: AlertSeverity.CRITICAL,
          acknowledged: true,
          module: OWNER_MODULE.SENSOR,
          count: 1,
        },
        {
          severity: AlertSeverity.WARNING,
          acknowledged: false,
          module: OWNER_MODULE.FARM,
          count: 2,
        },
        { severity: AlertSeverity.MEDIUM, acknowledged: false, module: null, count: 1 },
      ]),
    );
  });

  it('groups one module’s alarms by site, alarms without one in their own null group', async () => {
    const counts = await service.countActiveAlerts(TENANT, {
      module: OWNER_MODULE.FARM,
      groupBy: [ActiveAlertCountDimension.SITE],
    });

    expect(sorted(counts)).toEqual(
      sorted([
        { severity: AlertSeverity.WARNING, acknowledged: false, siteId: SITE_A, count: 1 },
        { severity: AlertSeverity.WARNING, acknowledged: false, siteId: null, count: 1 },
      ]),
    );
  });

  it('counts exactly the rows the list it opens holds', async () => {
    const counts = await service.countActiveAlerts(TENANT, { siteId: SITE_A });
    const list = await service.getAlertHistory(
      TENANT,
      { siteId: SITE_A, resolved: false },
      { page: 1, limit: 100 },
    );

    expect(counts.reduce((sum, row) => sum + row.count, 0)).toBe(3);
    expect(list.total).toBe(3);
    expect(sorted(list.items.map((row) => [row.severity, row.acknowledged]))).toEqual(
      sorted(
        counts.flatMap((row) =>
          Array.from({ length: row.count }, () => [row.severity, row.acknowledged]),
        ),
      ),
    );
    const sensorList = await service.getAlertHistory(
      TENANT,
      { siteId: SITE_A, module: OWNER_MODULE.SENSOR, resolved: false },
      { page: 1, limit: 100 },
    );
    expect(sensorList.items.map((row) => row.module)).toEqual([
      OWNER_MODULE.SENSOR,
      OWNER_MODULE.SENSOR,
    ]);
  });

  it('serves the raw rows through the GraphQL enums: modules and severities by name, null groups as null', async () => {
    const counts = await service.countActiveAlerts(TENANT, {
      groupBy: [ActiveAlertCountDimension.MODULE, ActiveAlertCountDimension.SITE],
    });

    const result = await graphql({
      schema,
      source: '{ activeAlertCountsProbe { severity acknowledged module siteId count } }',
      rootValue: { activeAlertCountsProbe: counts },
    });

    expect(result.errors).toBeUndefined();
    expect(sorted(servedList(result.data ? result.data['activeAlertCountsProbe'] : null))).toEqual(
      sorted([
        { severity: 'CRITICAL', acknowledged: false, module: 'SENSOR', siteId: SITE_A, count: 2 },
        { severity: 'CRITICAL', acknowledged: true, module: 'SENSOR', siteId: SITE_B, count: 1 },
        { severity: 'WARNING', acknowledged: false, module: 'FARM', siteId: SITE_A, count: 1 },
        { severity: 'WARNING', acknowledged: false, module: 'FARM', siteId: null, count: 1 },
        { severity: 'MEDIUM', acknowledged: false, module: null, siteId: null, count: 1 },
      ]),
    );
  });

  it('pages the most severe first: a short page keeps an older CRITICAL behind newer, milder alarms', async () => {
    const at = (time: string): Date => new Date(`2026-10-17T${time}:00.000Z`);
    const seeded = await history.save(
      (
        [
          [AlertSeverity.CRITICAL, '06:00'],
          [AlertSeverity.WARNING, '07:00'],
          [AlertSeverity.HIGH, '07:30'],
          [AlertSeverity.WARNING, '08:00'],
          [AlertSeverity.MEDIUM, '08:30'],
        ] as const
      ).map(([severity, time]) => ({
        ...alarm({
          severity,
          acknowledged: false,
          module: OWNER_MODULE.FARM,
          siteId: SITE_A,
          tenantId: PANEL_TENANT,
        }),
        triggeredAt: at(time),
      })),
    );
    const page = async (order?: AlertHistoryOrder): Promise<[AlertSeverity, string][]> =>
      (
        await service.getAlertHistory(
          PANEL_TENANT,
          { module: OWNER_MODULE.FARM, resolved: false },
          { page: 1, limit: 2 },
          order,
        )
      ).items.map((row) => [row.severity, row.triggeredAt.toISOString().slice(11, 16)]);

    expect(await page()).toEqual([
      [AlertSeverity.MEDIUM, '08:30'],
      [AlertSeverity.WARNING, '08:00'],
    ]);
    expect(await page(AlertHistoryOrder.MOST_SEVERE_FIRST)).toEqual([
      [AlertSeverity.CRITICAL, '06:00'],
      [AlertSeverity.HIGH, '07:30'],
    ]);
    // Within a severity, the newest first; MEDIUM ranks above WARNING.
    const all = await service.getAlertHistory(
      PANEL_TENANT,
      { resolved: false },
      { page: 1, limit: 10 },
      AlertHistoryOrder.MOST_SEVERE_FIRST,
    );
    expect(all.items.map((row) => row.severity)).toEqual([
      AlertSeverity.CRITICAL,
      AlertSeverity.HIGH,
      AlertSeverity.MEDIUM,
      AlertSeverity.WARNING,
      AlertSeverity.WARNING,
    ]);
    expect(all.items.slice(3).map((row) => row.triggeredAt.toISOString().slice(11, 16))).toEqual([
      '08:00',
      '07:00',
    ]);
    await history.delete(seeded.map((row) => row.id));
  });

  it('pages alarms that tie on severity and time by id, so no row repeats or goes missing across pages', async () => {
    const tied = await history.save(
      Array.from({ length: 6 }, () => ({
        ...alarm({
          severity: AlertSeverity.WARNING,
          acknowledged: false,
          module: OWNER_MODULE.FARM,
          siteId: SITE_B,
          tenantId: PANEL_TENANT,
        }),
        triggeredAt: new Date('2026-10-17T09:00:00.000Z'),
      })),
    );
    const byIdDescending = tied.map((row) => row.id).sort((a, b) => b.localeCompare(a));
    try {
      for (const order of [AlertHistoryOrder.NEWEST_FIRST, AlertHistoryOrder.MOST_SEVERE_FIRST]) {
        const paged: string[] = [];
        for (let page = 1; page <= 3; page += 1) {
          const { items } = await service.getAlertHistory(
            PANEL_TENANT,
            { siteId: SITE_B },
            { page, limit: 2 },
            order,
          );
          paged.push(...items.map((row) => row.id));
        }
        expect(paged).toEqual(byIdDescending);
      }
    } finally {
      await history.delete(tied.map((row) => row.id));
    }
  });

  it('ranks a severity the code does not know below INFO, never above CRITICAL', async () => {
    // Blue-green: a migration adds a severity to the database enum while pods
    // that predate it still serve the list. Unranked, CASE yields NULL, and
    // Postgres sorts NULL first under DESC — above every CRITICAL.
    await history.query(
      `ALTER TYPE alert.alert_history_severity_enum ADD VALUE IF NOT EXISTS 'emergency'`,
    );
    const critical = await history.save({
      ...alarm({
        severity: AlertSeverity.CRITICAL,
        acknowledged: false,
        module: OWNER_MODULE.FARM,
        siteId: SITE_B,
        tenantId: PANEL_TENANT,
      }),
      triggeredAt: new Date('2026-10-17T05:00:00.000Z'),
    });
    const info = await history.save({
      ...alarm({
        severity: AlertSeverity.INFO,
        acknowledged: false,
        module: OWNER_MODULE.FARM,
        siteId: SITE_B,
        tenantId: PANEL_TENANT,
      }),
      triggeredAt: new Date('2026-10-17T05:30:00.000Z'),
    });
    const [{ id: unknown }] = await history.query(
      `INSERT INTO alert.alert_history
         (rule_id, rule_name, tenant_id, severity, message, triggering_data, triggered_at, site_id, module)
       VALUES ('rule-future', 'Rule', $1, 'emergency', 'alarm', '{}', '2026-10-17T10:00:00Z', $2, 'farm')
       RETURNING id`,
      [PANEL_TENANT, SITE_B],
    );
    try {
      const { items } = await service.getAlertHistory(
        PANEL_TENANT,
        { siteId: SITE_B },
        { page: 1, limit: 10 },
        AlertHistoryOrder.MOST_SEVERE_FIRST,
      );
      expect(items.map((row) => row.id)).toEqual([critical.id, info.id, unknown]);
    } finally {
      await history.delete([critical.id, info.id, unknown]);
    }
  });

  it('refuses a site that is not a UUID; the origin helper records it as no site (ALERT-MEDIUM-013)', async () => {
    const label = 'Hatchery North';
    const asGiven = history.create({
      ...alarm({
        severity: AlertSeverity.HIGH,
        acknowledged: false,
        module: OWNER_MODULE.SENSOR,
        siteId: null,
      }),
      siteId: label,
    });
    await expect(history.save(asGiven)).rejects.toMatchObject({ driverError: { code: '22P02' } });

    const parsed = history.create({
      ...alarm({ severity: AlertSeverity.HIGH, acknowledged: false, module: null, siteId: null }),
      ...sensorOrigin(label),
    });
    const saved = await history.save(parsed);
    const stored = await history.findOneByOrFail({ id: saved.id });
    expect([stored.module, stored.siteId]).toEqual([OWNER_MODULE.SENSOR, null]);
    await history.delete({ id: saved.id });
  });
});
