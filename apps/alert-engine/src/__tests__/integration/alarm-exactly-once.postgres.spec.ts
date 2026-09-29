/**
 * Alarms page EXACTLY ONCE and cannot be silenced by configuration — on real
 * Postgres (V-S1a-2d, V-S1a-4, V-S1a-7, decision 7).
 *
 * WHY Postgres: exactly-once is a property of the conditional UPDATE claim
 * racing other connections, and the suppression-window bug was a jsonb
 * round-trip (dates come back as strings) — neither exists in a mock.
 */
import { randomUUID } from 'node:crypto';

import { of } from 'rxjs';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  createBaseEvent,
  signalKey,
  type WaterQualityCriticalEvent,
} from '@platform/event-contracts';
import { DataSource, Repository } from 'typeorm';

import { WaterQualityCriticalEventHandler } from '../../alert/event-handlers/water-quality-critical.handler';
import { AlertEvaluationService } from '../../alert/services/alert-evaluation.service';
import { FarmSignalIncidentService } from '../../alert/services/farm-signal-incident.service';
import { WaterQualityCriticalAlertService } from '../../alert/services/water-quality-critical-alert.service';
import { AlertIncident, IncidentStatus } from '../../database/entities/alert-incident.entity';
import { AlertOperator, AlertRule, AlertSeverity } from '../../database/entities/alert-rule.entity';
import { EscalationPolicy } from '../../database/entities/escalation-policy.entity';
import { defaultEscalationLevels } from '../../escalation/default-escalation-policy';
import { EscalationManagerService } from '../../escalation/escalation-manager.service';
import { EscalationPolicyService } from '../../escalation/escalation-policy.service';
import { RuleRecipientBackfillService } from '../../alert/services/rule-recipient-backfill.service';
import {
  ALERT_AUTH_NATS_CLIENT,
  RuleRecipientNormalizer,
} from '../../alert/services/rule-recipient-normalizer.service';
import { bootAlertPostgres, type AlertPostgres } from './support/alert-postgres.harness';

const TENANT = '5e0d9c8b-7a69-4a58-9b47-3c2d1e0f9a8b';
const SCHEMA = getTenantSchemaName(TENANT);
const SITE = '11111111-1111-4111-8111-111111111111';
const PERSON = '44444444-4444-4444-8444-444444444444';
const COLLEAGUE = '55555555-5555-4555-8555-555555555555';

/**
 * auth-service's resolve-by-email answer, played by a double: the colleague's
 * address is an active user of the tenant; the partner address is not.
 */
const authDirectory = {
  send: jest.fn((_subject: string, query: { emails: string[] }) =>
    of({
      success: true,
      matches: query.emails.includes('ayse@farm.test')
        ? [{ email: 'ayse@farm.test', userId: COLLEAGUE }]
        : [],
    }),
  ),
};

jest.setTimeout(180_000);

describe('alarm delivery exactly once on real Postgres', () => {
  let pg: AlertPostgres | undefined;
  let admin: DataSource;
  let manager: EscalationManagerService;
  let policies: EscalationPolicyService;
  let incidents: FarmSignalIncidentService;
  let wqHandler: WaterQualityCriticalEventHandler;
  let evaluation: AlertEvaluationService;
  let policyRepository: Repository<EscalationPolicy>;
  let ruleRepository: Repository<AlertRule>;
  let backfill: RuleRecipientBackfillService;

  beforeAll(async () => {
    pg = await bootAlertPostgres({
      tenantIds: [TENANT],
      providers: [
        EscalationManagerService,
        EscalationPolicyService,
        FarmSignalIncidentService,
        WaterQualityCriticalAlertService,
        WaterQualityCriticalEventHandler,
        AlertEvaluationService,
        RuleRecipientNormalizer,
        RuleRecipientBackfillService,
        { provide: ALERT_AUTH_NATS_CLIENT, useValue: authDirectory },
      ],
    });
    admin = pg.admin;
    manager = pg.moduleRef.get(EscalationManagerService);
    policies = pg.moduleRef.get(EscalationPolicyService);
    incidents = pg.moduleRef.get(FarmSignalIncidentService);
    wqHandler = pg.moduleRef.get(WaterQualityCriticalEventHandler);
    evaluation = pg.moduleRef.get(AlertEvaluationService);
    policyRepository = pg.moduleRef.get(getRepositoryToken(EscalationPolicy));
    ruleRepository = pg.moduleRef.get(getRepositoryToken(AlertRule));
    backfill = pg.moduleRef.get(RuleRecipientBackfillService);
  });

  afterAll(async () => {
    manager?.onModuleDestroy();
    await pg?.close();
  });

  async function escalatedFor(alertId: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<{ payload: Record<string, unknown> }> = await admin.query(
      `SELECT payload FROM alert.alert_outbox
        WHERE "eventType" = 'AlertEscalated' AND "tenantId" = $1 AND payload->>'alertId' = $2`,
      [TENANT, alertId],
    );
    return rows.map((row) => row.payload);
  }

  function criticalReading(equipmentId: string): WaterQualityCriticalEvent {
    return {
      ...createBaseEvent<WaterQualityCriticalEvent>('WaterQualityCritical', TENANT),
      measurementId: randomUUID(),
      equipmentId,
      tankId: null,
      criticalParametersJson: '[]',
      criticalParameterCount: 1,
      measuredAt: new Date().toISOString(),
      siteId: SITE,
    };
  }

  it('pages ONCE for a burst of CRITICAL deliveries of one condition (V-S1a-4)', async () => {
    // SCENARIO: an offline-sync flush delivers 12 critical readings of one tank at
    //           once — concurrent handlers, concurrent connections.
    // EXPECTS: one open incident with 12 occurrences at escalation level 1, and
    //          exactly ONE AlertEscalated for it (the level-0 claim admits one caller).
    const tank = randomUUID();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => wqHandler.handle(criticalReading(tank))),
    );
    expect(outcomes.every((outcome) => outcome.kind === 'ack')).toBe(true);

    const rows: Array<{ id: string; occurrence_count: number; escalation_level: number }> =
      await admin.query(
        `SELECT id, occurrence_count, escalation_level FROM "${SCHEMA}".alert_incidents
          WHERE signal_key = $1`,
        [signalKey({ kind: 'water', equipmentId: tank })],
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ occurrence_count: 12, escalation_level: 1 });
    expect(await escalatedFor(rows[0]?.id ?? '')).toHaveLength(1);
  });

  it('pages ONCE for the new severity when CRITICAL occurrences race on a WARNING incident', async () => {
    // SCENARIO: a WARNING incident (the default policy does not page WARNING) sees
    //           8 concurrent CRITICAL occurrences.
    // EXPECTS: the incident is CRITICAL, escalated once — the rise re-armed level 0
    //          and exactly one occurrence claimed it.
    const key = signalKey({ kind: 'mortality', batchId: randomUUID() });
    const spec = (severity: AlertSeverity) => ({
      tenantId: TENANT,
      signalKey: key,
      siteId: SITE,
      title: 'High Mortality',
      description: `mortality ${severity}`,
      severity,
      triggerData: {},
      triggeredAt: new Date(),
      signalLabel: 'mortality',
    });
    await withTenantContext(TENANT, () => incidents.ensureIncident(spec(AlertSeverity.WARNING)));

    await Promise.all(
      Array.from({ length: 8 }, () =>
        withTenantContext(TENANT, () => incidents.ensureIncident(spec(AlertSeverity.CRITICAL))),
      ),
    );

    const rows: Array<{ id: string; severity: string; escalation_level: number }> =
      await admin.query(
        `SELECT id, severity, escalation_level FROM "${SCHEMA}".alert_incidents WHERE signal_key = $1`,
        [key],
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'critical', escalation_level: 1 });
    expect(await escalatedFor(rows[0]?.id ?? '')).toHaveLength(1);
  });

  it('reads suppression windows back from jsonb as Dates; CRITICAL still pages inside an admin window (V-S1a-2d)', async () => {
    // SCENARIO: a high-priority policy covering CRITICAL/HIGH carries an ACTIVE
    //           admin window; it is written and read back through jsonb.
    // EXPECTS: the stored window is ISO text, the entity holds Dates (no TypeError
    //          at `.getTime()`), a CRITICAL incident still escalates, a HIGH one is
    //          suppressed by the admin's window.
    const saved = await withTenantContext(TENANT, () =>
      policyRepository.save(
        policyRepository.create({
          tenantId: TENANT,
          name: 'Maintenance night',
          severity: [AlertSeverity.CRITICAL, AlertSeverity.HIGH],
          levels: defaultEscalationLevels(),
          repeatIntervalMinutes: 30,
          maxRepeats: 0,
          isActive: true,
          isDefault: false,
          priority: 50,
          suppressionWindows: [
            {
              id: randomUUID(),
              name: 'maintenance',
              startTime: new Date(Date.now() - 60_000),
              endTime: new Date(Date.now() + 60 * 60_000),
              createdBy: PERSON,
              createdByTenantAdmin: true,
              isRecurring: false,
            },
          ],
        }),
      ),
    );
    const stored: Array<{ start: string }> = await admin.query(
      `SELECT suppression_windows->0->>'startTime' AS start FROM "${SCHEMA}".escalation_policies WHERE id = $1`,
      [saved.id],
    );
    expect(typeof stored[0]?.start).toBe('string');

    policies.clearCache();
    const reread = await withTenantContext(TENANT, () => policies.getPolicy(saved.id, TENANT));
    expect(reread.suppressionWindows?.[0]?.startTime).toBeInstanceOf(Date);

    await withTenantContext(TENANT, () =>
      incidents.ensureIncident({
        tenantId: TENANT,
        signalKey: signalKey({ kind: 'water', equipmentId: randomUUID() }),
        siteId: SITE,
        title: 'DO crash',
        description: 'DO 1.8 mg/L',
        severity: AlertSeverity.CRITICAL,
        triggerData: {},
        triggeredAt: new Date(),
        signalLabel: 'water-quality',
      }),
    );
    const criticalRows: Array<{ escalation_level: number }> = await admin.query(
      `SELECT escalation_level FROM "${SCHEMA}".alert_incidents WHERE title = 'DO crash'`,
    );
    expect(criticalRows[0]?.escalation_level).toBe(1);

    const highIncident = await withTenantContext(TENANT, () =>
      policyRepository.manager.save(
        Object.assign(new AlertIncident(), {
          tenantId: TENANT,
          signalKey: signalKey({ kind: 'water', equipmentId: randomUUID() }),
          title: 'pH drift',
          severity: AlertSeverity.HIGH,
          status: IncidentStatus.NEW,
          triggerData: {},
          timeline: [],
          relatedIncidentIds: [],
        }),
      ),
    );
    await expect(
      withTenantContext(TENANT, () =>
        manager.startEscalation(highIncident, { severity: AlertSeverity.HIGH }),
      ),
    ).resolves.toBe('suppressed');
    await withTenantContext(TENANT, () => policyRepository.delete({ id: saved.id }));
    policies.clearCache();
  });

  it('sensor rule: its person is paged once by escalation; its external targets ride AlertTriggered keyed by the incident; a bump pages nobody again (decision 7)', async () => {
    // SCENARIO: a CRITICAL DO rule names a user id, an outside e-mail and a webhook;
    //           two readings breach it (the second only bumps the open incident).
    // EXPECTS: ONE AlertEscalated (policy roles + the person); TWO AlertTriggered,
    //          both naming the SAME incident — notification-service delivers the
    //          e-mail and the webhook once per incident, never the user id.
    const sensorId = `sensor-${randomUUID()}`;
    const rule = await withTenantContext(TENANT, () =>
      ruleRepository.save(
        ruleRepository.create({
          tenantId: TENANT,
          name: `DO crash ${sensorId}`,
          sensorId,
          conditions: [
            {
              parameter: 'dissolved_oxygen',
              operator: AlertOperator.LT,
              threshold: 4,
              severity: AlertSeverity.CRITICAL,
            },
          ],
          notificationChannels: ['email', 'webhook'],
          recipients: [PERSON, 'ops@example.com', 'https://hooks.example.com/alarm'],
          cooldownMinutes: 0,
          isActive: true,
          createdBy: PERSON,
        }),
      ),
    );
    const reading = () => ({
      sensorId,
      tenantId: TENANT,
      sourceEventId: randomUUID(),
      readings: { dissolved_oxygen: 2.1 },
      timestamp: new Date(),
    });

    await withTenantContext(TENANT, () => evaluation.evaluateSensorReading(reading()));
    await withTenantContext(TENANT, () => evaluation.evaluateSensorReading(reading()));

    const incidentRows: Array<{ id: string; occurrence_count: number }> = await admin.query(
      `SELECT id, occurrence_count FROM "${SCHEMA}".alert_incidents WHERE rule_id = $1`,
      [rule.id],
    );
    expect(incidentRows).toHaveLength(1);
    expect(incidentRows[0]?.occurrence_count).toBe(2);
    const incidentId = incidentRows[0]?.id ?? '';

    const escalated = await escalatedFor(incidentId);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({
      escalatedTo: [PERSON],
      tenantWideRecipientRoles: ['TENANT_ADMIN'],
      ruleId: rule.id,
    });

    const triggered: Array<{ payload: Record<string, unknown> }> = await admin.query(
      `SELECT payload FROM alert.alert_outbox
        WHERE "eventType" = 'AlertTriggered' AND "tenantId" = $1 AND payload->>'ruleId' = $2`,
      [TENANT, rule.id],
    );
    expect(triggered).toHaveLength(2);
    for (const row of triggered) {
      expect(row.payload).toMatchObject({
        incidentId,
        version: 3,
        recipients: [PERSON, 'ops@example.com', 'https://hooks.example.com/alarm'],
      });
    }
  });

  it('backfills existing rules: a colleague named by e-mail becomes a user id, per tenant, re-runnably (decision 7)', async () => {
    // SCENARIO: a rule written before normalisation names a colleague by e-mail
    //           next to a partner address; the backfill runs twice.
    // EXPECTS: the stored rule names the colleague's id and keeps the partner
    //          address; the report counts 1 rule / 1 address for the tenant; the
    //          second pass changes nothing.
    const legacy = await withTenantContext(TENANT, () =>
      ruleRepository.save(
        ruleRepository.create({
          tenantId: TENANT,
          name: `legacy ${randomUUID()}`,
          conditions: [],
          notificationChannels: ['email'],
          recipients: ['Ayse@Farm.test', 'ops@partner.test'],
          cooldownMinutes: 5,
          isActive: true,
          createdBy: PERSON,
        }),
      ),
    );

    const first = await backfill.backfillAllTenants();
    const second = await backfill.backfillAllTenants();

    expect(first.failed).toBe(0);
    expect(first.reports).toContainEqual(
      expect.objectContaining({ tenantId: TENANT, addressesReplaced: 1 }),
    );
    expect(second.reports.every((report) => report.addressesReplaced === 0)).toBe(true);
    const stored: Array<{ recipients: string[] }> = await admin.query(
      `SELECT recipients FROM "${SCHEMA}".alert_rules WHERE id = $1`,
      [legacy.id],
    );
    expect(stored[0]?.recipients).toEqual([COLLEAGUE, 'ops@partner.test']);
  });
});
