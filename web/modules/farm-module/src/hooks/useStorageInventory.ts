/**
 * Storage Inventory & Stock Movements hooks for farm-module
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

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
  performedAt: string;
  createdAt: string;
  warnings?: ConditionWarning[];
}

export interface CategoryTotal {
  category: string;
  totalQuantity: number;
  totalValue: number;
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
  totalStockValue: number;
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

interface PaginatedMovementsResponse {
  items: StockMovement[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

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
      totalItems
      lowStockAlertCount
      recentMovementsCount
      categoryTotals {
        category
        totalQuantity
        totalValue
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
        performedAt
        createdAt
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
    queryKey: ['storageInventory', locationId, itemType],
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
    queryKey: ['storageOverview'],
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
    queryKey: ['stockMovements', 'list', filter],
    queryFn: async () => {
      const data = await graphqlClient.request<{ stockMovements: PaginatedMovementsResponse }>(
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
      queryClient.invalidateQueries({ queryKey: ['storageInventory'] });
      queryClient.invalidateQueries({ queryKey: ['stockMovements'] });
      queryClient.invalidateQueries({ queryKey: ['storageOverview'] });
      queryClient.invalidateQueries({ queryKey: ['feeds', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['chemicals', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['consumables', 'list'] });
    },
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
      queryClient.invalidateQueries({ queryKey: ['storageInventory'] });
      queryClient.invalidateQueries({ queryKey: ['stockMovements'] });
      queryClient.invalidateQueries({ queryKey: ['storageOverview'] });
    },
  });
}
