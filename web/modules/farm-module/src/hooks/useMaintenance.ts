/**
 * Maintenance hooks for farm-module
 * Handles CRUD operations for work orders, maintenance schedules, and spare parts via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  createTenantQueryKey,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import type { PaginationResultV1 } from '@platform/pagination-contracts';

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
  /** @deprecated Float — use `estimatedCostDecimal` (exact decimal string, ADR-0004). */
  estimatedCost?: number;
  estimatedCostDecimal?: string | null;
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

/**
 * DERIVED on the backend from ledger on-hand, open orders and `isActive`
 * (FARM-HIGH-338) — read-only on the web; no input type carries it.
 */
export type SparePartStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'ON_ORDER' | 'DISCONTINUED';

/**
 * Free-text shelf/bin detail INSIDE the part's storage location.
 *
 * WHY renamed from `StorageLocation` (FARM-HIGH-338): the old name shadowed the
 * storage module's real `StorageLocation` (useStorageLocations.ts) and read as
 * if this blob placed the part somewhere. It never did — the physical place is
 * `SparePart.storageLocationId`; this is operator text only.
 */
export interface SparePartBinDetail {
  warehouse?: string;
  shelf?: string;
  bin?: string;
  notes?: string;
}

export interface SparePart {
  id: string;
  tenantId: string;
  /** Server-generated (`SP-000001`); no input type carries it. */
  code: string;
  name: string;
  partNumber: string;
  description?: string;
  equipmentTypeId?: string;
  compatibleEquipmentTypes?: string[];
  supplierId?: string;
  manufacturer?: string;
  /**
   * On-hand across every storage location, DERIVED from the storage ledger
   * (FARM-HIGH-338). Float: ledger quantities may be fractional. Changes only
   * through `recordSparePartStockMovement`, never through create/update.
   */
  quantity: number;
  /** Unreceived remainder on open purchase orders (ledger-derived). */
  onOrderQuantity: number;
  minStock: number;
  maxStock: number;
  reorderPoint: number;
  unit: string;
  status: SparePartStatus;
  /**
   * The storage location that physically holds the part — the ledger location
   * its movements default to. Null while the part has never been stocked.
   */
  storageLocationId?: string | null;
  binDetail?: SparePartBinDetail | null;
  /** @deprecated Float — use `unitPriceDecimal` (exact decimal string, ADR-0004). */
  unitPrice?: number;
  unitPriceDecimal?: string | null;
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
  /** @deprecated Float — use `estimatedCostDecimal` (exact decimal string, ADR-0004). */
  estimatedCost?: number;
  estimatedCostDecimal?: string | null;
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

export interface StartWorkOrderInput {
  id: string;
  startTime?: string;
  notes?: string;
}

export interface VerifyWorkOrderInput {
  id: string;
  verificationNotes?: string;
  approved: boolean;
  rejectionReason?: string;
}

export interface ApproveWorkOrderInput {
  id: string;
  approvalNotes?: string;
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
  tenantId
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
  estimatedCostDecimal
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
  tenantId
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
  estimatedCostDecimal
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
  tenantId
  code
  name
  partNumber
  description
  equipmentTypeId
  compatibleEquipmentTypes
  supplierId
  manufacturer
  quantity
  onOrderQuantity
  minStock
  maxStock
  reorderPoint
  unit
  status
  storageLocationId
  binDetail
  unitPrice
  unitPriceDecimal
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
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'workOrders', filter, page, limit),
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
        workOrders: PaginationResultV1<WorkOrder>;
      }>(query, { filter, page, limit });

      return result.workOrders;
    },
    enabled: !!tenantId,
  });
}

export function useWorkOrder(id: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'workOrder', id),
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
    enabled: !!id && !!tenantId,
  });
}

export function useWorkOrderStatistics(dateFrom?: string, dateTo?: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'workOrderStatistics', dateFrom, dateTo),
    queryFn: async () => {
      const query = `
        query WorkOrderStatistics($dateFrom: DateTime, $dateTo: DateTime) {
          workOrderStatistics(dateFrom: $dateFrom, dateTo: $dateTo) {
            total
            overdue
            completedOnTime
            avgCompletionTime
            totalCost
            totalCostDecimal
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
          totalCostDecimal: string;
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
    enabled: !!tenantId,
  });
}

export function useCreateWorkOrder() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
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
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

export function useUpdateWorkOrder() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
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
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrder', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

export function useCompleteWorkOrder() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
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
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrder', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

export function useDeleteWorkOrder() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
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
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

// ============================================================================
// HOOKS - Work Order Lifecycle Mutations
// ============================================================================

export function useSubmitWorkOrderForApproval() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation SubmitWorkOrderForApproval($id: ID!) {
          submitWorkOrderForApproval(id: $id) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ submitWorkOrderForApproval: WorkOrder }>(
        mutation,
        { id }
      );

      return result.submitWorkOrderForApproval;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrder', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

export function useApproveWorkOrder() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: ApproveWorkOrderInput) => {
      const mutation = `
        mutation ApproveWorkOrder($input: ApproveWorkOrderInput!) {
          approveWorkOrder(input: $input) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ approveWorkOrder: WorkOrder }>(
        mutation,
        { input }
      );

      return result.approveWorkOrder;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrder', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

export function useStartWorkOrder() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: StartWorkOrderInput) => {
      const mutation = `
        mutation StartWorkOrder($input: StartWorkOrderInput!) {
          startWorkOrder(input: $input) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ startWorkOrder: WorkOrder }>(
        mutation,
        { input }
      );

      return result.startWorkOrder;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrder', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

export function useVerifyWorkOrder() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: VerifyWorkOrderInput) => {
      const mutation = `
        mutation VerifyWorkOrder($input: VerifyWorkOrderInput!) {
          verifyWorkOrder(input: $input) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ verifyWorkOrder: WorkOrder }>(
        mutation,
        { input }
      );

      return result.verifyWorkOrder;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrder', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

export function useCancelWorkOrder() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const mutation = `
        mutation CancelWorkOrder($id: ID!, $reason: String) {
          cancelWorkOrder(id: $id, reason: $reason) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ cancelWorkOrder: WorkOrder }>(
        mutation,
        { id, reason }
      );

      return result.cancelWorkOrder;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrder', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

export function usePutWorkOrderOnHold() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const mutation = `
        mutation PutWorkOrderOnHold($id: ID!, $reason: String) {
          putWorkOrderOnHold(id: $id, reason: $reason) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ putWorkOrderOnHold: WorkOrder }>(
        mutation,
        { id, reason }
      );

      return result.putWorkOrderOnHold;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrder', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

export function useResumeWorkOrder() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation ResumeWorkOrder($id: ID!) {
          resumeWorkOrder(id: $id) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ resumeWorkOrder: WorkOrder }>(
        mutation,
        { id }
      );

      return result.resumeWorkOrder;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrder', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
    },
  });
}

// ============================================================================
// HOOKS - Maintenance Schedules
// ============================================================================

export function useMaintenanceSchedules(filter?: MaintenanceScheduleFilter, page = 1, limit = 20) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'maintenanceSchedules', filter, page, limit),
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
        maintenanceSchedules: PaginationResultV1<MaintenanceSchedule>;
      }>(query, { filter, page, limit });

      return result.maintenanceSchedules;
    },
    enabled: !!tenantId,
  });
}

export function useMaintenanceSchedule(id: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'maintenanceSchedule', id),
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
    enabled: !!id && !!tenantId,
  });
}

export function useUpcomingMaintenanceSchedules(days = 7) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'upcomingMaintenanceSchedules', days),
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
    enabled: !!tenantId,
  });
}

export function useMaintenanceAlerts() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'maintenanceAlerts'),
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
    enabled: !!tenantId,
  });
}

// Input types for Maintenance Schedule mutations
export interface CreateMaintenanceScheduleInput {
  name: string;
  description?: string;
  category: MaintenanceCategory;
  assetType?: AssetType;
  assetId?: string;
  assetName?: string;
  recurrenceRule: {
    type: RecurrenceType;
    interval?: number;
    daysOfWeek?: number[];
    dayOfMonth?: number;
    monthsOfYear?: number[];
    endDate?: string;
    maxOccurrences?: number;
    meterType?: 'hours' | 'cycles' | 'km';
    meterInterval?: number;
  };
  startDate: string;
  endDate?: string;
  estimatedDurationMinutes?: number;
  estimatedCost?: number;
  currency?: string;
  checklistTemplate?: { items: { description: string; isRequired?: boolean }[] };
  requiredMaterials?: { materialId?: string; name: string; quantity: number; unit: string; estimatedCost?: number }[];
  instructions?: string;
  defaultAssigneeId?: string;
  defaultTeamId?: string;
  alertSettings?: AlertSettings;
  autoGenerateWorkOrder?: boolean;
  generateDaysBefore?: number;
  notes?: string;
}

/**
 * Input for `completeMaintenance` — closes a maintenance schedule cycle
 * (sets lastExecutedDate, increments executionCount, recomputes nextDueDate
 * via markCompleted on the entity). `workOrderId` is optional — pass it
 * when the close was triggered from the context of an open work order so
 * the audit trail can correlate, even though this mutation does NOT close
 * the work order itself (use `completeWorkOrder` for that, but never
 * both — it would double-count).
 */
export interface CompleteMaintenanceInput {
  scheduleId: string;
  workOrderId?: string;
  meterReading?: number;
  notes?: string;
}

export interface UpdateMaintenanceScheduleInput {
  id: string;
  name?: string;
  description?: string;
  category?: MaintenanceCategory;
  status?: MaintenanceScheduleStatus;
  assetType?: AssetType;
  assetId?: string;
  assetName?: string;
  recurrenceRule?: {
    type: RecurrenceType;
    interval?: number;
    daysOfWeek?: number[];
    dayOfMonth?: number;
    monthsOfYear?: number[];
    endDate?: string;
    maxOccurrences?: number;
    meterType?: 'hours' | 'cycles' | 'km';
    meterInterval?: number;
  };
  startDate?: string;
  endDate?: string;
  estimatedDurationMinutes?: number;
  estimatedCost?: number;
  currency?: string;
  checklistTemplate?: { items: { description: string; isRequired?: boolean }[] };
  requiredMaterials?: { materialId?: string; name: string; quantity: number; unit: string; estimatedCost?: number }[];
  instructions?: string;
  defaultAssigneeId?: string;
  defaultTeamId?: string;
  alertSettings?: AlertSettings;
  autoGenerateWorkOrder?: boolean;
  generateDaysBefore?: number;
  notes?: string;
}

export function useCreateMaintenanceSchedule() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: CreateMaintenanceScheduleInput) => {
      const mutation = `
        mutation CreateMaintenanceSchedule($input: CreateMaintenanceScheduleInput!) {
          createMaintenanceSchedule(input: $input) {
            ${MAINTENANCE_SCHEDULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ createMaintenanceSchedule: MaintenanceSchedule }>(
        mutation,
        { input }
      );

      return result.createMaintenanceSchedule;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'upcomingMaintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceAlerts') });
    },
  });
}

export function useUpdateMaintenanceSchedule() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: UpdateMaintenanceScheduleInput) => {
      const mutation = `
        mutation UpdateMaintenanceSchedule($input: UpdateMaintenanceScheduleInput!) {
          updateMaintenanceSchedule(input: $input) {
            ${MAINTENANCE_SCHEDULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ updateMaintenanceSchedule: MaintenanceSchedule }>(
        mutation,
        { input }
      );

      return result.updateMaintenanceSchedule;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedule', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'upcomingMaintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceAlerts') });
    },
  });
}

export function useDeleteMaintenanceSchedule() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation DeleteMaintenanceSchedule($id: ID!) {
          deleteMaintenanceSchedule(id: $id) {
            success
            id
            message
          }
        }
      `;

      const result = await graphqlClient.request<{
        deleteMaintenanceSchedule: { success: boolean; id: string; message?: string };
      }>(mutation, { id });

      return result.deleteMaintenanceSchedule;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'upcomingMaintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceAlerts') });
    },
  });
}

export function usePauseMaintenanceSchedule() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation PauseMaintenanceSchedule($id: ID!) {
          pauseMaintenanceSchedule(id: $id) {
            ${MAINTENANCE_SCHEDULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ pauseMaintenanceSchedule: MaintenanceSchedule }>(
        mutation,
        { id }
      );

      return result.pauseMaintenanceSchedule;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedule', data.id) });
    },
  });
}

export function useResumeMaintenanceSchedule() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation ResumeMaintenanceSchedule($id: ID!) {
          resumeMaintenanceSchedule(id: $id) {
            ${MAINTENANCE_SCHEDULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ resumeMaintenanceSchedule: MaintenanceSchedule }>(
        mutation,
        { id }
      );

      return result.resumeMaintenanceSchedule;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedule', data.id) });
    },
  });
}

/**
 * Mark a maintenance schedule cycle as completed (without going through a
 * WorkOrder). Use cases:
 *   - Operator closed the cycle off-system (paper inspection, ad-hoc check)
 *     and wants the schedule's lastExecutedDate / executionCount /
 *     nextDueDate to reflect reality.
 *   - METER_BASED schedules where a fresh meter reading needs to land on
 *     the schedule alongside completion.
 *
 * Backend resolver: `completeMaintenance(input: CompleteMaintenanceInput!): MaintenanceSchedule`
 * (apps/farm-service/src/maintenance/resolvers/maintenance-schedule.resolver.ts:304).
 *
 * IMPORTANT: do NOT chain this with `useCompleteWorkOrder` for the same
 * cycle — `completeWorkOrder` already calls `schedule.markCompleted()` in
 * a transaction, so calling both would double-count `executionCount` and
 * `metrics.totalExecutions`. This hook is for the schedule-only path.
 */
export function useCompleteMaintenance() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: CompleteMaintenanceInput) => {
      const mutation = `
        mutation CompleteMaintenance($input: CompleteMaintenanceInput!) {
          completeMaintenance(input: $input) {
            ${MAINTENANCE_SCHEDULE_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ completeMaintenance: MaintenanceSchedule }>(
        mutation,
        { input }
      );

      return result.completeMaintenance;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedule', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'upcomingMaintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceAlerts') });
    },
  });
}

/**
 * Sweep all ACTIVE schedules with `autoGenerateWorkOrder=true` and
 * generate WorkOrders for any whose `nextDueDate` falls within each
 * schedule's `generateDaysBefore` window AND don't already have an
 * open WO for that due date.
 *
 * Backend resolver: `processAutoGenerateWorkOrders(): [WorkOrder!]!`
 * (apps/farm-service/src/maintenance/resolvers/maintenance-schedule.resolver.ts:344).
 * The service is idempotent — repeat calls within the same window
 * won't create duplicates because it compares (scheduleId, dueDate)
 * against existing work orders.
 *
 * Returns the array of NEWLY created work orders (possibly empty).
 *
 * Permission: TENANT_ADMIN only. The UI gates this behind a typed-
 * confirmation modal because one click can fan out into dozens of
 * work orders, each triggering assignments + alerts. The backend
 * `@Roles` decorator is the authoritative gate; the typed-confirm is
 * a UX guard against fat-finger clicks (the operator must literally
 * type "OLUŞTUR" before the action fires).
 */
export function useProcessAutoGenerateWorkOrders() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async () => {
      const mutation = `
        mutation ProcessAutoGenerateWorkOrders {
          processAutoGenerateWorkOrders {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;
      const result = await graphqlClient.request<{
        processAutoGenerateWorkOrders: WorkOrder[];
      }>(mutation, {});
      return result.processAutoGenerateWorkOrders;
    },
    onSuccess: (data) => {
      // Skip the cache invalidation if the sweep created nothing — no
      // server-side state changed.
      if (data.length === 0) return;
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'upcomingMaintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceAlerts') });
    },
  });
}

/**
 * Generate a one-off WorkOrder from an ACTIVE MaintenanceSchedule.
 *
 * Backend resolver: `generateWorkOrderFromSchedule(scheduleId: ID!): WorkOrder`
 * (apps/farm-service/src/maintenance/resolvers/maintenance-schedule.resolver.ts).
 * The service rejects non-ACTIVE schedules with a 400 — UI also pre-checks
 * via `useCanMutate('generateWorkOrderFromSchedule')` and a status guard.
 *
 * Cache invalidation:
 *   - Work order list / statistics (new row appears)
 *   - Schedule list + detail (lastGeneratedAt / nextDueDate may shift)
 */
export function useGenerateWorkOrderFromSchedule() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (scheduleId: string) => {
      const mutation = `
        mutation GenerateWorkOrderFromSchedule($scheduleId: ID!) {
          generateWorkOrderFromSchedule(scheduleId: $scheduleId) {
            ${WORK_ORDER_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ generateWorkOrderFromSchedule: WorkOrder }>(
        mutation,
        { scheduleId }
      );

      return result.generateWorkOrderFromSchedule;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'workOrderStatistics') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedules') });
      if (data.maintenanceScheduleId) {
        queryClient.invalidateQueries({
          queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedule', data.maintenanceScheduleId),
        });
      }
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'upcomingMaintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceAlerts') });
    },
  });
}

/**
 * Update the current meter reading on a METER_BASED maintenance
 * schedule. Used between maintenance events for walk-around meter
 * captures — distinct from `useCompleteMaintenance`, which uses the
 * meter reading as part of closing a cycle.
 *
 * Backend resolver: `updateMeterReading(input: UpdateMeterReadingInput!): MaintenanceSchedule`
 * (apps/farm-service/src/maintenance/resolvers/maintenance-schedule.resolver.ts:319).
 * The service rejects non-METER_BASED schedules with a 400 — UI also
 * pre-checks via the row's `recurrenceRule.type`.
 */
export interface UpdateMeterReadingInput {
  id: string;
  meterReading: number;
}

export function useUpdateMeterReading() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: UpdateMeterReadingInput) => {
      const mutation = `
        mutation UpdateMeterReading($input: UpdateMeterReadingInput!) {
          updateMeterReading(input: $input) {
            ${MAINTENANCE_SCHEDULE_FIELDS}
          }
        }
      `;
      const result = await graphqlClient.request<{
        updateMeterReading: MaintenanceSchedule;
      }>(mutation, { input });
      return result.updateMeterReading;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceSchedule', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'upcomingMaintenanceSchedules') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'maintenanceAlerts') });
    },
  });
}

// ============================================================================
// HOOKS - Spare Parts
// ============================================================================

export function useSpareParts(filter?: SparePartFilter, page = 1, limit = 20) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'spareParts', filter, page, limit),
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
        spareParts: PaginationResultV1<SparePart>;
      }>(query, { filter, page, limit });

      return result.spareParts;
    },
    enabled: !!tenantId,
  });
}

export function useSparePart(id: string) {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'sparePart', id),
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
    enabled: !!id && !!tenantId,
  });
}

export function useLowStockAlerts() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'lowStockAlerts'),
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
          /** Ledger on-hand (Float, FARM-HIGH-338). */
          currentQuantity: number;
          minStock: number;
          reorderPoint: number;
          /** reorderPoint − (on-hand + open orders), never negative (Float). */
          deficit: number;
        }[];
      }>(query, {});

      return result.lowStockAlerts;
    },
    enabled: !!tenantId,
  });
}

export function useStockSummary() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'stockSummary'),
    queryFn: async () => {
      const query = `
        query StockSummary {
          stockSummary {
            totalParts
            totalValue
            totalValueDecimal
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
          totalValueDecimal: string;
          lowStockCount: number;
          outOfStockCount: number;
          inStockCount: number;
          onOrderCount: number;
          discontinuedCount: number;
        };
      }>(query, {});

      return result.stockSummary;
    },
    enabled: !!tenantId,
  });
}

/**
 * Input of `recordSparePartStockMovement` — mirrors the backend
 * `StockMovementInput` (apps/farm-service/src/maintenance/dto/spare-part.dto.ts).
 */
export interface SparePartStockMovementInput {
  sparePartId: string;
  /**
   * in/out/transfer: the amount moved (> 0). adjustment: the counted on-hand AT
   * the location (>= 0). Int.
   */
  quantity: number;
  movementType: 'in' | 'out' | 'adjustment' | 'transfer';
  /**
   * The ledger location the movement acts at (the SOURCE of a transfer). The
   * backend defaults it to the part's own `storageLocationId`; one of the two
   * must exist.
   */
  storageLocationId?: string;
  /**
   * transfer only: the location that receives the stock. Spare parts relocate
   * through this manager-gated door, never through `transferStock`.
   */
  toStorageLocationId?: string;
  reason?: string;
  workOrderId?: string;
  notes?: string;
}

/**
 * Spare-part cache keys whose values the storage ledger DERIVES (quantity,
 * onOrderQuantity, status, low-stock deficit, summary counts). Every write that
 * books a ledger movement for a part invalidates all of them.
 */
const SPARE_PART_LEDGER_DERIVED_KEYS = ['spareParts', 'lowStockAlerts', 'stockSummary'] as const;

/**
 * Storage-module cache keys (useStorageInventory.ts) that show the same ledger
 * rows: a spare-part movement IS a storage-ledger movement (FARM-HIGH-338), so
 * the storage surfaces go stale with it.
 */
const STORAGE_LEDGER_KEYS = ['storageInventory', 'stockMovements', 'storageOverview'] as const;

/**
 * Records one spare-part stock movement in the storage ledger.
 *
 * WHY `recordSparePartStockMovement`: `recordStockMovement` is the STORAGE
 * inventory mutation (input type `RecordStockMovementInput`); sending this
 * hook's `StockMovementInput` to it failed GraphQL validation, so no
 * spare-part movement ever reached the backend (FARM-HIGH-338).
 */
export function useRecordStockMovement() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: SparePartStockMovementInput) => {
      const mutation = `
        mutation RecordSparePartStockMovement($input: StockMovementInput!) {
          recordSparePartStockMovement(input: $input) {
            ${SPARE_PART_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ recordSparePartStockMovement: SparePart }>(
        mutation,
        { input }
      );

      return result.recordSparePartStockMovement;
    },
    onSuccess: (data) => {
      for (const key of [...SPARE_PART_LEDGER_DERIVED_KEYS, ...STORAGE_LEDGER_KEYS]) {
        queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, key) });
      }
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'sparePart', data.id) });
    },
  });
}

// Input types for Spare Part mutations — mirror the backend DTOs
// (apps/farm-service/src/maintenance/dto/spare-part.dto.ts). `code` is
// server-generated; `quantity` and `status` are ledger-derived, so neither
// input carries them and an object literal that tries is a compile error.

/** Catalogue fields shared by every create shape. */
interface CreateSparePartCatalogueInput {
  name: string;
  partNumber: string;
  description?: string;
  equipmentTypeId?: string;
  compatibleEquipmentTypes?: string[];
  supplierId?: string;
  manufacturer?: string;
  minStock: number;
  maxStock: number;
  reorderPoint: number;
  unit: string;
  binDetail?: SparePartBinDetail;
  unitPrice?: number;
  currency?: string;
  leadTimeDays?: number;
  notes?: string;
}

/**
 * The opening balance is ONE ledger IN movement AT a storage location, so the
 * backend rejects `openingQuantity > 0` without `storageLocationId`. The union
 * makes that shape unrepresentable here: a positive opening quantity only
 * type-checks together with a location.
 */
export type CreateSparePartInput =
  | (CreateSparePartCatalogueInput & { openingQuantity: 0; storageLocationId?: string })
  | (CreateSparePartCatalogueInput & { openingQuantity: number; storageLocationId: string });

export interface UpdateSparePartInput {
  id: string;
  name?: string;
  partNumber?: string;
  description?: string;
  equipmentTypeId?: string;
  compatibleEquipmentTypes?: string[];
  supplierId?: string;
  manufacturer?: string;
  /** Re-home the part: the location its future movements default to. */
  storageLocationId?: string;
  minStock?: number;
  maxStock?: number;
  reorderPoint?: number;
  unit?: string;
  binDetail?: SparePartBinDetail;
  unitPrice?: number;
  currency?: string;
  leadTimeDays?: number;
  notes?: string;
  isActive?: boolean;
}

export function useCreateSparePart() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: CreateSparePartInput) => {
      const mutation = `
        mutation CreateSparePart($input: CreateSparePartInput!) {
          createSparePart(input: $input) {
            ${SPARE_PART_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ createSparePart: SparePart }>(
        mutation,
        { input }
      );

      return result.createSparePart;
    },
    onSuccess: () => {
      // A non-zero opening quantity is booked as a ledger IN movement, so the
      // create touches the same derived + storage caches as a movement does.
      for (const key of [...SPARE_PART_LEDGER_DERIVED_KEYS, ...STORAGE_LEDGER_KEYS]) {
        queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, key) });
      }
    },
  });
}

export function useUpdateSparePart() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: UpdateSparePartInput) => {
      const mutation = `
        mutation UpdateSparePart($input: UpdateSparePartInput!) {
          updateSparePart(input: $input) {
            ${SPARE_PART_FIELDS}
          }
        }
      `;

      const result = await graphqlClient.request<{ updateSparePart: SparePart }>(
        mutation,
        { input }
      );

      return result.updateSparePart;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'spareParts') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'sparePart', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'lowStockAlerts') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'stockSummary') });
    },
  });
}

export function useDeleteSparePart() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      const mutation = `
        mutation DeleteSparePart($id: ID!) {
          deleteSparePart(id: $id) {
            success
            id
            message
          }
        }
      `;

      const result = await graphqlClient.request<{
        deleteSparePart: { success: boolean; id: string; message?: string };
      }>(mutation, { id });

      return result.deleteSparePart;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'spareParts') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'lowStockAlerts') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'stockSummary') });
    },
  });
}
