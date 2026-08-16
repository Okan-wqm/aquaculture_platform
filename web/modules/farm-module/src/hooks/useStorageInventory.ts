/**
 * Storage Inventory & Stock Movements hooks for farm-module
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaginationResultV1 } from '@platform/pagination-contracts';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

// Types
export enum StorageItemType {
  FEED = 'FEED',
  CHEMICAL = 'CHEMICAL',
  CONSUMABLE = 'CONSUMABLE',
  HEALTHCARE = 'HEALTHCARE',
}

export enum MovementType {
  IN = 'IN',
  OUT = 'OUT',
  TRANSFER = 'TRANSFER',
  WASTE = 'WASTE',
  ADJUSTMENT = 'ADJUSTMENT',
  RETURN = 'RETURN',
}

export interface StorageInventoryItem {
  id: string;
  tenantId: string;
  storageLocationId: string;
  itemType: StorageItemType;
  itemId: string;
  quantity: number;
  unit: string;
  lotNumber?: string;
  expiryDate?: string;
  notes?: string;
  itemName?: string;
  locationName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConditionWarning {
  field: string;
  message: string;
  itemMin?: number;
  itemMax?: number;
  locationMin?: number;
  locationMax?: number;
}

export interface StockMovement {
  id: string;
  tenantId: string;
  movementType: MovementType;
  itemType: string;
  itemId: string;
  itemName: string;
  quantity: number;
  unit: string;
  fromLocationId?: string;
  toLocationId?: string;
  fromLocationName?: string;
  toLocationName?: string;
  reference?: string;
  reason?: string;
  performedBy: string;
  /** Display name of the user who performed this movement (from JWT at write time) */
  performedByName?: string;
  performedAt: string;
  createdAt: string;
  lotNumber?: string;
  expiryDate?: string;
  warnings?: ConditionWarning[];
}

export interface CategoryTotal {
  category: string;
  totalQuantity: number;
  /** @deprecated Float — use `totalValueDecimal` (exact decimal string, ADR-0004). */
  totalValue: number;
  totalValueDecimal: string;
  itemCount: number;
}

export interface LocationFillRate {
  locationId: string;
  locationName: string;
  locationType: string;
  capacity?: number;
  capacityUnit: string;
  usedCapacity: number;
  fillPercentage: number;
}

export interface LowStockAlert {
  itemId: string;
  itemName: string;
  itemType: string;
  currentQuantity: number;
  minStock: number;
  unit: string;
}

export interface StorageOverview {
  /** @deprecated Float — use `totalStockValueDecimal` (exact decimal string, ADR-0004). */
  totalStockValue: number;
  totalStockValueDecimal: string;
  totalItems: number;
  lowStockAlertCount: number;
  recentMovementsCount: number;
  categoryTotals: CategoryTotal[];
  locationFillRates: LocationFillRate[];
  lowStockAlerts: LowStockAlert[];
}

export interface RecordStockMovementInput {
  movementType: MovementType;
  itemType: StorageItemType;
  itemId: string;
  quantity: number;
  fromLocationId?: string;
  toLocationId?: string;
  lotNumber?: string;
  expiryDate?: string;
  reference?: string;
  reason?: string;
  /** Client-generated UUID for at-most-once delivery (prevents duplicate movements on retry) */
  idempotencyKey?: string;
}

export interface TransferStockInput {
  itemType: StorageItemType;
  itemId: string;
  quantity: number;
  fromLocationId: string;
  toLocationId: string;
  lotNumber?: string;
  reference?: string;
  reason?: string;
}

type StockMovementsPage = Pick<
  PaginationResultV1<StockMovement>,
  'items' | 'total' | 'page' | 'limit' | 'totalPages'
>;

// Queries
const STORAGE_INVENTORY_QUERY = `
  query StorageInventory($locationId: ID, $itemType: StorageItemType) {
    storageInventory(locationId: $locationId, itemType: $itemType) {
      id
      tenantId
      storageLocationId
      itemType
      itemId
      quantity
      unit
      lotNumber
      expiryDate
      notes
      itemName
      locationName
      createdAt
      updatedAt
    }
  }
`;

const STORAGE_OVERVIEW_QUERY = `
  query StorageOverview {
    storageOverview {
      totalStockValue
      totalStockValueDecimal
      totalItems
      lowStockAlertCount
      recentMovementsCount
      categoryTotals {
        category
        totalQuantity
        totalValue
        totalValueDecimal
        itemCount
      }
      locationFillRates {
        locationId
        locationName
        locationType
        capacity
        capacityUnit
        usedCapacity
        fillPercentage
      }
      lowStockAlerts {
        itemId
        itemName
        itemType
        currentQuantity
        minStock
        unit
      }
    }
  }
`;

const STOCK_MOVEMENTS_QUERY = `
  query StockMovements($filter: StockMovementFilterInput, $pagination: FarmPaginationInput) {
    stockMovements(filter: $filter, pagination: $pagination) {
      items {
        id
        tenantId
        movementType
        itemType
        itemId
        itemName
        quantity
        unit
        fromLocationId
        toLocationId
        fromLocationName
        toLocationName
        reference
        reason
        performedBy
        performedByName
        performedAt
        createdAt
        lotNumber
        expiryDate
      }
      total
      page
      limit
      totalPages
    }
  }
`;

const RECORD_STOCK_MOVEMENT_MUTATION = `
  mutation RecordStockMovement($input: RecordStockMovementInput!) {
    recordStockMovement(input: $input) {
      id
      movementType
      itemType
      itemId
      itemName
      quantity
      unit
      warnings {
        field
        message
        itemMin
        itemMax
        locationMin
        locationMax
      }
    }
  }
`;

/**
 * Lot traceability query — retrieves the full movement chain for a single
 * lot number across all storage locations. This is the core data source for
 * EU Regulation 178/2002 Article 18 compliance, which requires every feed
 * and chemical lot to be traceable one-step-back (supplier) and
 * one-step-forward (consumer/disposal point).
 */
const TRACE_LOT_QUERY = `
  query TraceLot($lotNumber: String!) {
    traceLot(lotNumber: $lotNumber) {
      id movementType itemType itemId itemName quantity unit
      fromLocationId toLocationId fromLocationName toLocationName
      lotNumber expiryDate reference reason
      performedBy performedByName performedAt createdAt
    }
  }
`;

const TRANSFER_STOCK_MUTATION = `
  mutation TransferStock($input: TransferStockInput!) {
    transferStock(input: $input) {
      id
      movementType
      itemType
      itemId
      itemName
      quantity
      unit
    }
  }
`;

// Hooks
export function useStorageInventory(locationId?: string, itemType?: StorageItemType) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'storageInventory', locationId, itemType),
    queryFn: async () => {
      const data = await graphqlClient.request<{ storageInventory: StorageInventoryItem[] }>(
        STORAGE_INVENTORY_QUERY,
        { locationId, itemType }
      );
      return data.storageInventory;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

export function useStorageOverview() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'storageOverview'),
    queryFn: async () => {
      const data = await graphqlClient.request<{ storageOverview: StorageOverview }>(
        STORAGE_OVERVIEW_QUERY
      );
      return data.storageOverview;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

export function useStockMovements(filter?: {
  movementType?: string;
  itemType?: string;
  itemId?: string;
  locationId?: string;
  fromDate?: string;
  toDate?: string;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'stockMovements', 'list', filter),
    queryFn: async () => {
      const data = await graphqlClient.request<{ stockMovements: StockMovementsPage }>(
        STOCK_MOVEMENTS_QUERY,
        { filter, pagination: { page: 1, limit: 100 } }
      );
      return data.stockMovements;
    },
    staleTime: 15000,
    enabled: !!token && !!tenantId,
  });
}

export function useRecordStockMovement() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RecordStockMovementInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ recordStockMovement: StockMovement }>(
        RECORD_STOCK_MOVEMENT_MUTATION,
        { input }
      );
      return data.recordStockMovement;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageInventory') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'stockMovements') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageOverview') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeds', 'list') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'chemicals', 'list') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'consumables', 'list') });
    },
  });
}

/**
 * Trace all movements for a specific lot number across all locations.
 * Required for EU Regulation 178/2002 Article 18 compliance: every feed
 * and chemical lot must be traceable from supplier delivery (IN) through
 * storage (TRANSFER) to consumption (OUT) or disposal (WASTE).
 *
 * Usage: Enter a lot number from a supplier delivery note to see the
 * complete chain of movements including which locations stored it,
 * when it was transferred, and where it was ultimately consumed.
 *
 * The query is only enabled when the lot number has at least 2 characters,
 * which avoids flooding the backend with single-character wildcard searches
 * that would return too many results to be useful.
 */
export function useLotTrace(lotNumber: string | null) {
  const { token, tenantId } = useAuth();
  return useQuery<StockMovement[]>({
    queryKey: createTenantQueryKey(tenantId, 'lotTrace', lotNumber),
    queryFn: async () => {
      const data = await graphqlClient.request<{ traceLot: StockMovement[] }>(
        TRACE_LOT_QUERY,
        { lotNumber }
      );
      return data.traceLot;
    },
    enabled: !!token && !!tenantId && !!lotNumber && lotNumber.length >= 2,
    staleTime: 30000,
  });
}

export function useTransferStock() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: TransferStockInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ transferStock: StockMovement }>(
        TRANSFER_STOCK_MUTATION,
        { input }
      );
      return data.transferStock;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageInventory') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'stockMovements') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageOverview') });
    },
  });
}
