import { LowStockAlertService } from '../low-stock-alert.service';
import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import type { LowStockDetectedEvent } from '@platform/event-contracts';

/**
 * LowStockAlertService unit tests (stock SSoT Phase 1, FARM-HIGH-217).
 *
 * Pins the signal-shaping contract on top of the shared farm-signal
 * incident lifecycle: severity mapping (out_of_stock → CRITICAL),
 * per-item synthetic rule identity (dedup key), the AlertHistory row,
 * and the ensureIncident spec handed to FarmSignalIncidentService.
 */
describe('LowStockAlertService', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';

  let historyRepository: { create: jest.Mock; save: jest.Mock };
  let farmSignalIncident: { ensureIncident: jest.Mock };
  let service: LowStockAlertService;

  const makeEvent = (overrides: Partial<LowStockDetectedEvent> = {}): LowStockDetectedEvent =>
    ({
      eventId: 'evt-1',
      eventType: 'LowStockDetected',
      timestamp: '2026-07-16T10:00:00.000Z',
      tenantId,
      version: 1,
      itemType: 'feed',
      itemId: 'feed-1',
      itemName: 'Grower 4mm',
      currentQuantity: 80,
      unit: 'kg',
      minimumThreshold: 100,
      severity: 'low_stock',
      ...overrides,
    }) as LowStockDetectedEvent;

  beforeEach(() => {
    historyRepository = {
      create: jest.fn().mockImplementation((row: unknown) => row),
      save: jest
        .fn()
        .mockImplementation((row: object) => Promise.resolve({ ...row, id: 'hist-1' })),
    };
    farmSignalIncident = { ensureIncident: jest.fn().mockResolvedValue(undefined) };
    service = new LowStockAlertService(historyRepository as never, farmSignalIncident as never);
  });

  it('records an AlertHistory row with a per-item synthetic rule identity', async () => {
    await service.recordLowStockAlert(makeEvent());

    expect(historyRepository.save).toHaveBeenCalledTimes(1);
    const row = historyRepository.create.mock.calls[0][0];
    expect(row.ruleId).toBe('system:low-stock:feed:feed-1');
    expect(row.tenantId).toBe(tenantId);
    expect(row.severity).toBe(AlertSeverity.WARNING);
    expect(row.message).toContain('Grower 4mm');
    expect(row.message).toContain('80 kg');
    expect(row.triggeringData).toMatchObject({
      source: 'farm.storage.lowStock',
      itemId: 'feed-1',
      currentQuantity: 80,
      minimumThreshold: 100,
    });
  });

  it('maps out_of_stock to a CRITICAL incident', async () => {
    await service.recordLowStockAlert(makeEvent({ severity: 'out_of_stock', currentQuantity: 0 }));

    const spec = farmSignalIncident.ensureIncident.mock.calls[0][0];
    expect(spec.severity).toBe(AlertSeverity.CRITICAL);
    expect(spec.description).toContain('OUT OF STOCK');
  });

  it('hands the shared lifecycle a spec keyed to the same rule identity (dedup)', async () => {
    await service.recordLowStockAlert(makeEvent());

    expect(farmSignalIncident.ensureIncident).toHaveBeenCalledTimes(1);
    const spec = farmSignalIncident.ensureIncident.mock.calls[0][0];
    expect(spec).toMatchObject({
      tenantId,
      ruleId: 'system:low-stock:feed:feed-1',
      title: 'Low Stock (feed): Grower 4mm',
      severity: AlertSeverity.WARNING,
      signalLabel: 'low-stock',
    });
    expect(spec.triggerData.historyId).toBe('hist-1');
    expect(spec.triggeredAt).toEqual(new Date('2026-07-16T10:00:00.000Z'));
  });

  it('keys the rule identity by item type + id so different items never dedup together', async () => {
    await service.recordLowStockAlert(
      makeEvent({ itemType: 'chemical', itemId: 'chem-9', itemName: 'Chlorine' }),
    );

    const spec = farmSignalIncident.ensureIncident.mock.calls[0][0];
    expect(spec.ruleId).toBe('system:low-stock:chemical:chem-9');
  });
});
