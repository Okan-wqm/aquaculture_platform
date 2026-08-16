/**
 * Inventory Count hooks for the storage module.
 *
 * Inventory counting (cycle counting) is a core warehouse management operation
 * that reconciles system stock quantities with physical counts. This is required
 * for BAP/ASC certification and regulatory compliance in aquaculture.
 *
 * Workflow: Start Count -> Enter Quantities -> Submit -> Approve -> Auto-adjust inventory
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaginationResultV1 } from '@platform/pagination-contracts';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

// ============================================================================
// Types — mirror the backend GraphQL schema for inventory counts
// ============================================================================

export enum InventoryCountStatus {
  PLANNED = 'PLANNED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  APPROVED = 'APPROVED',
}

/**
 * Individual line item within a count session.
 * Each row corresponds to one stock-keeping unit at the counted location.
 */
export interface InventoryCountItem {
  id: string;
  /** Category of the item (FEED, CHEMICAL, CONSUMABLE, HEALTHCARE) */
  itemType: string;
  /** Foreign key to the catalog item (feed, chemical, etc.) */
  itemId: string;
  /** Human-readable name resolved by the backend join */
  itemName: string;
  /** Unit of measure for the item (kg, L, pcs, etc.) */
  unit: string;
  /** Lot/batch number for traceability — critical for recall scenarios */
  lotNumber?: string;
  /** System-recorded quantity before counting began */
  expectedQuantity: number;
  /** Physical quantity entered by the counter — null until counted */
  actualQuantity?: number;
  /** Difference between actual and expected — calculated server-side for auditability */
  variance?: number;
  /** Counter's notes for this specific item (e.g., "damaged packaging") */
  notes?: string;
}

/**
 * Top-level inventory count record.
 * One count covers one storage location and may contain many items.
 */
export interface InventoryCount {
  id: string;
  /** Auto-generated sequential number (e.g., IC-2026-007) for human reference */
  countNumber: string;
  /** Storage location being counted */
  storageLocationId: string;
  /** Resolved location name for display — avoids extra lookup on frontend */
  locationName?: string;
  /** Lifecycle status governing which actions are available */
  status: InventoryCountStatus;
  /** When the count session was started (first item scanned) */
  startedAt?: string;
  /** When all items were submitted for review */
  completedAt?: string;
  /** When a supervisor approved the count and triggered stock adjustments */
  approvedAt?: string;
  /** User ID of the person performing the physical count */
  performedBy: string;
  /** Display name of the counter — resolved from JWT at write time */
  performedByName?: string;
  /** User ID of the approving supervisor */
  approvedBy?: string;
  /** Display name of the approver */
  approvedByName?: string;
  /** Free-text notes attached to the entire count session */
  notes?: string;
  /** Aggregate variance across all items — key metric for audit dashboards */
  totalVariance: number;
  /** Line items included in this count */
  items: InventoryCountItem[];
}

type InventoryCountsPage = Pick<
  PaginationResultV1<InventoryCount>,
  'items' | 'total' | 'page' | 'limit' | 'totalPages'
>;

export interface CreateInventoryCountInput {
  storageLocationId: string;
  notes?: string;
}

export interface UpdateInventoryCountItemsInput {
  countId: string;
  items: {
    itemId: string;
    actualQuantity: number;
    notes?: string;
  }[];
}

// ============================================================================
// GraphQL field fragment — reused across queries to ensure consistent shape
// ============================================================================

const COUNT_ITEM_FIELDS = `
  id
  itemType
  itemId
  itemName
  unit
  lotNumber
  expectedQuantity
  actualQuantity
  variance
  notes
`;

const COUNT_FIELDS = `
  id
  countNumber
  storageLocationId
  locationName
  status
  startedAt
  completedAt
  approvedAt
  performedBy
  performedByName
  approvedBy
  approvedByName
  notes
  totalVariance
  items {
    ${COUNT_ITEM_FIELDS}
  }
`;

// ============================================================================
// Queries
// ============================================================================

/** List counts with optional filtering — supports the main table view */
const INVENTORY_COUNTS_QUERY = `
  query InventoryCounts($filter: InventoryCountFilterInput) {
    inventoryCounts(filter: $filter) {
      items { ${COUNT_FIELDS} }
      total
      page
      limit
      totalPages
    }
  }
`;

/** Fetch a single count by ID — used in the detail/counting modal */
const INVENTORY_COUNT_QUERY = `
  query InventoryCount($id: ID!) {
    inventoryCount(id: $id) { ${COUNT_FIELDS} }
  }
`;

// ============================================================================
// Mutations
// ============================================================================

/**
 * Creates a new count for a location. Backend auto-populates items from
 * current inventory at that location (snapshot at count creation time).
 */
const CREATE_INVENTORY_COUNT_MUTATION = `
  mutation CreateInventoryCount($input: CreateInventoryCountInput!) {
    createInventoryCount(input: $input) { ${COUNT_FIELDS} }
  }
`;

/**
 * Batch-updates actual quantities for counted items. Supports partial saves
 * so the counter can resume later without losing progress.
 */
const UPDATE_INVENTORY_COUNT_ITEMS_MUTATION = `
  mutation UpdateInventoryCountItems($input: UpdateInventoryCountItemsInput!) {
    updateInventoryCountItems(input: $input) { ${COUNT_FIELDS} }
  }
`;

/**
 * Moves count from IN_PROGRESS to COMPLETED. Locks further edits and
 * makes it available for supervisor approval.
 */
const SUBMIT_INVENTORY_COUNT_MUTATION = `
  mutation SubmitInventoryCount($id: ID!) {
    submitInventoryCount(id: $id) { ${COUNT_FIELDS} }
  }
`;

/**
 * Supervisor approval triggers automatic stock adjustment movements.
 * Only users other than the counter should approve (segregation of duties).
 */
const APPROVE_INVENTORY_COUNT_MUTATION = `
  mutation ApproveInventoryCount($id: ID!) {
    approveInventoryCount(id: $id) { ${COUNT_FIELDS} }
  }
`;

// ============================================================================
// Hooks — each wraps a single GraphQL operation
// ============================================================================

/**
 * Fetches paginated list of inventory counts, optionally filtered by status
 * or location. Powers the main InventoryCountTab table.
 */
export function useInventoryCounts(filter?: {
  status?: InventoryCountStatus;
  locationId?: string;
  page?: number;
  limit?: number;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'inventoryCounts', 'list', filter),
    queryFn: async () => {
      const data = await graphqlClient.request<{ inventoryCounts: InventoryCountsPage }>(
        INVENTORY_COUNTS_QUERY,
        { filter }
      );
      return data.inventoryCounts;
    },
    staleTime: 15000,
    enabled: !!token && !!tenantId,
  });
}

/**
 * Fetches a single inventory count with all items. Used by the detail modal
 * to display or edit count line items.
 */
export function useInventoryCount(id?: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'inventoryCounts', 'detail', id),
    queryFn: async () => {
      const data = await graphqlClient.request<{ inventoryCount: InventoryCount }>(
        INVENTORY_COUNT_QUERY,
        { id }
      );
      return data.inventoryCount;
    },
    staleTime: 15000,
    enabled: !!token && !!tenantId && !!id,
  });
}

/**
 * Creates a new inventory count for the specified storage location.
 * Backend snapshots current inventory as expected quantities.
 */
export function useCreateInventoryCount() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateInventoryCountInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ createInventoryCount: InventoryCount }>(
        CREATE_INVENTORY_COUNT_MUTATION,
        { input }
      );
      return data.createInventoryCount;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'inventoryCounts') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageInventory') });
    },
  });
}

/**
 * Saves actual quantities for one or more items in a count.
 * Supports incremental saves so the counter can leave and resume.
 */
export function useUpdateInventoryCountItems() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateInventoryCountItemsInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ updateInventoryCountItems: InventoryCount }>(
        UPDATE_INVENTORY_COUNT_ITEMS_MUTATION,
        { input }
      );
      return data.updateInventoryCountItems;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'inventoryCounts') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageInventory') });
    },
  });
}

/**
 * Submits a completed count for supervisor review.
 * After submission, the counter can no longer edit quantities.
 */
export function useSubmitInventoryCount() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ submitInventoryCount: InventoryCount }>(
        SUBMIT_INVENTORY_COUNT_MUTATION,
        { id }
      );
      return data.submitInventoryCount;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'inventoryCounts') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageInventory') });
    },
  });
}

/**
 * Approves a submitted count and triggers automatic stock adjustments.
 * Only a different user than the counter should approve (segregation of duties).
 */
export function useApproveInventoryCount() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ approveInventoryCount: InventoryCount }>(
        APPROVE_INVENTORY_COUNT_MUTATION,
        { id }
      );
      return data.approveInventoryCount;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'inventoryCounts') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageInventory') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageOverview') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'stockMovements') });
    },
  });
}
