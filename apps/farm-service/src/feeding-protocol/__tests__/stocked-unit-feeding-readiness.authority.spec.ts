import type { OutboxPublisher } from '@platform/outbox';
import { createMockDataSource } from '@aquaculture/testing';

import {
  findUnfedStockedUnitsV1,
  publishUnfedStockedUnitSignalsV1,
} from '../stocked-unit-feeding-readiness.authority';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';

function managerWithRows(rows: readonly unknown[]) {
  const { mockManager } = createMockDataSource();
  mockManager.query.mockResolvedValue(rows);
  return { manager: mockManager, query: mockManager.query };
}

describe('stocked-unit feeding readiness authority', () => {
  it('starts from positive stock and detects a tenant with no assignment', async () => {
    const row = {
      unitId: 'unit-1',
      unitCode: 'T-01',
      siteId: SITE,
      fishCount: '1200',
      biomassKg: '240.5',
      reason: 'no_assignment' as const,
    };
    const { manager, query } = managerWithRows([row]);

    await expect(findUnfedStockedUnitsV1(manager, TENANT, SITE)).resolves.toEqual([row]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('FROM "tank_batches" tb');
    expect(sql).toContain('tb."totalQuantity" > 0');
    expect(sql).toContain('tb."tenantId" = $1');
    expect(sql).toContain("p.status IS DISTINCT FROM 'active'");
    expect(query).toHaveBeenCalledWith(expect.any(String), [TENANT, SITE]);
  });

  it('publishes one durable signal with exact stock provenance', async () => {
    const { manager } = managerWithRows([
      {
        unitId: 'unit-1',
        unitCode: 'T-01',
        siteId: SITE,
        fishCount: '1200',
        biomassKg: '240.5',
        reason: 'no_assignment',
      },
    ]);
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const outbox = { enqueue } as Pick<OutboxPublisher, 'enqueue'>;

    await expect(publishUnfedStockedUnitSignalsV1(manager, outbox, TENANT, SITE)).resolves.toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'UnfedUnitDetected',
        tenantId: TENANT,
        unitId: 'unit-1',
        siteId: SITE,
        reason: 'no_assignment',
        fishCount: 1200,
        biomassKg: 240.5,
      }),
      manager,
    );
  });

  it('fails closed before publication when a row escapes the governed site', async () => {
    const { manager } = managerWithRows([
      {
        unitId: 'unit-1',
        unitCode: 'T-01',
        siteId: '33333333-3333-4333-8333-333333333333',
        fishCount: 1,
        biomassKg: 1,
        reason: 'no_assignment',
      },
    ]);
    const enqueue = jest.fn();

    await expect(
      publishUnfedStockedUnitSignalsV1(
        manager,
        { enqueue } as Pick<OutboxPublisher, 'enqueue'>,
        TENANT,
        SITE,
      ),
    ).rejects.toThrow(/without Site authority/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
