/**
 * FarmSignalIncidentService.raise on real Postgres.
 *
 * ## What the mocks cannot show
 *
 * A farm signal is identified by a SYNTHETIC rule key
 * (`system:meal-underfed:<unitId>`), not by an `alert_rules` row. On the
 * production tenant `alert_incidents.rule_id` was a `uuid` column, so the very
 * first incident query threw "invalid input syntax for type uuid" — after the
 * alarm row had already been saved. The event handler rethrew, JetStream
 * redelivered every ~30 s for 7 days, and each attempt saved one more alarm
 * row: 20,000 rows per poison message and not one incident, ever.
 *
 * The tables here are built from the ENTITIES (so the column type is the one
 * the entity declares), and the properties that failure violated are pinned
 * against the real constraints:
 *
 *  - a synthetic key is stored (the entity and the column agree);
 *  - the alarm and its incident commit together, or neither does;
 *  - the unique `(rule_id, source_event_id)` key makes a redelivery — and any
 *    second signal of the same period — a no-op, not a second alarm;
 *  - the next period (another key) raises again and BUMPS the open incident.
 */
import 'reflect-metadata';

import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { deriveEventId } from '@platform/event-contracts';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';

import { AlertIncident } from '../../../database/entities/alert-incident.entity';
import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import { EscalationManagerService } from '../../../escalation/escalation-manager.service';
import { AlertHistory } from '../../entities/alert-history.entity';
import { FarmSignalAlertSpec, FarmSignalIncidentService } from '../farm-signal-incident.service';

jest.setTimeout(180_000);

const TENANT = '6d0f3a41-5d0b-4c3e-9a51-0f6f3c1b7e21';
const UNIT = 'eedddfae-339e-4289-8039-4ba78bd3cb43';
const RULE_KEY = `system:meal-underfed:${UNIT}`;
const DAY_1 = deriveEventId(['meal-underfed', TENANT, UNIT, 'day-plan-1'].join('\u0000'));
const DAY_2 = deriveEventId(['meal-underfed', TENANT, UNIT, 'day-plan-2'].join('\u0000'));

describe('FarmSignalIncidentService.raise — real Postgres', () => {
  let harness: HarnessContext | undefined;
  let testing: TestingModule | undefined;
  let dataSource: DataSource;
  let service: FarmSignalIncidentService;
  const startEscalation = jest.fn().mockResolvedValue(null);

  const alert = (
    dedupeKey: string,
    overrides: Partial<FarmSignalAlertSpec> = {},
  ): FarmSignalAlertSpec => ({
    tenantId: TENANT,
    ruleId: RULE_KEY,
    dedupeKey,
    history: {
      ruleName: 'Meal Underfed',
      severity: AlertSeverity.WARNING,
      message: 'T1 was underfed',
      triggeringData: { unitId: UNIT },
      triggeredAt: new Date('2026-10-26T12:00:00.000Z'),
    },
    title: 'Meal Underfed: T1',
    description: 'T1 was underfed',
    severity: AlertSeverity.WARNING,
    triggeredAt: new Date('2026-10-26T12:00:00.000Z'),
    signalLabel: 'meal-underfed',
    triggerData: { unitId: UNIT },
    ...overrides,
  });

  const count = async (table: 'alert_history' | 'alert_incidents'): Promise<number> =>
    Number(
      (
        (await dataSource.query(`SELECT count(*)::int AS n FROM alert.${table}`)) as Array<{
          n: number;
        }>
      )[0]?.n,
    );

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    await harness.dataSource.query('CREATE SCHEMA alert');
    // Wired as alert-engine wires it: the repository is the one TypeOrmModule injects.
    testing = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...harness.connectionOptions,
          schema: 'alert',
          entities: [AlertHistory, AlertIncident],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([AlertHistory, AlertIncident]),
      ],
    }).compile();
    dataSource = testing.get(DataSource);
    service = new FarmSignalIncidentService(
      testing.get<Repository<AlertIncident>>(getRepositoryToken(AlertIncident)),
      { startEscalation } as Pick<EscalationManagerService, 'startEscalation'>,
      dataSource,
    );
  });

  afterAll(async () => {
    if (testing) await testing.close();
    if (harness) await shutdownHarness(harness);
  });

  beforeEach(() => startEscalation.mockClear());

  it('the entity and the column agree: a synthetic rule key is text, not a uuid', async () => {
    const [column] = (await dataSource.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'alert' AND table_name = 'alert_incidents' AND column_name = 'rule_id'`,
    )) as Array<{ data_type: string }>;

    expect(column?.data_type).toBe('character varying');
  });

  it('raises the alarm AND its incident, escalating the new incident once', async () => {
    await expect(service.raise(alert(DAY_1))).resolves.toBe('raised');

    expect(await count('alert_history')).toBe(1);
    expect(await count('alert_incidents')).toBe(1);
    const [row] = (await dataSource.query(
      `SELECT h.rule_id, h.source_event_id, i.rule_id AS incident_rule_id, i.trigger_data
         FROM alert.alert_history h, alert.alert_incidents i`,
    )) as Array<{
      rule_id: string;
      source_event_id: string;
      incident_rule_id: string;
      trigger_data: { historyId: string };
    }>;
    expect(row?.rule_id).toBe(RULE_KEY);
    expect(row?.incident_rule_id).toBe(RULE_KEY);
    expect(row?.source_event_id).toBe(DAY_1);
    // The incident points at the very alarm it was raised with.
    const [history] = (await dataSource.query(`SELECT id FROM alert.alert_history`)) as Array<{
      id: string;
    }>;
    expect(row?.trigger_data.historyId).toBe(history?.id);
    expect(startEscalation).toHaveBeenCalledTimes(1);
  });

  it('a redelivery (same key) is a duplicate: no second alarm, no second incident, no second escalation', async () => {
    await expect(service.raise(alert(DAY_1))).resolves.toBe('duplicate');
    await expect(service.raise(alert(DAY_1))).resolves.toBe('duplicate');

    expect(await count('alert_history')).toBe(1);
    expect(await count('alert_incidents')).toBe(1);
    expect(startEscalation).not.toHaveBeenCalled();
  });

  it('the next period (another key) raises again and BUMPS the open incident instead of opening another', async () => {
    await expect(service.raise(alert(DAY_2))).resolves.toBe('raised');

    expect(await count('alert_history')).toBe(2);
    expect(await count('alert_incidents')).toBe(1);
    const [incident] = (await dataSource.query(
      `SELECT occurrence_count FROM alert.alert_incidents`,
    )) as Array<{ occurrence_count: number }>;
    expect(incident?.occurrence_count).toBe(2);
    expect(startEscalation).not.toHaveBeenCalled();
  });

  it('a failure after the alarm was written rolls the alarm back: nothing is left for a redelivery to repeat', async () => {
    const before = {
      history: await count('alert_history'),
      incidents: await count('alert_incidents'),
    };

    await expect(
      service.raise(
        // The alarm row carries a valid time; the incident write gets an invalid
        // one and fails AFTER the alarm was saved — the failure the production
        // tenant hit, there on a uuid column.
        alert(deriveEventId(['meal-underfed', TENANT, UNIT, 'day-plan-3'].join('\u0000')), {
          triggeredAt: new Date('not-a-date'),
        }),
      ),
    ).rejects.toThrow();

    expect(await count('alert_history')).toBe(before.history);
    expect(await count('alert_incidents')).toBe(before.incidents);
    expect(startEscalation).not.toHaveBeenCalled();
  });

  it('a failure is retried cleanly: the same event that failed raises once it can', async () => {
    const key = deriveEventId(['meal-underfed', TENANT, UNIT, 'day-plan-3'].join('\u0000'));
    const before = await count('alert_history');

    await expect(service.raise(alert(key))).resolves.toBe('raised');

    expect(await count('alert_history')).toBe(before + 1);
  });
});
