import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { GetWorkOrderStatisticsQuery } from '../../queries/get-work-order-statistics.query';
import { ListLowStockAlertsQuery } from '../../queries/list-low-stock-alerts.query';
import { ListMaintenanceScheduleAlertsQuery } from '../../queries/list-maintenance-schedule-alerts.query';
import { ListOverdueWorkOrdersQuery } from '../../queries/list-overdue-work-orders.query';
import { MaintenanceAiQueryResponder } from '../maintenance-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

describe('MaintenanceAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: MaintenanceAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new MaintenanceAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('overdue work orders: projects asset and dates, strips assignee / checklist / materials / notes', async () => {
    execute.mockResolvedValue([
      {
        id: ID,
        workOrderCode: 'WO-2026-0007',
        title: 'Replace aerator belt',
        type: 'corrective',
        status: 'in_progress',
        priority: 'high',
        assetType: 'equipment',
        relatedAsset: {
          assetType: 'equipment',
          assetId: ID,
          assetCode: 'AER-3',
          assetName: 'Aerator 3',
        },
        plannedStartDate: new Date('2026-09-10T00:00:00Z'),
        dueDate: new Date('2026-09-15T00:00:00Z'),
        estimatedDurationMinutes: 90,
        assignedTo: 'user-12',
        createdBy: 'user-1',
        checklist: [{ id: 'c', title: 'secret step' }],
        usedMaterials: [{ materialId: 'm', userName: 'Someone' }],
        notes: 'private',
        isRecurring: false,
      },
    ]);

    const reply = await responder.listOverdueWorkOrders({ tenantId: TENANT, limit: 10 });

    expect(execute).toHaveBeenCalledWith(expect.any(ListOverdueWorkOrdersQuery));
    expect(reply).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            workOrderCode: 'WO-2026-0007',
            assetCode: 'AER-3',
            assetName: 'Aerator 3',
            dueDate: '2026-09-15T00:00:00.000Z',
            estimatedDurationMinutes: 90,
          },
        ],
      },
    });
    for (const secret of ['user-12', 'user-1', 'secret step', 'Someone', 'private']) {
      expect(JSON.stringify(reply)).not.toContain(secret);
    }
  });

  it('work order stats: dispatches Date bounds and projects minutes / cost as numbers', async () => {
    execute.mockResolvedValue({
      total: 12,
      byStatus: { open: 4, completed: 8 },
      byType: { preventive: 10, corrective: 2 },
      byPriority: { high: 2 },
      overdue: 1,
      completedOnTime: 7,
      avgCompletionTime: '95.5',
      totalCost: '1200',
    });
    const reply = await responder.getWorkOrderStats({
      tenantId: TENANT,
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
    });
    expect(execute).toHaveBeenCalledWith(expect.any(GetWorkOrderStatisticsQuery));
    const query = execute.mock.calls[0][0] as GetWorkOrderStatisticsQuery;
    expect(query.dateFrom).toEqual(new Date('2026-08-01'));
    expect(reply).toMatchObject({
      ok: true,
      data: { total: 12, avgCompletionMinutes: 95.5, totalCost: 1200, overdue: 1 },
    });
  });

  it('maintenance alerts: flattens the schedule into code/name/asset/due', async () => {
    execute.mockResolvedValue([
      {
        schedule: {
          id: ID,
          scheduleCode: 'MS-1',
          name: 'Pump service',
          category: 'preventive',
          assetType: 'equipment',
          assetName: 'Pump 1',
          nextDueDate: new Date('2026-09-18T00:00:00Z'),
          checklistTemplate: { items: ['x'] },
        },
        daysUntilDue: 0,
        alertType: 'due_today',
      },
    ]);
    const reply = await responder.listMaintenanceAlerts({ tenantId: TENANT, limit: 10 });
    expect(execute).toHaveBeenCalledWith(expect.any(ListMaintenanceScheduleAlertsQuery));
    expect(reply).toEqual({
      ok: true,
      data: {
        items: [
          {
            scheduleId: ID,
            scheduleCode: 'MS-1',
            name: 'Pump service',
            category: 'preventive',
            assetType: 'equipment',
            assetName: 'Pump 1',
            nextDueDate: '2026-09-18T00:00:00.000Z',
            daysUntilDue: 0,
            alertType: 'due_today',
          },
        ],
        truncated: false,
      },
    });
  });

  it('low stock: projects the part identity and quantities, never price or location', async () => {
    execute.mockResolvedValue([
      {
        sparePart: {
          id: ID,
          code: 'SP-9',
          name: 'Belt',
          partNumber: 'B-77',
          unit: 'piece',
          leadTimeDays: 5,
          unitPrice: 12.5,
          location: { warehouse: 'W1' },
        },
        currentQuantity: 1,
        minStock: 3,
        reorderPoint: 4,
        deficit: 3,
      },
    ]);
    const reply = await responder.listLowStock({ tenantId: TENANT, limit: 10 });
    expect(execute).toHaveBeenCalledWith(expect.any(ListLowStockAlertsQuery));
    expect(reply).toMatchObject({
      ok: true,
      data: { items: [{ code: 'SP-9', partNumber: 'B-77', deficit: 3, leadTimeDays: 5 }] },
    });
    expect(JSON.stringify(reply)).not.toContain('12.5');
    expect(JSON.stringify(reply)).not.toContain('W1');
  });

  it('rejects a payload with unknown keys', async () => {
    const reply = await responder.getStockSummary({ tenantId: TENANT, warehouse: 'W1' });
    expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });
});
