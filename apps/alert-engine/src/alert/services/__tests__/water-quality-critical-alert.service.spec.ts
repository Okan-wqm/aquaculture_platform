/**
 * WaterQualityCriticalAlertService unit specs (FARM-MEDIUM-118)
 *
 * Proves the alert-engine REAL consumer for the farm-raised
 * `WaterQualityCritical` event: the event is converted into a real AlertHistory
 * row and delegated to the shared FarmSignalIncidentService lifecycle
 * (FARM-LOW-144) — previously the outbox-published event reached only the
 * gateway's browser bridge and never entered the alert lifecycle.
 *
 * London-school: the history repository is a @platform/testing double and the
 * incident lifecycle is a typed FarmSignalIncidentService double. This spec owns
 * the history/message shaping (per-parameter detail, equipmentId fallback,
 * malformed-entry drop) and the water-quality incident spec; the dedup/
 * escalation behaviour is proven once in farm-signal-incident.service.spec.ts.
 */
import { createMockRepository } from '@aquaculture/testing';
import { createBaseEvent } from '@platform/event-contracts';
import type { WaterQualityCriticalEvent } from '@platform/event-contracts';

import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import { AlertHistory } from '../../entities/alert-history.entity';
import {
  FarmSignalIncidentService,
  FarmSignalIncidentSpec,
} from '../farm-signal-incident.service';
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

/** Minimal FarmSignalIncidentService double — only ensureIncident is called. */
type IncidentDouble = jest.Mocked<Pick<FarmSignalIncidentService, 'ensureIncident'>>;

function makeService(): {
  service: WaterQualityCriticalAlertService;
  historyRepo: jest.Mocked<import('typeorm').Repository<AlertHistory>>;
  farmSignalIncident: IncidentDouble;
} {
  const historyRepo = createMockRepository<AlertHistory>();
  historyRepo.create.mockImplementation((dto) => dto as AlertHistory);
  historyRepo.save.mockImplementation(async (h) => ({ id: 'history-1', ...h }) as AlertHistory);

  const farmSignalIncident: IncidentDouble = {
    ensureIncident: jest.fn().mockResolvedValue(undefined),
  };
  // The service's collaborator param is narrowed to Pick<…,'ensureIncident'>,
  // so the double slots in with NO cast.
  const service = new WaterQualityCriticalAlertService(historyRepo, farmSignalIncident);
  return { service, historyRepo, farmSignalIncident };
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

  it('drops a malformed critical-parameter entry (no undefined leaks into the message) — FARM-LOW-135', async () => {
    const { service, historyRepo } = makeService();

    await service.recordCriticalWaterQuality(
      makeEvent({
        // Missing name/direction/threshold — the old guard let it through and
        // rendered "undefined 3.1 undefined undefined".
        criticalParametersJson: JSON.stringify([{ code: 'ph', value: 3.1 }]),
        criticalParameterCount: 1,
      }),
    );

    const saved = historyRepo.save.mock.calls[0]?.[0] as AlertHistory;
    expect(saved.message).not.toContain('undefined');
    // Degrades to the count-only message because the sole entry was dropped.
    expect(saved.message).toBe(
      `Water quality critical at tank ${TANK_ID}: 1 parameter(s) out of critical range`,
    );
  });

  it('delegates the water-quality-shaped incident spec to the shared lifecycle', async () => {
    const { service, farmSignalIncident } = makeService();

    await service.recordCriticalWaterQuality(makeEvent());

    expect(farmSignalIncident.ensureIncident).toHaveBeenCalledTimes(1);
    const spec = farmSignalIncident.ensureIncident.mock.calls[0]?.[0] as FarmSignalIncidentSpec;
    expect(spec.tenantId).toBe(TENANT_ID);
    expect(spec.ruleId).toBe(`system:water-quality:${TANK_ID}`);
    expect(spec.severity).toBe(AlertSeverity.CRITICAL);
    expect(spec.signalLabel).toBe('water-quality');
    expect(spec.title).toBe(`Water Quality Critical: tank ${TANK_ID}`);
    expect(spec.description).toContain('Dissolved Oxygen 3.1mg/L below 4.5mg/L');
    expect(spec.triggeredAt).toEqual(new Date('2026-06-10T08:00:00.000Z'));
    expect(spec.triggerData).toMatchObject({
      historyId: 'history-1',
      measurementId: MEASUREMENT_ID,
      tankId: TANK_ID,
      criticalParameterCount: 2,
    });
  });

  it('titles the incident by equipment when no tank is present', async () => {
    const { service, farmSignalIncident } = makeService();

    await service.recordCriticalWaterQuality(
      makeEvent({ tankId: null, equipmentId: 'equip-9' }),
    );

    const spec = farmSignalIncident.ensureIncident.mock.calls[0]?.[0] as FarmSignalIncidentSpec;
    expect(spec.title).toBe('Water Quality Critical: equipment equip-9');
    expect(spec.ruleId).toBe('system:water-quality:equip-9');
  });
});
