import { FcrAlertService } from '../fcr-alert.service';
import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import type { FCRAlertEvent } from '@platform/event-contracts';

/**
 * FcrAlertService unit tests (feeding-protocol cycle, C-1).
 *
 * Pins the signal-shaping contract on top of the shared farm-signal
 * incident lifecycle: severity mapping (critical alert level → CRITICAL),
 * per-batch synthetic rule identity (dedup key — nightly sweeps bump ONE
 * open incident per batch), the AlertHistory row, and the ensureIncident
 * spec handed to FarmSignalIncidentService.
 */
describe('FcrAlertService', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';

  let historyRepository: { create: jest.Mock; save: jest.Mock };
  let farmSignalIncident: { ensureIncident: jest.Mock };
  let service: FcrAlertService;

  const makeEvent = (overrides: Partial<FCRAlertEvent> = {}): FCRAlertEvent =>
    ({
      eventId: 'evt-1',
      eventType: 'FCRAlert',
      timestamp: '2026-07-16T18:00:00.000Z',
      tenantId,
      version: 1,
      batchId: 'batch-1',
      currentFCR: 1.72,
      targetFCR: 1.5,
      variancePercent: 14.7,
      trend: 'declining',
      alertLevel: 'warning',
      ...overrides,
    }) as FCRAlertEvent;

  beforeEach(() => {
    historyRepository = {
      create: jest.fn().mockImplementation((row: unknown) => row),
      save: jest.fn().mockImplementation((row: object) => Promise.resolve({ ...row, id: 'hist-1' })),
    };
    farmSignalIncident = { ensureIncident: jest.fn().mockResolvedValue(undefined) };
    service = new FcrAlertService(historyRepository as never, farmSignalIncident as never);
  });

  it('records an AlertHistory row with a per-batch synthetic rule identity', async () => {
    await service.recordFcrAlert(makeEvent());

    expect(historyRepository.save).toHaveBeenCalledTimes(1);
    const row = historyRepository.create.mock.calls[0][0];
    expect(row.ruleId).toBe('system:fcr:batch-1');
    expect(row.tenantId).toBe(tenantId);
    expect(row.severity).toBe(AlertSeverity.WARNING);
    expect(row.message).toContain('1.72');
    expect(row.message).toContain('1.50');
    expect(row.message).toContain('declining');
    expect(row.triggeringData).toMatchObject({
      source: 'farm.feeding.fcrAlert',
      batchId: 'batch-1',
      currentFCR: 1.72,
      targetFCR: 1.5,
      fcrAlertLevel: 'warning',
    });
  });

  it('maps the critical alert level to a CRITICAL incident', async () => {
    await service.recordFcrAlert(
      makeEvent({ alertLevel: 'critical', currentFCR: 2.1, variancePercent: 40 }),
    );

    const spec = farmSignalIncident.ensureIncident.mock.calls[0][0];
    expect(spec.severity).toBe(AlertSeverity.CRITICAL);
  });

  it('hands the shared lifecycle a spec keyed to the same rule identity (dedup)', async () => {
    await service.recordFcrAlert(makeEvent());

    expect(farmSignalIncident.ensureIncident).toHaveBeenCalledTimes(1);
    const spec = farmSignalIncident.ensureIncident.mock.calls[0][0];
    expect(spec).toMatchObject({
      tenantId,
      ruleId: 'system:fcr:batch-1',
      title: 'FCR Threshold: batch batch-1',
      severity: AlertSeverity.WARNING,
      signalLabel: 'fcr',
    });
    expect(spec.triggerData.historyId).toBe('hist-1');
    expect(spec.triggeredAt).toEqual(new Date('2026-07-16T18:00:00.000Z'));
  });

  it('keys the rule identity by batch so different batches never dedup together', async () => {
    await service.recordFcrAlert(makeEvent({ batchId: 'batch-9' }));

    const spec = farmSignalIncident.ensureIncident.mock.calls[0][0];
    expect(spec.ruleId).toBe('system:fcr:batch-9');
  });
});
