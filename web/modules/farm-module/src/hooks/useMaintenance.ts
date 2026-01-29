/**
 * Maintenance hooks for farm-module
 * Handles CRUD operations for work orders, maintenance schedules, and spare parts via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';

// ============================================================================
// TYPES - Work Orders
// ============================================================================

export type WorkOrderType =
  | 'PREVENTIVE'
  | 'CORRECTIVE'
  | 'EMERGENCY'
  | 'INSPECTION'
  | 'CALIBRATION'
  | 'CLEANING'
  | 'INSTALLATION'
  | 'UPGRADE'
  | 'ROUTINE';

export type WorkOrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'COMPLETED'
  | 'VERIFIED'
  | 'CANCELLED';

export type WorkOrderPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type AssetType =
  | 'TANK'
  | 'POND'
  | 'EQUIPMENT'
  | 'BUILDING'
  | 'VEHICLE'
  | 'SENSOR'
  | 'PUMP'
  | 'FEEDER'
  | 'AERATOR'
  | 'GENERATOR'
  | 'OTHER';

export interface ChecklistItem {
  id: string;
  description: string;
  isCompleted: boolean;
  completedAt?: string;
  completedBy?: string;
  notes?: string;
  isRequired: boolean;
}

export interface UsedMaterial {
  materialId?: string;
  name: string;
  quantity: number;
  unit: string;
  unitCost?: number;
  totalCost?: number;
  batchNumber?: string;
}

export interface LaborRecord {
  userId: string;
  userName?: string;
  startTime: string;
  endTime?: string;
  durationMinutes?: number;
  hourlyRate?: number;
  totalCost?: number;
  notes?: string;
}

export interface CostSummary {
  laborCost: number;
  materialCost: number;
  externalServiceCost: number;
  otherCosts: number;
  totalCost: number;
  currency: string;
}

export interface RelatedAsset {
  assetType: AssetType;
  assetId: string;
  assetCode?: string;
  assetName?: string;
}

export interface WorkOrder {
  id: string;
  tenantId: string;
  workOrderCode: string;
  title: string;
  description?: string;
  type: WorkOrderType;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  assetType?: AssetType;
  assetId?: string;
  relatedAsset?: RelatedAsset;
  plannedStartDate?: string;
  dueDate?: string;
  estimatedDurationMinutes?: number;
  actualStartTime?: string;
  actualEndTime?: string;
  actualDurationMinutes?: number;
  assignedTo?: string;
  assignedTeamId?: string;
  createdBy: string;
  approvedBy?: string;
  approvedAt?: string;
  checklist?: ChecklistItem[];
  checklistProgress?: number;
  usedMaterials?: UsedMaterial[];
  laborRecords?: LaborRecord[];
  estimatedCost?: number;
  costSummary?: CostSummary;
  currency?: string;
  maintenanceScheduleId?: string;
  isRecurring: boolean;
  completionNotes?: string;
  completedBy?: string;
  completedAt?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  notes?: string;
  attachments?: string[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// TYPES - Maintenance Schedules
// ============================================================================

export type MaintenanceScheduleStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'EXPIRED';

export type RecurrenceType =
  | 'DAILY'
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUALLY'
  | 'ANNUALLY'
  | 'CUSTOM'
  | 'METER_BASED';

export type MaintenanceCategory =
  | 'MECHANICAL'
  | 'ELECTRICAL'
  | 'PLUMBING'
  | 'CLEANING'
  | 'LUBRICATION'
  | 'INSPECTION'
  | 'CALIBRATION'
  | 'FILTER_CHANGE'
  | 'SAFETY'
  | 'GENERAL';

export interface RecurrenceRule {
  type: RecurrenceType;
  interval?: number;
  daysOfWeek?: number[];
  dayOfMonth?: number;
  monthsOfYear?: number[];
  endDate?: string;
  maxOccurrences?: number;
  meterType?: 'hours' | 'cycles' | 'km';
  meterInterval?: number;
}

export interface AlertSettings {
  daysBeforeDue: number;
  notifyAssignee: boolean;
  notifyManager: boolean;
  emailNotification: boolean;
  smsNotification: boolean;
}

export interface ScheduleMetrics {
  totalExecutions: number;
  completedOnTime: number;
  completedLate: number;
  missed: number;
  avgCompletionTime?: number;
  avgCost?: number;
  complianceRate: number;
  lastExecutionDate?: string;
  nextDueDate?: string;
}

export interface MaintenanceSchedule {
  id: string;
  tenantId: string;
  scheduleCode: string;
  name: string;
  description?: string;
  category: MaintenanceCategory;
  status: MaintenanceScheduleStatus;
  assetType?: AssetType;
  assetId?: string;
  assetName?: string;
  recurrenceRule: RecurrenceRule;
  startDate: string;
  endDate?: string;
  nextDueDate?: string;
  lastExecutedDate?: string;
  currentMeterReading?: number;
  lastMaintenanceMeterReading?: number;
  nextMaintenanceMeterReading?: number;
  estimatedDurationMinutes?: number;
  estimatedCost?: number;
  currency?: string;
  checklistTemplate?: { items: ChecklistItem[] };
  requiredMaterials?: { materialId?: string; name: string; quantity: number; unit: string; estimatedCost?: number }[];
  instructions?: string;
  defaultAssigneeId?: string;
  defaultTeamId?: string;
  alertSettings?: AlertSettings;
  metrics?: ScheduleMetrics;
  executionCount: number;
  autoGenerateWorkOrder: boolean;
  generateDaysBefore: number;
  notes?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// TYPES - Spare Parts
// ============================================================================

export type SparePartStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'ON_ORDER' | 'DISCONTINUED';

export interface StorageLocation {
  warehouse?: string;
  shelf?: string;
  bin?: string;
  notes?: string;
}

export interface SparePart {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  partNumber: string;
  description?: string;
  equipmentTypeId?: string;
  compatibleEquipmentTypes?: string[];
  supplierId?: string;
  manufacturer?: string;
  quantity: number;
  minStock: number;
  maxStock: number;
  reorderPoint: number;
  unit: string;
  status: SparePartStatus;
  location?: StorageLocation;
  unitPrice?: number;
  currency: string;
  specifications?: Record<string, unknown>;
  leadTimeDays?: number;
  lastOrderDate?: string;
  lastUsedDate?: string;
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  version: number;
}

// ============================================================================
// INPUT TYPES
// ============================================================================

export interface CreateWorkOrderInput {
  title: string;
  description?: string;
  type: WorkOrderType;
  priority: WorkOrderPriority;
  relatedAsset?: {
    assetType: AssetType;
    assetId: string;
    assetCode?: string;
    assetName?: string;
  };
  plannedStartDate?: string;
  dueDate?: string;
  estimatedDurationMinutes?: number;
  assignedTo?: string;
  assignedTeamId?: string;
  checklist?: { description: string; isRequired?: boolean }[];
  requiredMaterials?: { sparePartId?: string; name: string; quantity: number; unit: string; estimatedCost?: number }[];
  estimatedCost?: number;
  currency?: string;
  maintenanceScheduleId?: string;
  instructions?: string;
  notes?: string;
  attachments?: string[];
}

export interface UpdateWorkOrderInput {
  id: string;
  title?: string;
  description?: string;
  type?: WorkOrderType;
  status?: WorkOrderStatus;
  priority?: WorkOrderPriority;
  relatedAsset?: {
    assetType: AssetType;
    assetId: string;
    assetCode?: string;
    assetName?: string;
  };
  plannedStartDate?: string;
  dueDate?: string;
  estimatedDurationMinutes?: number;
  assignedTo?: string;
  assignedTeamId?: string;
  checklist?: { description: string; isRequired?: boolean }[];
  checklistUpdates?: { id: string; isCompleted?: boolean; notes?: string }[];
  usedMaterials?: UsedMaterial[];
  laborRecords?: LaborRecord[];
  estimatedCost?: number;
  currency?: string;
  notes?: string;
  attachments?: string[];
}

export interface CompleteWorkOrderInput {
  id: string;
  completionNotes?: string;
  usedMaterials?: UsedMaterial[];
  laborRecords?: LaborRecord[];
}

export interface WorkOrderFilter {
  status?: WorkOrderStatus[];
  type?: WorkOrderType[];
  priority?: WorkOrderPriority[];
  assetType?: AssetType;
  assetId?: string;
  assignedTo?: string;
  assignedTeamId?: string;
  maintenanceScheduleId?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  createdFrom?: string;
  createdTo?: string;
  isOverdue?: boolean;
  isRecurring?: boolean;
  searchTerm?: string;
}

export interface MaintenanceScheduleFilter {
  status?: MaintenanceScheduleStatus[];
  category?: MaintenanceCategory[];
  recurrenceType?: RecurrenceType[];
  assetType?: AssetType;
  assetId?: string;
  defaultAssigneeId?: string;
  defaultTeamId?: string;
  nextDueDateFrom?: string;
  nextDueDateTo?: string;
  isOverdue?: boolean;
  autoGenerateWorkOrder?: boolean;
  searchTerm?: string;
}

export interface SparePartFilter {
  status?: SparePartStatus[];
  equipmentTypeId?: string;
  supplierId?: string;
  manufacturer?: string;
  isActive?: boolean;
  isLowStock?: boolean;
  isOutOfStock?: boolean;
  searchTerm?: string;
}

// ============================================================================
// GRAPHQL QUERIES
// ============================================================================

const WORK_ORDER_FIELDS = `
  id
  workOrderCode
  title
  description
  type
  status
  priority
  assetType
  assetId
  relatedAsset
  plannedStartDate
  dueDate
  estimatedDurationMinutes
  actualStartTime
  actualEndTime
  actualDurationMinutes
  assignedTo
  assignedTeamId
  createdBy
  approvedBy
  approvedAt
  checklist
  checklistProgress
  usedMaterials
  laborRecords
  estimatedCost
  costSummary
  currency
  maintenanceScheduleId
  isRecurring
  completionNotes
  completedBy
  completedAt
  verifiedBy
  verifiedAt
  notes
  attachments
  createdAt
  updatedAt
`;

const MAINTENANCE_SCHEDULE_FIELDS = `
  id
  scheduleCode
  name
  description
  category
  status
  assetType
  assetId
  assetName
  recurrenceRule
  startDate
  endDate
  nextDueDate
  lastExecutedDate
  currentMeterReading
  lastMaintenanceMeterReading
  nextMaintenanceMeterReading
  estimatedDurationMinutes
  estimatedCost
  currency
  checklistTemplate
  requiredMaterials
  instructions
  defaultAssigneeId
  defaultTeamId
  alertSettings
  metrics
  executionCount
  autoGenerateWorkOrder
  generateDaysBefore
  notes
  createdBy
  createdAt
  updatedAt
`;

const SPARE_PART_FIELDS = `
  id
  code
  name
  partNumber
  description
  equipmentTypeId
  compatibleEquipmentTypes
  supplierId
  manufacturer
  quantity
  minStock
  maxStock
  reorderPoint
  unit
  status
  location
  unitPrice
  currency
  specifications
  leadTimeDays
  lastOrderDate
  lastUsedDate
  notes
  isActive
  createdAt
  updatedAt
  createdBy
  updatedBy
  version
`;

// ============================================================================
// HOOKS - Work Orders
// ============================================================================

export function useWorkOrders(filter?: WorkOrderFilter, page = 1, limit = 20) {
  return useQuery({
    queryKey: ['workOrders', filter, page, limit],
    queryFn: async () => {
      const query = `
        query WorkOrders($filter: WorkOrderFilterInput, $page: Int, $limit: Int) {
          workOrders(filter: $filter, page: $page, limit: $limit) {
            items {
              ${WORK_ORDER_FIELDS}
            }
            total
            page
            limit
            totalPages
            hasNextPage
            hasPreviousPage
          }
        }
      `;

      const result = await graphqlClient.request<{
        workOrders: {
          items: WorkOrder[];
          total: number;
          page: number;
          limit: number;
          totalPages: number;
          hasNextPage: boolean;
          hasPreviousPage: boolean;
        };
      }>(query, { filter, page, limit });

      return result.workOrders;
    },
  });
}

export function useWorkOrder(id: string) {
  return useQuery({
    queryKey: ['workOrder', id],
    queryFn: async () => {
      const query = `
        query WorkOrder($id: ID!) {
          workOrder(id: $id) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ workOrder: WorkOrder }>(
        query,
        { id }
      );

      return result.workOrder;
    },
    enabled: !!id,
  });
}

export function useWorkOrderStatistics(dateFrom?: string, dateTo?: string) {
  return useQuery({
    queryKey: ['workOrderStatistics', dateFrom, dateTo],
    queryFn: async () => {
      const query = `
        query WorkOrderStatistics($dateFrom: DateTime, $dateTo: DateTime) {
          workOrderStatistics(dateFrom: $dateFrom, dateTo: $dateTo) {
            total
            overdue
            completedOnTime
            avgCompletionTime
            totalCost
            draft
            pendingApproval
            approved
            scheduled
            inProgress
            onHold
            completed
            verified
            cancelled
          }
        }
      `;

      const result = await graphqlClient.request<{
        workOrderStatistics: {
          total: number;
          overdue: number;
          completedOnTime: number;
          avgCompletionTime: number;
          totalCost: number;
          draft: number;
          pendingApproval: number;
          approved: number;
          scheduled: number;
          inProgress: number;
          onHold: number;
          completed: number;
          verified: number;
          cancelled: number;
        };
      }>(query, { dateFrom, dateTo });

      return result.workOrderStatistics;
    },
  });
}

export function useCreateWorkOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateWorkOrderInput) => {
      const mutation = `
        mutation CreateWorkOrder($input: CreateWorkOrderInput!) {
          createWorkOrder(input: $input) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ createWorkOrder: WorkOrder }>(
        mutation,
        { input }
      );

      return result.createWorkOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workOrders'] });
      queryClient.invalidateQueries({ queryKey: ['workOrderStatistics'] });
    },
  });
}

export function useUpdateWorkOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateWorkOrderInput) => {
      const mutation = `
        mutation UpdateWorkOrder($input: UpdateWorkOrderInput!) {
          updateWorkOrder(input: $input) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ updateWorkOrder: WorkOrder }>(
        mutation,
        { input }
      );

      return result.updateWorkOrder;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['workOrders'] });
      queryClient.invalidateQueries({ queryKey: ['workOrder', data.id] });
      queryClient.invalidateQueries({ queryKey: ['workOrderStatistics'] });
    },
  });
}

export function useCompleteWorkOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CompleteWorkOrderInput) => {
      const mutation = `
        mutation CompleteWorkOrder($input: CompleteWorkOrderInput!) {
          completeWorkOrder(input: $input) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ completeWorkOrder: WorkOrder }>(
        mutation,
        { input }
      );

      return result.completeWorkOrder;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['workOrders'] });
      queryClient.invalidateQueries({ queryKey: ['workOrder', data.id] });
      queryClient.invalidateQueries({ queryKey: ['workOrderStatistics'] });
    },
  });
}

export function useDeleteWorkOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation DeleteWorkOrder($id: ID!) {
          deleteWorkOrder(id: $id) {
            success
            id
            message
          }
        }
      `;

      const result = await graphqlClient.request<{
        deleteWorkOrder: { success: boolean; id: string; message?: string };
      }>(mutation, { id });

      return result.deleteWorkOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workOrders'] });
      queryClient.invalidateQueries({ queryKey: ['workOrderStatistics'] });
    },
  });
}

// ============================================================================
// HOOKS - Maintenance Schedules
// ============================================================================

export function useMaintenanceSchedules(filter?: MaintenanceScheduleFilter, page = 1, limit = 20) {
  return useQuery({
    queryKey: ['maintenanceSchedules', filter, page, limit],
    queryFn: async () => {
      const query = `
        query MaintenanceSchedules($filter: MaintenanceScheduleFilterInput, $page: Int, $limit: Int) {
          maintenanceSchedules(filter: $filter, page: $page, limit: $limit) {
            items {
              ${MAINTENANCE_SCHEDULE_FIELDS}
            }
            total
            page
            limit
            totalPages
            hasNextPage
            hasPreviousPage
          }
        }
      `;

      const result = await graphqlClient.request<{
        maintenanceSchedules: {
          items: MaintenanceSchedule[];
          total: number;
          page: number;
          limit: number;
          totalPages: number;
          hasNextPage: boolean;
          hasPreviousPage: boolean;
        };
      }>(query, { filter, page, limit });

      return result.maintenanceSchedules;
    },
  });
}

export function useMaintenanceSchedule(id: string) {
  return useQuery({
    queryKey: ['maintenanceSchedule', id],
    queryFn: async () => {
      const query = `
        query MaintenanceSchedule($id: ID!) {
          maintenanceSchedule(id: $id) {
            ${MAINTENANCE_SCHEDULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ maintenanceSchedule: MaintenanceSchedule }>(
        query,
        { id }
      );

      return result.maintenanceSchedule;
    },
    enabled: !!id,
  });
}

export function useUpcomingMaintenanceSchedules(days = 7) {
  return useQuery({
    queryKey: ['upcomingMaintenanceSchedules', days],
    queryFn: async () => {
      const query = `
        query UpcomingMaintenanceSchedules($days: Int) {
          upcomingMaintenanceSchedules(days: $days) {
            ${MAINTENANCE_SCHEDULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{
        upcomingMaintenanceSchedules: MaintenanceSchedule[];
      }>(query, { days });

      return result.upcomingMaintenanceSchedules;
    },
  });
}

export function useMaintenanceAlerts() {
  return useQuery({
    queryKey: ['maintenanceAlerts'],
    queryFn: async () => {
      const query = `
        query MaintenanceAlerts {
          maintenanceAlerts {
            schedule {
              ${MAINTENANCE_SCHEDULE_FIELDS}
            }
            daysUntilDue
            alertType
          }
        }
      `;

      const result = await graphqlClient.request<{
        maintenanceAlerts: {
          schedule: MaintenanceSchedule;
          daysUntilDue: number;
          alertType: string;
        }[];
      }>(query, {});

      return result.maintenanceAlerts;
    },
  });
}

// ============================================================================
// HOOKS - Spare Parts
// ============================================================================

export function useSpareParts(filter?: SparePartFilter, page = 1, limit = 20) {
  return useQuery({
    queryKey: ['spareParts', filter, page, limit],
    queryFn: async () => {
      const query = `
        query SpareParts($filter: SparePartFilterInput, $page: Int, $limit: Int) {
          spareParts(filter: $filter, page: $page, limit: $limit) {
            items {
              ${SPARE_PART_FIELDS}
            }
            total
            page
            limit
            totalPages
            hasNextPage
            hasPreviousPage
          }
        }
      `;

      const result = await graphqlClient.request<{
        spareParts: {
          items: SparePart[];
          total: number;
          page: number;
          limit: number;
          totalPages: number;
          hasNextPage: boolean;
          hasPreviousPage: boolean;
        };
      }>(query, { filter, page, limit });

      return result.spareParts;
    },
  });
}

export function useSparePart(id: string) {
  return useQuery({
    queryKey: ['sparePart', id],
    queryFn: async () => {
      const query = `
        query SparePart($id: ID!) {
          sparePart(id: $id) {
            ${SPARE_PART_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ sparePart: SparePart }>(
        query,
        { id }
      );

      return result.sparePart;
    },
    enabled: !!id,
  });
}

export function useLowStockAlerts() {
  return useQuery({
    queryKey: ['lowStockAlerts'],
    queryFn: async () => {
      const query = `
        query LowStockAlerts {
          lowStockAlerts {
            sparePart {
              ${SPARE_PART_FIELDS}
            }
            currentQuantity
            minStock
            reorderPoint
            deficit
          }
        }
      `;

      const result = await graphqlClient.request<{
        lowStockAlerts: {
          sparePart: SparePart;
          currentQuantity: number;
          minStock: number;
          reorderPoint: number;
          deficit: number;
        }[];
      }>(query, {});

      return result.lowStockAlerts;
    },
  });
}

export function useStockSummary() {
  return useQuery({
    queryKey: ['stockSummary'],
    queryFn: async () => {
      const query = `
        query StockSummary {
          stockSummary {
            totalParts
            totalValue
            lowStockCount
            outOfStockCount
            inStockCount
            onOrderCount
            discontinuedCount
          }
        }
      `;

      const result = await graphqlClient.request<{
        stockSummary: {
          totalParts: number;
          totalValue: number;
          lowStockCount: number;
          outOfStockCount: number;
          inStockCount: number;
          onOrderCount: number;
          discontinuedCount: number;
        };
      }>(query, {});

      return result.stockSummary;
    },
  });
}

export function useRecordStockMovement() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      sparePartId: string;
      quantity: number;
      movementType: 'in' | 'out' | 'adjustment';
      reason?: string;
      workOrderId?: string;
      notes?: string;
    }) => {
      const mutation = `
        mutation RecordStockMovement($input: StockMovementInput!) {
          recordStockMovement(input: $input) {
            ${SPARE_PART_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ recordStockMovement: SparePart }>(
        mutation,
        { input }
      );

      return result.recordStockMovement;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['spareParts'] });
      queryClient.invalidateQueries({ queryKey: ['sparePart', data.id] });
      queryClient.invalidateQueries({ queryKey: ['lowStockAlerts'] });
      queryClient.invalidateQueries({ queryKey: ['stockSummary'] });
    },
  });
}
