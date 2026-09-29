/**
 * FarmSignalIncidentService unit specs (FARM-LOW-144)
 *
 * The single owner of the "farm signal → AlertIncident" dedup + escalation
 * lifecycle, extracted from the near-verbatim copies that used to live in
 * MortalityAlertService and WaterQualityCriticalAlertService. Proves the
 * behaviour once, for any signal: bump the open incident for a (ruleId, tenant)
 * if one exists, else create a NEW incident and start escalation. Severity is
 * carried through from the caller's spec (mortality can be WARNING; water
 * quality is always CRITICAL) so the shared path never hard-codes it.
 *
 * London-school: the incident repository is a @platform/testing double and the
 * escalation manager is a typed double (only startEscalation is exercised).
 *
 * ALERT-CRITICAL-004/009: the identity is the branded signal key stored in
 * `signal_key` (rule_id stays NULL), escalation is AWAITED and level-triggered,
 * and a lost race on the open-incident unique index joins the winner.
 */
import { createMockRepository } from '@aquaculture/testing';
import { signalKey } from '@platform/event-contracts';
import { QueryFailedError } from 'typeorm';

import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
} from '../../../database/entities/alert-incident.entity';
import { EscalationManagerService } from '../../../escalation/escalation-manager.service';
import {
  FarmSignalIncidentService,
  FarmSignalIncidentSpec,
} from '../farm-signal-incident.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const KEY = signalKey({ kind: 'mortality', batchId: '33333333-3333-4333-8333-333333333333' });
const TRIGGERED_AT = new Date('2026-06-10T08:00:00.000Z');

function makeSpec(overrides: Partial<FarmSignalIncidentSpec> = {}): FarmSignalIncidentSpec {
  return {
    tenantId: TENANT_ID,
    signalKey: KEY,
    siteId: SITE_ID,
    title: 'High Mortality (cumulative_rate): batch b-1',
    description: 'Cumulative mortality rate 12.00% is critical',
    severity: AlertSeverity.CRITICAL,
    triggerData: { historyId: 'history-1', batchId: 'b-1' },
    triggeredAt: TRIGGERED_AT,
    signalLabel: 'mortality',
    ...overrides,
  };
}

/**
 * Structurally-sufficient open-incident fixture: a single typed widening (not
 * an unsafe cast). The service reads status/severity/occurrenceCount and calls
 * `recordOccurrence` / `addTimelineEvent` on it.
 */
function openIncident(
  severity: AlertSeverity,
  escalationLevel = 1,
): AlertIncident & {
  recordOccurrence: jest.Mock;
  addTimelineEvent: jest.Mock;
} {
  return {
    id: 'incident-existing',
    occurrenceCount: 1,
    status: IncidentStatus.NEW,
    severity,
    escalationLevel,
    siteId: SITE_ID,
    description: 'opened seven days ago',
    triggerData: { historyId: 'history-1' },
    recordOccurrence: jest.fn(),
    addTimelineEvent: jest.fn(),
  } as Partial<AlertIncident> as AlertIncident & {
    recordOccurrence: jest.Mock;
    addTimelineEvent: jest.Mock;
  };
}

/** Minimal EscalationManagerService double — only startEscalation is called. */
type EscalationDouble = jest.Mocked<Pick<EscalationManagerService, 'startEscalation'>>;

function makeService(opts: { existingIncident?: AlertIncident | null } = {}): {
  service: FarmSignalIncidentService;
  incidentRepo: jest.Mocked<import('typeorm').Repository<AlertIncident>>;
  escalation: EscalationDouble;
} {
  const incidentRepo = createMockRepository<AlertIncident>();
  incidentRepo.findOne.mockResolvedValue(opts.existingIncident ?? null);
  incidentRepo.create.mockImplementation((dto) => {
    const incident = { id: 'incident-1', ...dto } as AlertIncident;
    incident.addTimelineEvent = jest.fn();
    incident.recordOccurrence = jest.fn();
    return incident;
  });
  incidentRepo.save.mockImplementation(async (i) => i as AlertIncident);

  const escalation: EscalationDouble = { startEscalation: jest.fn().mockResolvedValue(null) };
  // The service's escalation param is narrowed to Pick<…,'startEscalation'>,
  // so the double slots in with NO cast.
  const service = new FarmSignalIncidentService(incidentRepo, escalation);
  return { service, incidentRepo, escalation };
}

describe('FarmSignalIncidentService', () => {
  it('creates a NEW incident and starts escalation when none is open', async () => {
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });

    await service.ensureIncident(makeSpec());

    expect(incidentRepo.create).toHaveBeenCalledTimes(1);
    const created = incidentRepo.create.mock.calls[0]?.[0] as Partial<AlertIncident>;
    // ALERT-CRITICAL-009: the farm identity lives in signal_key; rule_id (FK) stays NULL.
    expect(created.ruleId).toBeNull();
    expect(created.signalKey).toBe(KEY);
    expect(created.siteId).toBe(SITE_ID);
    expect(created.title).toBe('High Mortality (cumulative_rate): batch b-1');
    expect(created.severity).toBe(AlertSeverity.CRITICAL);
    expect(created.occurrenceCount).toBe(1);
    expect(created.lastOccurredAt).toBe(TRIGGERED_AT);

    expect(incidentRepo.save).toHaveBeenCalled();
    expect(escalation.startEscalation).toHaveBeenCalledTimes(1);
    const [incidentArg, severityArg, ruleArg] = escalation.startEscalation.mock.calls[0] ?? [];
    expect(severityArg).toBe(AlertSeverity.CRITICAL);
    expect(ruleArg).toBe(KEY);
    expect(incidentArg).toBeDefined();
  });

  it('carries the caller severity through to the incident and escalation', async () => {
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });

    await service.ensureIncident(makeSpec({ severity: AlertSeverity.WARNING }));

    const created = incidentRepo.create.mock.calls[0]?.[0] as Partial<AlertIncident>;
    expect(created.severity).toBe(AlertSeverity.WARNING);
    const [, severityArg] = escalation.startEscalation.mock.calls[0] ?? [];
    expect(severityArg).toBe(AlertSeverity.WARNING);
  });

  it('bumps an existing open incident instead of creating a new one', async () => {
    const existing = openIncident(AlertSeverity.CRITICAL);
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });

    await service.ensureIncident(makeSpec());

    expect(existing.recordOccurrence).toHaveBeenCalledTimes(1);
    expect(existing.recordOccurrence).toHaveBeenCalledWith(TRIGGERED_AT);
    expect(incidentRepo.save).toHaveBeenCalledWith(existing);
    expect(incidentRepo.create).not.toHaveBeenCalled();
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  /**
   * W7 / FARM-MEDIUM-259 — dedup used to freeze an incident at the severity it
   * was FIRST opened with. A feed-stockout opened at WARNING on day 7 of cover
   * stayed WARNING all the way down to day 1: the CRITICAL threshold the
   * coverage service recomputed every morning was passed in and discarded,
   * because the escalation ladder is chosen at `startEscalation` time and that
   * only ran on creation.
   */
  it('promotes an open incident when a MORE severe occurrence arrives, and re-runs escalation', async () => {
    const existing = openIncident(AlertSeverity.WARNING);
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });

    await service.ensureIncident(
      makeSpec({
        severity: AlertSeverity.CRITICAL,
        description: '2 days of cover remaining',
        triggerData: { historyId: 'history-2', daysOfCover: 2 },
      }),
    );

    expect(existing.severity).toBe(AlertSeverity.CRITICAL);
    // The operator opening the incident must read the CURRENT reason, not the
    // one it was opened with seven days ago.
    expect(existing.description).toBe('2 days of cover remaining');
    expect(existing.triggerData).toEqual({ historyId: 'history-2', daysOfCover: 2 });
    expect(existing.addTimelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TimelineEventType.ESCALATED,
        data: { previousSeverity: AlertSeverity.WARNING, severity: AlertSeverity.CRITICAL },
      }),
    );
    expect(incidentRepo.create).not.toHaveBeenCalled();

    expect(escalation.startEscalation).toHaveBeenCalledTimes(1);
    const [, severityArg, ruleArg] = escalation.startEscalation.mock.calls[0] ?? [];
    expect(severityArg).toBe(AlertSeverity.CRITICAL);
    expect(ruleArg).toBe(KEY);
  });

  it('does NOT de-escalate or re-page when a less severe occurrence arrives', async () => {
    const existing = openIncident(AlertSeverity.CRITICAL);
    const { service, escalation } = makeService({ existingIncident: existing });

    await service.ensureIncident(makeSpec({ severity: AlertSeverity.WARNING }));

    // De-escalation is an operator decision (resolve/close); re-running the
    // ladder on every repeat occurrence would be a pager storm.
    expect(existing.severity).toBe(AlertSeverity.CRITICAL);
    expect(existing.addTimelineEvent).not.toHaveBeenCalled();
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('keeps the escalated incident write and PROPAGATES a failed re-run escalation', async () => {
    // SCENARIO: severity rises, but the ladder cannot start (policy lookup down).
    // EXPECTS: the promoted incident is saved AND the failure reaches the consumer,
    //          which re-drives the event (a swallowed failure silenced the alarm).
    const existing = openIncident(AlertSeverity.WARNING);
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });
    escalation.startEscalation.mockRejectedValueOnce(new Error('policy service down'));

    await expect(
      service.ensureIncident(makeSpec({ severity: AlertSeverity.CRITICAL })),
    ).rejects.toThrow('policy service down');
    expect(incidentRepo.save).toHaveBeenCalledWith(existing);
  });

  it('propagates a failed first escalation after the incident is written', async () => {
    // SCENARIO: a new incident; its first escalation fails.
    // EXPECTS: the incident row landed, and the error propagates so the redelivery
    //          finds the level-0 incident and retries the escalation.
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });
    escalation.startEscalation.mockRejectedValueOnce(new Error('outbox down'));

    await expect(service.ensureIncident(makeSpec())).rejects.toThrow('outbox down');
    expect(incidentRepo.save).toHaveBeenCalledTimes(1);
  });

  it('retries escalation on every occurrence while the open incident was never escalated', async () => {
    // SCENARIO: the incident opened before any policy existed (escalation level 0).
    // EXPECTS: a same-severity repeat re-starts the ladder — level-triggered, so a
    //          policy seeded later still pages someone (ALERT-CRITICAL-004).
    const existing = openIncident(AlertSeverity.CRITICAL, 0);
    const { service, escalation } = makeService({ existingIncident: existing });

    await service.ensureIncident(makeSpec());

    expect(escalation.startEscalation).toHaveBeenCalledTimes(1);
    const [, severityArg, ruleArg] = escalation.startEscalation.mock.calls[0] ?? [];
    expect(severityArg).toBe(AlertSeverity.CRITICAL);
    expect(ruleArg).toBe(KEY);
  });

  it('fills in a site learnt from a later event, never overwriting a known one', async () => {
    // SCENARIO: the incident opened from an event that predates the siteId field.
    // EXPECTS: the next occurrence's site is recorded; a known site is kept.
    const siteless = openIncident(AlertSeverity.CRITICAL);
    siteless.siteId = null;
    const { service } = makeService({ existingIncident: siteless });

    await service.ensureIncident(makeSpec());
    expect(siteless.siteId).toBe(SITE_ID);

    const known = openIncident(AlertSeverity.CRITICAL);
    const second = makeService({ existingIncident: known });
    await second.service.ensureIncident(
      makeSpec({ siteId: '44444444-4444-4444-8444-444444444444' }),
    );
    expect(known.siteId).toBe(SITE_ID);
  });

  it('joins the winning incident when a concurrent delivery opened it first', async () => {
    // SCENARIO: two deliveries of one condition both saw "no open incident"; this
    //           one lost the insert to uq_alert_incidents_open_signal.
    // EXPECTS: no second incident — the occurrence bumps the winner.
    const winner = openIncident(AlertSeverity.CRITICAL);
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });
    incidentRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    const race = new QueryFailedError(
      'INSERT',
      [],
      Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint: 'uq_alert_incidents_open_signal',
      }),
    );
    incidentRepo.save.mockRejectedValueOnce(race).mockImplementation(async (i) => i as AlertIncident);

    await service.ensureIncident(makeSpec());

    expect(winner.recordOccurrence).toHaveBeenCalledWith(TRIGGERED_AT);
    expect(incidentRepo.save).toHaveBeenLastCalledWith(winner);
    // The winner is already escalated (level 1) and the severity did not rise.
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('rethrows any other insert failure', async () => {
    // SCENARIO: the insert fails for a reason other than the open-incident race.
    // EXPECTS: the error propagates untouched (no silent bump of a stranger).
    const { service, incidentRepo } = makeService({ existingIncident: null });
    incidentRepo.save.mockRejectedValueOnce(
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('check violation'), {
          code: '23514',
          constraint: 'CHK_alert_incidents_rule_xor_signal',
        }),
      ),
    );

    await expect(service.ensureIncident(makeSpec())).rejects.toBeInstanceOf(QueryFailedError);
  });
});
