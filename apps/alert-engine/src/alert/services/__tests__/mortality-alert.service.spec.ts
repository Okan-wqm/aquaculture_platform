/**
 * MortalityAlertService unit specs
 *
 * Proves the alert-engine REAL consumer for the farm-raised
 * `MortalityAlertRaised` event (dead-listeners produce-side cure, blocker 4):
 * the event is converted into a real AlertHistory row + an AlertIncident that
 * feeds the escalation pipeline — instead of an EventEmitter2 emit with no
 * listener.
 *
 * London-school: repositories are @platform/testing doubles; the escalation
 * manager is a typed double (only startEscalation is exercised).
 */
import { createMockRepository } from '@aquaculture/testing';
import { createBaseEvent } from '@platform/event-contracts';
import type { MortalityAlertRaisedEvent } from '@platform/event-contracts';

import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import {
  AlertIncident,
  IncidentStatus,
} from '../../../database/entities/alert-incident.entity';
import { AlertHistory } from '../../entities/alert-history.entity';
import { EscalationManagerService } from '../../../escalation/escalation-manager.service';
import { MortalityAlertService } from '../mortality-alert.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';

function makeEvent(
  overrides: Partial<MortalityAlertRaisedEvent> = {},
): MortalityAlertRaisedEvent {
  return {
    ...createBaseEvent<MortalityAlertRaisedEvent>('MortalityAlertRaised', TENANT_ID, {
      aggregateId: BATCH_ID,
      aggregateType: 'Batch',
    }),
    eventType: 'MortalityAlertRaised',
    batchId: BATCH_ID,
    alertType: 'cumulative_rate',
    severity: 'critical',
    message: 'Cumulative mortality rate 12.00% is critical',
    mortalityRate: 12,
    reason: 'DISEASE',
    recordedAt: '2026-06-10T08:00:00.000Z',
    ...overrides,
  };
}

/** Minimal EscalationManagerService double — only startEscalation is called. */
type EscalationDouble = jest.Mocked<Pick<EscalationManagerService, 'startEscalation'>>;

function makeEscalation(): EscalationDouble {
  return { startEscalation: jest.fn().mockResolvedValue(null) };
}

function makeService(opts: { existingIncident?: AlertIncident | null } = {}): {
  service: MortalityAlertService;
  historyRepo: jest.Mocked<import('typeorm').Repository<AlertHistory>>;
  incidentRepo: jest.Mocked<import('typeorm').Repository<AlertIncident>>;
  escalation: EscalationDouble;
} {
  const historyRepo = createMockRepository<AlertHistory>();
  historyRepo.create.mockImplementation((dto) => dto as AlertHistory);
  historyRepo.save.mockImplementation(async (h) => ({ id: 'history-1', ...h }) as AlertHistory);

  const incidentRepo = createMockRepository<AlertIncident>();
  incidentRepo.findOne.mockResolvedValue(opts.existingIncident ?? null);
  incidentRepo.create.mockImplementation((dto) => {
    const incident = { id: 'incident-1', ...dto } as AlertIncident;
    incident.addTimelineEvent = jest.fn();
    incident.recordOccurrence = jest.fn();
    return incident;
  });
  incidentRepo.save.mockImplementation(async (i) => i as AlertIncident);

  const escalation = makeEscalation();
  // The service's escalation param is narrowed to Pick<…,'startEscalation'>,
  // so the double slots in with NO cast.
  const service = new MortalityAlertService(historyRepo, incidentRepo, escalation);
  return { service, historyRepo, incidentRepo, escalation };
}

describe('MortalityAlertService', () => {
  it('records an AlertHistory row with mapped severity + synthetic rule id', async () => {
    const { service, historyRepo } = makeService();

    await service.recordMortalityAlert(makeEvent());

    expect(historyRepo.save).toHaveBeenCalledTimes(1);
    const saved = historyRepo.save.mock.calls[0]?.[0] as AlertHistory;
    expect(saved.tenantId).toBe(TENANT_ID);
    expect(saved.severity).toBe(AlertSeverity.CRITICAL);
    expect(saved.ruleId).toBe('system:mortality:cumulative_rate');
    expect(saved.triggeredAt).toBeInstanceOf(Date);
  });

  it('maps a warning alert to AlertSeverity.WARNING', async () => {
    const { service, historyRepo } = makeService();

    await service.recordMortalityAlert(makeEvent({ severity: 'warning' }));

    const saved = historyRepo.save.mock.calls[0]?.[0] as AlertHistory;
    expect(saved.severity).toBe(AlertSeverity.WARNING);
  });

  it('creates a NEW incident and starts escalation when none is open', async () => {
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });

    await service.recordMortalityAlert(makeEvent());

    expect(incidentRepo.create).toHaveBeenCalledTimes(1);
    expect(incidentRepo.save).toHaveBeenCalled();
    expect(escalation.startEscalation).toHaveBeenCalledTimes(1);
    const [incidentArg, severityArg, ruleArg] = escalation.startEscalation.mock.calls[0] ?? [];
    expect(severityArg).toBe(AlertSeverity.CRITICAL);
    expect(ruleArg).toBe('system:mortality:cumulative_rate');
    expect(incidentArg).toBeDefined();
  });

  it('bumps an existing open incident instead of creating a new one', async () => {
    // Structurally-sufficient open-incident fixture: a single typed widening
    // (not unsafe casts) — the service only reads status and
    // calls recordOccurrence on it.
    const recordOccurrence = jest.fn();
    const existing = {
      id: 'incident-existing',
      occurrenceCount: 1,
      status: IncidentStatus.NEW,
      recordOccurrence,
    } as Partial<AlertIncident> as AlertIncident;
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });

    await service.recordMortalityAlert(makeEvent());

    expect(recordOccurrence).toHaveBeenCalledTimes(1);
    expect(incidentRepo.create).not.toHaveBeenCalled();
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });
});
