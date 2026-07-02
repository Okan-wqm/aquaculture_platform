/**
 * WaterQualityCriticalAlertService unit specs (FARM-MEDIUM-118)
 *
 * Proves the alert-engine REAL consumer for the farm-raised
 * `WaterQualityCritical` event: the event is converted into a real
 * AlertHistory row + an AlertIncident that feeds the escalation pipeline —
 * previously the outbox-published event reached only the gateway's browser
 * bridge and never entered the alert lifecycle.
 *
 * London-school: repositories are @platform/testing doubles; the escalation
 * manager is a typed double (only startEscalation is exercised).
 */
import { createMockRepository } from '@aquaculture/testing';
import { createBaseEvent } from '@platform/event-contracts';
import type { WaterQualityCriticalEvent } from '@platform/event-contracts';

import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import {
  AlertIncident,
  IncidentStatus,
} from '../../../database/entities/alert-incident.entity';
import { AlertHistory } from '../../entities/alert-history.entity';
import { EscalationManagerService } from '../../../escalation/escalation-manager.service';
import { WaterQualityCriticalAlertService } from '../water-quality-critical-alert.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const MEASUREMENT_ID = '22222222-2222-4222-8222-222222222222';
const TANK_ID = '33333333-3333-4333-8333-333333333333';

const CRITICAL_PARAMS = [
  {
    code: 'dissolved_oxygen',
    name: 'Dissolved Oxygen',
    value: 3.1,
    threshold: 4.5,
    direction: 'below',
    unit: 'mg/L',
  },
  { code: 'ph', name: 'pH', value: 5.2, threshold: 6, direction: 'below' },
];

function makeEvent(
  overrides: Partial<WaterQualityCriticalEvent> = {},
): WaterQualityCriticalEvent {
  return {
    ...createBaseEvent<WaterQualityCriticalEvent>('WaterQualityCritical', TENANT_ID),
    eventType: 'WaterQualityCritical',
    measurementId: MEASUREMENT_ID,
    equipmentId: null,
    tankId: TANK_ID,
    criticalParametersJson: JSON.stringify(CRITICAL_PARAMS),
    criticalParameterCount: 2,
    measuredAt: '2026-06-10T08:00:00.000Z',
    ...overrides,
  };
}

/** Minimal EscalationManagerService double — only startEscalation is called. */
type EscalationDouble = jest.Mocked<Pick<EscalationManagerService, 'startEscalation'>>;

function makeService(opts: { existingIncident?: AlertIncident | null } = {}): {
  service: WaterQualityCriticalAlertService;
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

  const escalation: EscalationDouble = { startEscalation: jest.fn().mockResolvedValue(null) };
  // The service's escalation param is narrowed to Pick<…,'startEscalation'>,
  // so the double slots in with NO cast.
  const service = new WaterQualityCriticalAlertService(historyRepo, incidentRepo, escalation);
  return { service, historyRepo, incidentRepo, escalation };
}

describe('WaterQualityCriticalAlertService', () => {
  it('records a CRITICAL AlertHistory row with per-tank synthetic rule id + parameter detail', async () => {
    const { service, historyRepo } = makeService();

    await service.recordCriticalWaterQuality(makeEvent());

    expect(historyRepo.save).toHaveBeenCalledTimes(1);
    const saved = historyRepo.save.mock.calls[0]?.[0] as AlertHistory;
    expect(saved.tenantId).toBe(TENANT_ID);
    expect(saved.severity).toBe(AlertSeverity.CRITICAL);
    expect(saved.ruleId).toBe(`system:water-quality:${TANK_ID}`);
    expect(saved.message).toContain('Dissolved Oxygen 3.1mg/L below 4.5mg/L');
    expect(saved.message).toContain('pH 5.2 below 6');
    expect(saved.triggeredAt).toEqual(new Date('2026-06-10T08:00:00.000Z'));
    const triggering = saved.triggeringData as { source: string; criticalParameters: unknown[] };
    expect(triggering.source).toBe('farm.water-quality');
    expect(triggering.criticalParameters).toHaveLength(2);
  });

  it('falls back to equipmentId scoping and count-only message on malformed JSON', async () => {
    const { service, historyRepo } = makeService();

    await service.recordCriticalWaterQuality(
      makeEvent({
        tankId: null,
        equipmentId: 'equip-9',
        criticalParametersJson: 'not-json{{',
        criticalParameterCount: 3,
      }),
    );

    const saved = historyRepo.save.mock.calls[0]?.[0] as AlertHistory;
    expect(saved.ruleId).toBe('system:water-quality:equip-9');
    expect(saved.message).toBe(
      'Water quality critical at equipment equip-9: 3 parameter(s) out of critical range',
    );
  });

  it('creates a NEW incident and starts escalation when none is open', async () => {
    const { service, incidentRepo, escalation } = makeService({ existingIncident: null });

    await service.recordCriticalWaterQuality(makeEvent());

    expect(incidentRepo.create).toHaveBeenCalledTimes(1);
    expect(incidentRepo.save).toHaveBeenCalled();
    expect(escalation.startEscalation).toHaveBeenCalledTimes(1);
    const [incidentArg, severityArg, ruleArg] = escalation.startEscalation.mock.calls[0] ?? [];
    expect(severityArg).toBe(AlertSeverity.CRITICAL);
    expect(ruleArg).toBe(`system:water-quality:${TANK_ID}`);
    expect(incidentArg).toBeDefined();
  });

  it('bumps an existing open incident instead of creating a new one', async () => {
    const recordOccurrence = jest.fn();
    const existing = {
      id: 'incident-existing',
      occurrenceCount: 1,
      status: IncidentStatus.NEW,
      recordOccurrence,
    } as Partial<AlertIncident> as AlertIncident;
    const { service, incidentRepo, escalation } = makeService({ existingIncident: existing });

    await service.recordCriticalWaterQuality(makeEvent());

    expect(recordOccurrence).toHaveBeenCalledTimes(1);
    expect(incidentRepo.create).not.toHaveBeenCalled();
    expect(escalation.startEscalation).not.toHaveBeenCalled();
  });
});
