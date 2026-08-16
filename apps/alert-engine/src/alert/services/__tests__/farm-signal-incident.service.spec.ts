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
 */
import { createMockRepository } from '@aquaculture/testing';

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
const RULE_ID = 'system:mortality:cumulative_rate';
const TRIGGERED_AT = new Date('2026-06-10T08:00:00.000Z');

function makeSpec(overrides: Partial<FarmSignalIncidentSpec> = {}): FarmSignalIncidentSpec {
  return {
    tenantId: TENANT_ID,
    ruleId: RULE_ID,
    title: 'High Mortality (cumulative_rate): batch b-1',
    description: 'Cumulative mortality rate 12.00% is critical',
    severity: AlertSeverity.CRITICAL,
    triggerData: { historyId: 'history-1', batchId: 'b-1' },
    triggeredAt: TRIGGERED_AT,
    signalLabel: 'mortality',
    ...overrides,
  };
}

function openIncident(severity: AlertSeverity): {
  incident: AlertIncident;
  recordOccurrence: jest.SpyInstance;
  addTimelineEvent: jest.SpyInstance;
} {
  const incident = new AlertIncident();
  incident.id = 'incident-existing';
  incident.occurrenceCount = 1;
  incident.status = IncidentStatus.NEW;
  incident.severity = severity;
  incident.description = 'opened seven days ago';
  incident.triggerData = { historyId: 'history-1' };
  incident.timeline = [];
  return {
    incident,
    recordOccurrence: jest.spyOn(incident, 'recordOccurrence'),
    addTimelineEvent: jest.spyOn(incident, 'addTimelineEvent'),
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
    expect(created.ruleId).toBe(RULE_ID);
    expect(created.title).toBe('High Mortality (cumulative_rate): batch b-1');
    expect(created.severity).toBe(AlertSeverity.CRITICAL);
    expect(created.occurrenceCount).toBe(1);
    expect(created.lastOccurredAt).toBe(TRIGGERED_AT);

    expect(incidentRepo.save).toHaveBeenCalled();
    expect(escalation.startEscalation).toHaveBeenCalledTimes(1);
    const [incidentArg, severityArg, ruleArg] = escalation.startEscalation.mock.calls[0] ?? [];
    expect(severityArg).toBe(AlertSeverity.CRITICAL);
    expect(ruleArg).toBe(RULE_ID);
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
    const { incident: existing, recordOccurrence } = openIncident(AlertSeverity.CRITICAL);
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });

    await service.ensureIncident(makeSpec());

    expect(recordOccurrence).toHaveBeenCalledTimes(1);
    expect(recordOccurrence).toHaveBeenCalledWith(TRIGGERED_AT);
    expect(incidentRepo.save).toHaveBeenCalledWith(existing);
    expect(incidentRepo.create).not.toHaveBeenCalled();
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('promotes an open incident and re-runs escalation for a more severe occurrence', async () => {
    const { incident: existing, addTimelineEvent } = openIncident(AlertSeverity.WARNING);
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });

    await service.ensureIncident(
      makeSpec({
        severity: AlertSeverity.CRITICAL,
        description: '2 days of cover remaining',
        triggerData: { historyId: 'history-2', daysOfCover: 2 },
      }),
    );

    expect(existing.severity).toBe(AlertSeverity.CRITICAL);
    expect(existing.description).toBe('2 days of cover remaining');
    expect(existing.triggerData).toEqual({ historyId: 'history-2', daysOfCover: 2 });
    expect(addTimelineEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TimelineEventType.ESCALATED,
        data: { previousSeverity: AlertSeverity.WARNING, severity: AlertSeverity.CRITICAL },
      }),
    );
    expect(incidentRepo.create).not.toHaveBeenCalled();
    expect(escalation.startEscalation).toHaveBeenCalledWith(
      existing,
      AlertSeverity.CRITICAL,
      RULE_ID,
    );
  });

  it('does not de-escalate or re-page on a less severe occurrence', async () => {
    const { incident: existing, addTimelineEvent } = openIncident(AlertSeverity.CRITICAL);
    const { service, escalation } = makeService({ existingIncident: existing });

    await service.ensureIncident(makeSpec({ severity: AlertSeverity.WARNING }));

    expect(existing.severity).toBe(AlertSeverity.CRITICAL);
    expect(addTimelineEvent).not.toHaveBeenCalled();
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });

  it('keeps the promoted incident write when escalation delivery rejects', async () => {
    const { incident: existing } = openIncident(AlertSeverity.WARNING);
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });
    escalation.startEscalation.mockRejectedValueOnce(new Error('policy service down'));

    await expect(
      service.ensureIncident(makeSpec({ severity: AlertSeverity.CRITICAL })),
    ).resolves.toBeUndefined();
    expect(incidentRepo.save).toHaveBeenCalledWith(existing);
  });

  it('does not fail the incident write when escalation rejects (non-blocking)', async () => {
    const { service, escalation } = makeService({ existingIncident: null });
    escalation.startEscalation.mockRejectedValueOnce(new Error('policy service down'));

    // The rejected escalation is swallowed — the already-landed incident write
    // must not be undone by a downstream escalation failure.
    await expect(service.ensureIncident(makeSpec())).resolves.toBeUndefined();
  });
});
