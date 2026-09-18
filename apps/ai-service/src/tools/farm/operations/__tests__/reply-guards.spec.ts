/**
 * Reply-guard spec for the PR-5 Operations specialist tools: each guard
 * accepts its projected shape and rejects near-misses.
 */
import {
  isEquipment,
  isFeederCalibration,
  isWorkOrder,
  isWorkOrderStats,
  isScheduleAlert,
  isLowStock,
  isStockSummary,
  isStockContainer,
  isTask,
  isTaskStats,
  isAiListOf,
} from '../reply-guards';

describe('operations reply-guards (PR-5)', () => {
  it('equipment + calibration guards', () => {
    expect(
      isEquipment({
        id: 'eq1',
        name: 'Feeder 1',
        code: 'FEED-001',
        equipmentTypeId: 'et1',
        status: 'operational',
        isTank: false,
      }),
    ).toBe(true);
    expect(
      isEquipment({ id: 'eq1', name: 'F', code: 'C', equipmentTypeId: 'et1', status: 'x', isTank: 'no' }),
    ).toBe(false);
    expect(
      isFeederCalibration({
        id: 'fc1',
        feedSizeMm: 3,
        gramsPerDispensing: 12.5,
        siloCapacityKg: 500,
      }),
    ).toBe(true);
    expect(isFeederCalibration({ id: 'fc1', feedSizeMm: '3' })).toBe(false);
  });

  it('work order + stats guards', () => {
    const workOrder = {
      id: 'wo1',
      workOrderCode: 'WO-1',
      title: 'Fix feeder',
      type: 'corrective',
      status: 'in_progress',
      priority: 'high',
      dueDate: '2026-09-15T00:00:00.000Z',
    };
    expect(isWorkOrder(workOrder)).toBe(true);
    expect(isWorkOrder({ ...workOrder, dueDate: null })).toBe(true);
    expect(isWorkOrder({ ...workOrder, priority: 3 })).toBe(false);
    expect(
      isWorkOrderStats({
        total: 20,
        overdue: 4,
        completedOnTime: 12,
        avgCompletionTime: 90,
        totalCost: 12000,
        byStatus: {},
        byType: {},
        byPriority: {},
      }),
    ).toBe(true);
    expect(isWorkOrderStats({ total: 20, overdue: 4 })).toBe(false);
  });

  it('schedule alert + low stock + stock summary guards', () => {
    expect(
      isScheduleAlert({
        scheduleId: 'ms1',
        scheduleCode: 'MS-1',
        name: 'Nets',
        category: 'preventive',
        daysUntilDue: 2,
        alertType: 'upcoming',
        nextDueDate: null,
      }),
    ).toBe(true);
    expect(
      isLowStock({
        id: 'sp1',
        name: 'Bearing',
        code: 'BRG',
        quantity: 2,
        minStock: 10,
        reorderPoint: 12,
        deficit: 10,
        unit: 'piece',
      }),
    ).toBe(true);
    expect(
      isStockSummary({
        totalParts: 120,
        totalValue: 45000,
        lowStockCount: 8,
        outOfStockCount: 3,
        byStatus: {},
      }),
    ).toBe(true);
  });

  it('farm-stock container guard accepts nullable stock numbers', () => {
    expect(
      isStockContainer({
        containerId: 't1',
        name: 'Havuz 1',
        code: 'TNK-001',
        currentQuantity: null,
        currentBiomassKg: null,
        capacityUsedPercent: null,
        isOverCapacity: false,
        hasActiveBatch: false,
      }),
    ).toBe(true);
    expect(
      isStockContainer({ containerId: 't1', name: 'H', code: 'C', isOverCapacity: false }),
    ).toBe(false);
  });

  it('task + task stats guards', () => {
    const task = {
      id: 'task1',
      title: 'Check DO sensor',
      category: 'WATER_QUALITY',
      priority: 'HIGH',
      status: 'PENDING',
      dueDate: '2026-09-18T00:00:00.000Z',
      dueTime: null,
    };
    expect(isTask(task)).toBe(true);
    expect(isTask({ ...task, dueTime: '08:30:00' })).toBe(true);
    expect(isTask({ ...task, status: 4 })).toBe(false);
    expect(
      isTaskStats({
        totalToday: 12,
        completedToday: 5,
        overdueCount: 3,
        upcomingCount: 20,
        completionRate: 72,
        avgCompletionMinutes: 41,
      }),
    ).toBe(true);
    expect(isTaskStats({ totalToday: 12 })).toBe(false);
  });

  it('isAiListOf rejects bare arrays and mixed items', () => {
    const isList = isAiListOf(isTask);
    expect(isList({ items: [], truncated: false, total: 0 })).toBe(true);
    expect(isList([])).toBe(false);
    expect(isList({ items: [{ id: 'x' }], truncated: false })).toBe(false);
  });
});
