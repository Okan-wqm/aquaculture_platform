/**
 * MortalityAlertService unit specs
 *
 * Proves the alert-engine REAL consumer for the farm-raised
 * `MortalityAlertRaised` event (dead-listeners produce-side cure, blocker 4):
 * the event is converted into a real AlertHistory row and delegated to the
 * shared FarmSignalIncidentService lifecycle (FARM-LOW-144) — instead of an
 * EventEmitter2 emit with no listener.
 *
 * London-school: the history repository is a @platform/testing double and the
 * incident lifecycle is a typed FarmSignalIncidentService double, so this spec
 * asserts (a) the audit row is shaped correctly and (b) the mortality-specific
 * incident spec is handed to the SSoT. The dedup/escalation behaviour itself is
 * proven once in farm-signal-incident.service.spec.ts.
 */
import { createMockRepository } from '@aquaculture/testing';
import { createBaseEvent } from '@platform/event-contracts';
import type { MortalityAlertRaisedEvent } from '@platform/event-contracts';

import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import { AlertHistory } from '../../entities/alert-history.entity';
import {
  FarmSignalIncidentService,
  FarmSignalIncidentSpec,
} from '../farm-signal-incident.service';
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

/** Minimal FarmSignalIncidentService double — only ensureIncident is called. */
type IncidentDouble = jest.Mocked<Pick<FarmSignalIncidentService, 'ensureIncident'>>;

function makeService(): {
  service: MortalityAlertService;
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
  const service = new MortalityAlertService(historyRepo, farmSignalIncident);
  return { service, historyRepo, farmSignalIncident };
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

  it('maps a warning alert to AlertSeverity.WARNING (history + incident spec)', async () => {
    const { service, historyRepo, farmSignalIncident } = makeService();

    await service.recordMortalityAlert(makeEvent({ severity: 'warning' }));

    const saved = historyRepo.save.mock.calls[0]?.[0] as AlertHistory;
    expect(saved.severity).toBe(AlertSeverity.WARNING);
    const spec = farmSignalIncident.ensureIncident.mock.calls[0]?.[0] as FarmSignalIncidentSpec;
    expect(spec.severity).toBe(AlertSeverity.WARNING);
  });

  it('delegates the mortality-shaped incident spec to the shared lifecycle', async () => {
    const { service, farmSignalIncident } = makeService();

    await service.recordMortalityAlert(makeEvent());

    expect(farmSignalIncident.ensureIncident).toHaveBeenCalledTimes(1);
    const spec = farmSignalIncident.ensureIncident.mock.calls[0]?.[0] as FarmSignalIncidentSpec;
    expect(spec.tenantId).toBe(TENANT_ID);
    expect(spec.ruleId).toBe('system:mortality:cumulative_rate');
    expect(spec.severity).toBe(AlertSeverity.CRITICAL);
    expect(spec.signalLabel).toBe('mortality');
    expect(spec.title).toBe(`High Mortality (cumulative_rate): batch ${BATCH_ID}`);
    expect(spec.description).toBe('Cumulative mortality rate 12.00% is critical');
    expect(spec.triggeredAt).toEqual(new Date('2026-06-10T08:00:00.000Z'));
    // The audit row id is threaded into the incident breadcrumb.
    expect(spec.triggerData).toMatchObject({
      historyId: 'history-1',
      batchId: BATCH_ID,
      alertType: 'cumulative_rate',
      mortalityRate: 12,
      reason: 'DISEASE',
    });
  });
});
