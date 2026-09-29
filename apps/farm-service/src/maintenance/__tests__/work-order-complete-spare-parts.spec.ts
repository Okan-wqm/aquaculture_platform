/**
 * WorkOrderService.complete — spare parts leave stock through the ONE ledger
 * path (FARM-HIGH-338): materials with a spare-part id become ledger OUT
 * movements in the completion transaction, and a shortage rolls the whole
 * completion back instead of being clamped to zero.
 */
import { BadRequestException } from '@nestjs/common';
import { createMockDataSource, stub } from '@aquaculture/testing';
import type { Repository } from 'typeorm';

import { WorkOrder, WorkOrderStatus } from '../entities/work-order.entity';
import { MaintenanceSchedule } from '../entities/maintenance-schedule.entity';
import { WorkOrderService } from '../services/work-order.service';
import { SparePartLedgerService } from '../services/spare-part-ledger.service';
import type { CompleteWorkOrderInput } from '../dto/update-work-order.dto';

const TENANT = '11111111-1111-4111-8111-111111111111';

function build(consume: jest.Mock): {
  service: WorkOrderService;
  mockManager: ReturnType<typeof createMockDataSource>['mockManager'];
  mockQueryRunner: ReturnType<typeof createMockDataSource>['mockQueryRunner'];
} {
  const { mockDataSource, mockManager, mockQueryRunner } = createMockDataSource();
  const workOrder = new WorkOrder();
  Object.assign(workOrder, {
    id: 'wo-1',
    tenantId: TENANT,
    status: WorkOrderStatus.IN_PROGRESS,
    usedMaterials: [],
  });
  (mockManager.findOne as jest.Mock).mockResolvedValueOnce(workOrder);
  const service = new WorkOrderService(
    stub<Repository<WorkOrder>>({}),
    stub<Repository<MaintenanceSchedule>>({}),
    mockDataSource,
    stub<SparePartLedgerService>({ consumeForWorkOrder: consume }),
  );
  return { service, mockManager, mockQueryRunner };
}

const input: CompleteWorkOrderInput = {
  id: 'wo-1',
  usedMaterials: [
    { materialId: 'part-1', name: 'Seal', quantity: 2, unit: 'piece' },
    { name: 'Tape (free text)', quantity: 1, unit: 'roll' },
  ],
};

describe('WorkOrderService.complete — spare-part consumption', () => {
  it('hands only the spare-part materials to the ledger, in the completion transaction', async () => {
    // SCENARIO: one catalogued part + one free-text consumable. EXPECTS: one ledger call
    // with part-1 × 2, handed the work order itself (its asset decides the draw site, V-B1-9).
    const consume = jest.fn().mockResolvedValue(undefined);
    const { service, mockManager } = build(consume);

    await service.complete(TENANT, input, 'tech-1');

    expect(consume).toHaveBeenCalledWith(
      mockManager,
      TENANT,
      expect.objectContaining({ id: 'wo-1' }),
      [{ sparePartId: 'part-1', quantity: 2 }],
      'tech-1',
    );
    expect(mockManager.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: WorkOrderStatus.COMPLETED }),
    );
  });

  it('rolls the completion back when the ledger refuses the shortage', async () => {
    // SCENARIO: the shelf holds fewer seals than used. EXPECTS: 400 surfaces, work order not saved, tx rolled back.
    const consume = jest.fn().mockRejectedValue(new BadRequestException('Insufficient stock'));
    const { service, mockManager, mockQueryRunner } = build(consume);

    await expect(service.complete(TENANT, input, 'tech-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockManager.save).not.toHaveBeenCalled();
    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
  });
});
