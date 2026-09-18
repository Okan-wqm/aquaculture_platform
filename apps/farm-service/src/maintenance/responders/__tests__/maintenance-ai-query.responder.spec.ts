import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { MaintenanceAiQueryResponder } from '../maintenance-ai-query.responder';
import { ListOverdueWorkOrdersQuery } from '../../queries/list-overdue-work-orders.query';
import { GetWorkOrderStatisticsQuery } from '../../queries/get-work-order-statistics.query';
import { ListMaintenanceScheduleAlertsQuery } from '../../queries/list-maintenance-schedule-alerts.query';
import { ListLowStockAlertsQuery } from '../../queries/list-low-stock-alerts.query';
import { GetStockSummaryQuery } from '../../queries/get-stock-summary.query';
import { WorkOrder } from '../../entities/work-order.entity';
import { MaintenanceSchedule } from '../../entities/maintenance-schedule.entity';
import { SparePart } from '../../entities/spare-part.entity';
import { ScheduleAlert } from '../../services/maintenance-schedule.service';
import { WorkOrderStatistics } from '../../services/work-order.service';

const TENANT = '33333333-3333-4333-8333-333333333333';

function workOrder(id: string): WorkOrder {
  return {
    id,
    tenantId: TENANT,
    workOrderCode: 'WO-2026-00001',
    title: 'Replace feeder auger',
    description: 'desc',
    type: 'corrective' as WorkOrder['type'],
    status: 'in_progress' as WorkOrder['status'],
    priority: 'high' as WorkOrder['priority'],
    plannedStartDate: new Date('2026-09-10T00:00:00.000Z'),
    dueDate: new Date('2026-09-15T00:00:00.000Z'),
    actualStartTime: null,
    actualEndTime: null,
    actualDurationMinutes: null,
    assignedTo: 'assignee-user-id', // PII — must never cross the wire
    assignedTeamId: 'team-1',
    createdBy: 'creator-user-id', // PII — must never cross the wire
    approvedBy: 'approver-user-id', // PII — must never cross the wire
    checklist: [{ done: true }], // must never cross the wire
    usedMaterials: [{ partId: 'p1' }],
    laborRecords: [{ workerId: 'worker-user-id' }], // PII — must never cross the wire
    estimatedCost: 500,
    costSummary: { totalCost: 550 },
    isOverdue: () => true,
  } as unknown as WorkOrder;
}

const WO_STATS: WorkOrderStatistics = {
  total: 20,
  byStatus: { in_progress: 3 } as WorkOrderStatistics['byStatus'],
  byType: { corrective: 10 } as WorkOrderStatistics['byType'],
  byPriority: { high: 5 } as WorkOrderStatistics['byPriority'],
  overdue: 4,
  completedOnTime: 12,
  avgCompletionTime: 90,
  totalCost: 12000,
};

function scheduleAlert(): ScheduleAlert {
  return {
    schedule: {
      id: 'ms1',
      tenantId: TENANT,
      scheduleCode: 'MS-2026-00001',
      name: 'Monthly net inspection',
      description: 'desc',
      category: 'preventive' as MaintenanceSchedule['category'],
      status: 'active' as MaintenanceSchedule['status'],
      assetType: 'equipment' as MaintenanceSchedule['assetType'],
      assetId: 'eq1',
      assetName: 'Cage 1',
      nextDueDate: new Date('2026-09-20T00:00:00.000Z'),
      lastExecutedDate: new Date('2026-08-20T00:00:00.000Z'),
      estimatedDurationMinutes: 120,
      estimatedCost: 200,
      checklistTemplate: { items: [] },
      requiredMaterials: [{ materialId: 'm1' }],
      instructions: 'operator instructions',
      defaultAssigneeId: 'assignee-user-id', // PII — must never cross the wire
    } as unknown as MaintenanceSchedule,
    daysUntilDue: 2,
    alertType: 'upcoming',
  };
}

const LOW_STOCK = [
  {
    sparePart: {
      id: 'sp1',
      tenantId: TENANT,
      name: 'Auger bearing 6204',
      code: 'BRG-6204',
      partNumber: '6204-2RS',
      manufacturer: 'SKF',
      quantity: 2,
      minStock: 10,
      maxStock: 40,
      reorderPoint: 12,
      unit: 'piece',
      status: 'low_stock' as SparePart['status'],
      specifications: { material: 'steel' }, // must never cross the wire
      unitPrice: 45,
      currency: 'NOK',
      notes: 'operator note',
      createdBy: 'creator-user-id', // PII — must never cross the wire
    } as unknown as SparePart,
    currentQuantity: 2,
    minStock: 10,
    reorderPoint: 12,
    deficit: 10,
  },
];

const STOCK_SUMMARY = {
  totalParts: 120,
  totalValue: 45000,
  lowStockCount: 8,
  outOfStockCount: 3,
  byStatus: { in_stock: 100, low_stock: 8, out_of_stock: 3 } as Record<never, number>,
};

describe('MaintenanceAiQueryResponder (PR-5 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: MaintenanceAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new MaintenanceAiQueryResponder({ execute } as unknown as QueryBus);
  });

  // ------------------------------------------------------ MAINT_OVERDUE_WORK_ORDERS
  it('MAINT_OVERDUE_WORK_ORDERS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [{ tenantId: 'bad' }, { tenantId: TENANT, limit: 51 }]) {
      expect(await responder.overdueWorkOrders(bad)).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('MAINT_OVERDUE_WORK_ORDERS: happy path bounds the list and strips crew PII', async () => {
    execute.mockResolvedValue(Array.from({ length: 60 }, (_, i) => workOrder(`wo${i}`)));

    const reply = await responder.overdueWorkOrders({ tenantId: TENANT, limit: 50 });

    expect(execute).toHaveBeenCalledWith(expect.any(ListOverdueWorkOrdersQuery));
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(50);
      expect(reply.data.truncated).toBe(true);
      expect(reply.data.items[0]?.workOrderCode).toBe('WO-2026-00001');
      expect(reply.data.items[0]?.dueDate).toBe('2026-09-15T00:00:00.000Z');
      const serialized = JSON.stringify(reply.data);
      expect(serialized).not.toContain('assignedTo');
      expect(serialized).not.toContain('createdBy');
      expect(serialized).not.toContain('approvedBy');
      expect(serialized).not.toContain('checklist');
      expect(serialized).not.toContain('laborRecords');
    }
  });

  it('MAINT_OVERDUE_WORK_ORDERS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.overdueWorkOrders({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ------------------------------------------------------- MAINT_WORK_ORDER_STATS
  it('MAINT_WORK_ORDER_STATS: invalid payload (one-sided/bad range) → INVALID_REQUEST', async () => {
    for (const bad of [
      { tenantId: TENANT, fromDate: '2026-01-01' },
      { tenantId: TENANT, fromDate: '2026-01-01', toDate: '01-06-2026' },
    ]) {
      expect(await responder.workOrderStats(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('MAINT_WORK_ORDER_STATS: happy path passes dates through as Date', async () => {
    execute.mockResolvedValue(WO_STATS);

    const reply = await responder.workOrderStats({
      tenantId: TENANT,
      fromDate: '2026-01-01',
      toDate: '2026-06-30',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetWorkOrderStatisticsQuery));
    const query = execute.mock.calls[0][0] as GetWorkOrderStatisticsQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.dateFrom).toEqual(new Date('2026-01-01'));
    expect(query.dateTo).toEqual(new Date('2026-06-30'));

    expect(reply).toMatchObject({ ok: true, data: { total: 20, overdue: 4 } });
  });

  it('MAINT_WORK_ORDER_STATS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.workOrderStats({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // -------------------------------------------------------- MAINT_SCHEDULE_ALERTS
  it('MAINT_SCHEDULE_ALERTS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.scheduleAlerts({ tenantId: TENANT, limit: 0 })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('MAINT_SCHEDULE_ALERTS: happy path projects alerts and strips templates/assignees', async () => {
    execute.mockResolvedValue([scheduleAlert()]);

    const reply = await responder.scheduleAlerts({ tenantId: TENANT });

    expect(execute).toHaveBeenCalledWith(expect.any(ListMaintenanceScheduleAlertsQuery));
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items[0]?.daysUntilDue).toBe(2);
      expect(reply.data.items[0]?.nextDueDate).toBe('2026-09-20T00:00:00.000Z');
      const serialized = JSON.stringify(reply.data);
      expect(serialized).not.toContain('checklistTemplate');
      expect(serialized).not.toContain('defaultAssigneeId');
      expect(serialized).not.toContain('instructions');
    }
  });

  it('MAINT_SCHEDULE_ALERTS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.scheduleAlerts({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // --------------------------------------------------------------- MAINT_LOW_STOCK
  it('MAINT_LOW_STOCK: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.lowStock([TENANT])).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('MAINT_LOW_STOCK: happy path projects part + deficit and strips specs/notes', async () => {
    execute.mockResolvedValue(LOW_STOCK);

    const reply = await responder.lowStock({ tenantId: TENANT });

    expect(execute).toHaveBeenCalledWith(expect.any(ListLowStockAlertsQuery));
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items[0]?.deficit).toBe(10);
      expect(reply.data.items[0]?.quantity).toBe(2);
      const serialized = JSON.stringify(reply.data);
      expect(serialized).not.toContain('specifications');
      expect(serialized).not.toContain('operator note');
      expect(serialized).not.toContain('createdBy');
    }
  });

  it('MAINT_LOW_STOCK: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.lowStock({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ------------------------------------------------------------ MAINT_STOCK_SUMMARY
  it('MAINT_STOCK_SUMMARY: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.stockSummary({})).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('MAINT_STOCK_SUMMARY: happy path passes the counters through', async () => {
    execute.mockResolvedValue(STOCK_SUMMARY);

    const reply = await responder.stockSummary({ tenantId: TENANT });

    expect(execute).toHaveBeenCalledWith(expect.any(GetStockSummaryQuery));
    expect(reply).toMatchObject({
      ok: true,
      data: { totalParts: 120, lowStockCount: 8, outOfStockCount: 3 },
    });
  });

  it('MAINT_STOCK_SUMMARY: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.stockSummary({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });
});
