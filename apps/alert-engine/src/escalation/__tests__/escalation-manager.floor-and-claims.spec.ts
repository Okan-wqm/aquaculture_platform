import * as client from 'prom-client';
import { LIFE_SAFETY_ALARM_DEGRADED_METRIC } from '@aquaculture/backend-common/metrics';

import {
  INCIDENT_ID,
  TENANT_ID,
  buildEscalationHarness,
  firstEnqueued,
  incident,
  policy,
} from '../../__tests__/support/escalation-manager.harness';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { NotificationChannel } from '../../database/entities/escalation-policy.entity';

/**
 * EscalationManagerService — the hard floor, direct rule targets, suppression
 * semantics and sweep robustness (V-S1a-2, V-S1a-5, V-S1a-7, V-S1b-2, V-S1b-3,
 * decision 7).
 */
const RULE_PERSON = '44444444-4444-4444-8444-444444444444';

async function degradedCount(reason: string, severity: string): Promise<number> {
  const metric = client.register.getSingleMetric(LIFE_SAFETY_ALARM_DEGRADED_METRIC);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values
    .filter(
      (value) =>
        value.labels['service'] === 'alert-engine' &&
        value.labels['reason'] === reason &&
        value.labels['severity'] === severity,
    )
    .reduce((sum, value) => sum + value.value, 0);
}

describe('EscalationManagerService — hard floor (V-S1a-2c)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('pages every tenant admin by push and e-mail for a CRITICAL incident no policy covers, and counts it', async () => {
    // SCENARIO: the policy set covers nothing for this CRITICAL incident.
    // EXPECTS: one AlertEscalated to TENANT_ADMIN tenant-wide (push + e-mail) and
    //          life_safety_alarm_degraded_total{reason="no_policy_match"} + 1.
    const harness = await buildEscalationHarness();
    harness.policies.findMatchingPolicy.mockResolvedValue(null);
    const before = await degradedCount('no_policy_match', 'critical');

    await expect(
      harness.service.startEscalation(incident(), {
        severity: AlertSeverity.CRITICAL,
      }),
    ).resolves.toBe('escalated');

    expect(firstEnqueued(harness.outbox)).toMatchObject({
      tenantWideRecipientRoles: ['TENANT_ADMIN'],
      siteRecipientRoles: [],
      channels: ['push', 'email'],
    });
    expect(await degradedCount('no_policy_match', 'critical')).toBe(before + 1);
  });
});

describe("EscalationManagerService — a sensor rule's own people (decision 7)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("joins the rule's user-id recipients to the policy's level 1", async () => {
    // SCENARIO: a CRITICAL sensor-rule incident whose rule names one person.
    // EXPECTS: ONE event carrying the policy's roles AND the person — one pager.
    const harness = await buildEscalationHarness();

    await harness.service.startEscalation(incident({ ruleId: INCIDENT_ID, signalKey: null }), {
      severity: AlertSeverity.CRITICAL,
      directTargets: { userIds: [RULE_PERSON], channels: [NotificationChannel.EMAIL] },
    });

    expect(harness.outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(firstEnqueued(harness.outbox)).toMatchObject({
      escalatedTo: [RULE_PERSON],
      tenantWideRecipientRoles: ['TENANT_ADMIN'],
      siteRecipientRoles: ['MODULE_MANAGER'],
    });
  });

  it("pages the rule's people alone for a WARNING incident no policy covers", async () => {
    const harness = await buildEscalationHarness();
    harness.policies.findMatchingPolicy.mockResolvedValue(null);

    const outcome = await harness.service.startEscalation(incident(), {
      severity: AlertSeverity.WARNING,
      directTargets: { userIds: [RULE_PERSON], channels: [NotificationChannel.PUSH] },
    });

    expect(outcome).toBe('escalated');
    expect(firstEnqueued(harness.outbox)).toMatchObject({
      escalatedTo: [RULE_PERSON],
      tenantWideRecipientRoles: [],
      channels: ['push'],
    });
  });
});

describe('EscalationManagerService — suppression (ALERT-3, V-S1b-2)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function windowed(createdByTenantAdmin: boolean): ReturnType<typeof policy> {
    return policy(undefined, {
      severity: [AlertSeverity.CRITICAL, AlertSeverity.HIGH, AlertSeverity.WARNING],
      suppressionWindows: [
        {
          id: 'w1',
          name: 'maintenance',
          startTime: new Date(Date.now() - 60_000),
          endTime: new Date(Date.now() + 60 * 60_000),
          createdBy: 'someone',
          createdByTenantAdmin,
          isRecurring: false,
        },
      ],
    });
  }

  it('never suppresses CRITICAL, even inside an admin window', async () => {
    const harness = await buildEscalationHarness();
    harness.policies.findMatchingPolicy.mockResolvedValue(windowed(true));

    await expect(
      harness.service.startEscalation(incident(), {
        severity: AlertSeverity.CRITICAL,
      }),
    ).resolves.toBe('escalated');
  });

  it("does not let a manager's window silence HIGH", async () => {
    const harness = await buildEscalationHarness();
    harness.policies.findMatchingPolicy.mockResolvedValue(windowed(false));

    await expect(
      harness.service.startEscalation(incident({ severity: AlertSeverity.HIGH }), {
        severity: AlertSeverity.HIGH,
      }),
    ).resolves.toBe('escalated');
  });

  it("lets an admin's window silence HIGH, and audits it", async () => {
    const harness = await buildEscalationHarness();
    harness.policies.findMatchingPolicy.mockResolvedValue(windowed(true));

    await expect(
      harness.service.startEscalation(incident({ severity: AlertSeverity.HIGH }), {
        severity: AlertSeverity.HIGH,
      }),
    ).resolves.toBe('suppressed');
    expect(harness.outbox.enqueue).not.toHaveBeenCalled();
    expect(harness.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: INCIDENT_ID, action: 'escalation.suppressed' }),
    );
  });
});

describe('EscalationManagerService — missed-escalation sweep robustness (V-S1b-3)', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('skips and retires a legacy state without a tenant, and still advances the next incident', async () => {
    // SCENARIO: the active set holds a pre-tenant legacy state and a due, valid one.
    // EXPECTS: the legacy state is retired from the active set; the valid incident's
    //          overdue level still runs (the legacy one used to abort the loop).
    jest.useFakeTimers();
    const harness = await buildEscalationHarness();
    await harness.service.startEscalation(incident(), {
      severity: AlertSeverity.CRITICAL,
    });
    harness.redis.store.set(
      'escalation:state:legacy-incident',
      JSON.stringify({ incidentId: 'legacy-incident', policyId: 'p', currentLevel: 1 }),
    );
    harness.redis.sets.get('escalation:active')?.add('legacy-incident');
    const escalate = jest.spyOn(harness.service, 'escalateToNextLevel');

    // Boot: the restore loop meets the legacy state first and must not abort.
    await harness.service.onModuleInit();
    // The valid incident's timer is overdue (a restart swallowed its tick).
    harness.redis.store.set(
      `escalation:timer:${INCIDENT_ID}`,
      JSON.stringify({ nextEscalationAt: new Date(Date.now() - 1000).toISOString() }),
    );
    await jest.advanceTimersByTimeAsync(61_000);

    expect(harness.redis.sets.get('escalation:active')?.has('legacy-incident')).toBe(false);
    expect(escalate).toHaveBeenCalledWith(INCIDENT_ID);
    expect(harness.tenantSeenByFindOne.every((tenant) => tenant === TENANT_ID)).toBe(true);
    harness.service.onModuleDestroy();
  });
});
