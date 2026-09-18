/**
 * Projection spec for the maintenance farm-AI responder (PR-5): PII deep
 * ban, ISO dates, cap/truncated.
 */
import {
  projectWorkOrder,
  projectWorkOrderStats,
  projectScheduleAlert,
  projectLowStockAlert,
  projectStockSummary,
} from '../projections';
import { WorkOrder } from '../../entities/work-order.entity';
import { MaintenanceSchedule } from '../../entities/maintenance-schedule.entity';
import { SparePart } from '../../entities/spare-part.entity';
import { ScheduleAlert } from '../../services/maintenance-schedule.service';
import { WorkOrderStatistics } from '../../services/work-order.service';

/** The PII ban list — none of these keys may appear anywhere in a reply. */
const BANNED_KEYS = [
  'reportedBy',
  'assignedTo',
  'assignedTeamId',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklist',
  'checklistTemplate',
  'laborRecords',
  'instructions',
  'defaultAssigneeId',
  'defaultTeamId',
  'requiredMaterials',
  'usedMaterials',
  'tenantId',
  'createdAt',
  'updatedAt',
];

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const WORK_ORDER = {
  id: 'wo1',
  tenantId: 't',
  workOrderCode: 'WO-2026-00001',
  title: 'Replace feeder auger',
  description: 'desc',
  type: 'corrective',
  status: 'in_progress',
  priority: 'high',
  plannedStartDate: new Date('2026-09-10T00:00:00.000Z'),
  dueDate: new Date('2026-09-15T00:00:00.000Z'),
  actualStartTime: new Date('2026-09-16T07:00:00.000Z'),
  actualEndTime: null,
  actualDurationMinutes: null,
  assignedTo: 'assignee-user-id',
  assignedTeamId: 'team-1',
  createdBy: 'creator-user-id',
  approvedBy: 'approver-user-id',
  checklist: [{ done: true }],
  usedMaterials: [{ partId: 'p1' }],
  laborRecords: [{ workerId: 'worker-user-id' }],
  estimatedCost: 500,
  costSummary: { totalCost: 550 },
} as unknown as WorkOrder;

const ALERT: ScheduleAlert = {
  schedule: {
    id: 'ms1',
    tenantId: 't',
    scheduleCode: 'MS-2026-00001',
    name: 'Monthly net inspection',
    description: 'desc',
    category: 'preventive',
    status: 'active',
    assetType: 'equipment',
    assetId: 'eq1',
    assetName: 'Cage 1',
    nextDueDate: new Date('2026-09-20T00:00:00.000Z'),
    lastExecutedDate: new Date('2026-08-20T00:00:00.000Z'),
    estimatedDurationMinutes: 120,
    estimatedCost: 200,
    checklistTemplate: { items: [] },
    requiredMaterials: [{ materialId: 'm1' }],
    instructions: 'operator instructions',
    defaultAssigneeId: 'assignee-user-id',
    defaultTeamId: 'team-1',
  } as unknown as MaintenanceSchedule,
  daysUntilDue: 2,
  alertType: 'upcoming',
};

const LOW_STOCK = {
  sparePart: {
    id: 'sp1',
    tenantId: 't',
    name: 'Auger bearing 6204',
    code: 'BRG-6204',
    partNumber: '6204-2RS',
    manufacturer: 'SKF',
    quantity: 2,
    minStock: 10,
    reorderPoint: 12,
    unit: 'piece',
    status: 'low_stock',
    location: { warehouse: 'A' },
    specifications: { material: 'steel' },
    unitPrice: 45,
    currency: 'NOK',
    notes: 'operator note',
    createdBy: 'creator-user-id',
  } as unknown as SparePart,
  currentQuantity: 2,
  minStock: 10,
  reorderPoint: 12,
  deficit: 10,
};

describe('maintenance farm-AI projections (PR-5 read-only namespace)', () => {
  it('strips crew PII, checklists, labor and materials — deep key scan', () => {
    const projections = [
      projectWorkOrder(WORK_ORDER),
      projectWorkOrderStats({
        total: 1,
        byStatus: {} as WorkOrderStatistics['byStatus'],
        byType: {} as WorkOrderStatistics['byType'],
        byPriority: {} as WorkOrderStatistics['byPriority'],
        overdue: 1,
        completedOnTime: 0,
        avgCompletionTime: 0,
        totalCost: 0,
      }),
      projectScheduleAlert(ALERT),
      projectLowStockAlert(LOW_STOCK),
      projectStockSummary({
        totalParts: 1,
        totalValue: 1,
        lowStockCount: 1,
        outOfStockCount: 0,
        byStatus: {} as Parameters<typeof projectStockSummary>[0]['byStatus'],
      }),
    ];
    for (const projection of projections) {
      const keys = collectKeys(projection);
      for (const banned of BANNED_KEYS) {
        expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
      }
      expect(keys.has('location')).toBe(false);
    }
  });

  it('serializes every date as an ISO string (or null)', () => {
    const workOrder = projectWorkOrder(WORK_ORDER);
    expect(workOrder.plannedStartDate).toBe('2026-09-10T00:00:00.000Z');
    expect(workOrder.dueDate).toBe('2026-09-15T00:00:00.000Z');
    expect(workOrder.actualStartTime).toBe('2026-09-16T07:00:00.000Z');
    expect(workOrder.actualEndTime).toBeNull();

    const alert = projectScheduleAlert(ALERT);
    expect(alert.nextDueDate).toBe('2026-09-20T00:00:00.000Z');
    expect(alert.lastExecutedDate).toBe('2026-08-20T00:00:00.000Z');
  });

  it('keeps operational numbers and cost totals', () => {
    const workOrder = projectWorkOrder(WORK_ORDER);
    expect(workOrder.totalCost).toBe(550);
    expect(workOrder.estimatedCost).toBe(500);

    const lowStock = projectLowStockAlert(LOW_STOCK);
    expect(lowStock.deficit).toBe(10);
    expect(lowStock.unitPrice).toBe(45);

    const alert = projectScheduleAlert(ALERT);
    expect(alert.daysUntilDue).toBe(2);
    expect(alert.estimatedDurationMinutes).toBe(120);
  });
});
