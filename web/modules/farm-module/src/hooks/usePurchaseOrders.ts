/**
 * Purchase Order hooks for farm-module
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

// Types
export enum PurchaseOrderCategory {
  FEED = 'FEED',
  CHEMICAL = 'CHEMICAL',
  CONSUMABLE = 'CONSUMABLE',
  HEALTHCARE = 'HEALTHCARE',
}

// Canonical PO status vocabulary — kept in lock-step with the backend
// PurchaseOrderStatus enum (apps/farm-service/.../purchase-order.entity.ts).
// SUBMITTED + APPROVED are the maker-checker gate states (SOC2 CC3.4):
// DRAFT -> SUBMITTED (maker) -> APPROVED (checker) -> ORDERED (spend placed).
export enum PurchaseOrderStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  ORDERED = 'ORDERED',
  PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

export interface PurchaseOrderItem {
  id: string;
  itemId: string;
  itemName: string;
  itemCode?: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  totalPrice?: number;
  quantityReceived: number;
  isFullyReceived: boolean;
  notes?: string;
}

export interface PurchaseOrder {
  id: string;
  orderNumber: string;
  category: PurchaseOrderCategory;
  supplierName: string;
  supplierContact?: string;
  status: PurchaseOrderStatus;
  expectedDeliveryDate?: string;
  actualDeliveryDate?: string;
  notes?: string;
  totalAmount?: number;
  currency: string;
  // Maker-checker audit trail (SOC2 CC3.4) — populated once the PO is APPROVED.
  approvedBy?: string;
  approvedByName?: string;
  approvedAt?: string;
  items: PurchaseOrderItem[];
  createdAt: string;
  updatedAt: string;
}

interface PaginatedPurchaseOrders {
  items: PurchaseOrder[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CreatePurchaseOrderInput {
  category: PurchaseOrderCategory;
  supplierName: string;
  supplierContact?: string;
  expectedDeliveryDate?: string;
  notes?: string;
  items: {
    itemId: string;
    itemName: string;
    itemCode?: string;
    quantity: number;
    unit: string;
    unitPrice?: number;
  }[];
}

export interface ReceiveDeliveryInput {
  purchaseOrderId: string;
  storageLocationId: string;
  items: {
    itemId: string;
    quantityReceived: number;
    lotNumber?: string;
    expiryDate?: string;
  }[];
}

// GQL fragments
const PO_FIELDS = `
  id
  orderNumber
  category
  supplierName
  supplierContact
  status
  expectedDeliveryDate
  actualDeliveryDate
  notes
  totalAmount
  currency
  approvedBy
  approvedByName
  approvedAt
  items {
    id
    itemId
    itemName
    itemCode
    quantity
    unit
    unitPrice
    totalPrice
    quantityReceived
    isFullyReceived
    notes
  }
  createdAt
  updatedAt
`;

// Queries
const LIST_PURCHASE_ORDERS = `
  query PurchaseOrders($filter: PurchaseOrderFilterInput) {
    purchaseOrders(filter: $filter) {
      items { ${PO_FIELDS} }
      total
      page
      limit
      totalPages
    }
  }
`;

const GET_PURCHASE_ORDER = `
  query PurchaseOrder($id: ID!) {
    purchaseOrder(id: $id) { ${PO_FIELDS} }
  }
`;

const GET_PENDING_DELIVERIES = `
  query PendingDeliveries {
    pendingDeliveries { ${PO_FIELDS} }
  }
`;

// Mutations
const CREATE_PURCHASE_ORDER = `
  mutation CreatePurchaseOrder($input: CreatePurchaseOrderInput!) {
    createPurchaseOrder(input: $input) { ${PO_FIELDS} }
  }
`;

const UPDATE_PO_STATUS = `
  mutation UpdatePurchaseOrderStatus($input: UpdatePurchaseOrderStatusInput!) {
    updatePurchaseOrderStatus(input: $input) { ${PO_FIELDS} }
  }
`;

const RECEIVE_DELIVERY = `
  mutation ReceiveDelivery($input: ReceiveDeliveryInput!) {
    receiveDelivery(input: $input) { ${PO_FIELDS} }
  }
`;

const CANCEL_PO = `
  mutation CancelPurchaseOrder($id: ID!) {
    cancelPurchaseOrder(id: $id) { ${PO_FIELDS} }
  }
`;

// Maker-checker approval gate (SOC2 CC3.4). Distinct from updatePurchaseOrderStatus
// because the backend forbids the generic status mutation from reaching APPROVED —
// only this TENANT_ADMIN-gated mutation (with server-side self-approval block) can.
const APPROVE_PO = `
  mutation ApprovePurchaseOrder($id: ID!) {
    approvePurchaseOrder(id: $id) { ${PO_FIELDS} }
  }
`;

// Hooks
export function usePurchaseOrders(filter?: {
  category?: PurchaseOrderCategory;
  status?: PurchaseOrderStatus;
  page?: number;
  limit?: number;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'purchaseOrders', 'list', filter),
    queryFn: async () => {
      const data = await graphqlClient.request<{ purchaseOrders: PaginatedPurchaseOrders }>(
        LIST_PURCHASE_ORDERS,
        { filter }
      );
      return data.purchaseOrders;
    },
    staleTime: 15000,
    enabled: !!token && !!tenantId,
  });
}

export function usePurchaseOrder(id?: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'purchaseOrders', 'detail', id),
    queryFn: async () => {
      const data = await graphqlClient.request<{ purchaseOrder: PurchaseOrder }>(
        GET_PURCHASE_ORDER,
        { id }
      );
      return data.purchaseOrder;
    },
    staleTime: 15000,
    enabled: !!token && !!tenantId && !!id,
  });
}

export function usePendingDeliveries() {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'purchaseOrders', 'pending'),
    queryFn: async () => {
      const data = await graphqlClient.request<{ pendingDeliveries: PurchaseOrder[] }>(
        GET_PENDING_DELIVERIES
      );
      return data.pendingDeliveries;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

export function useCreatePurchaseOrder() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreatePurchaseOrderInput) => {
      if (!token) throw new Error('Authentication required.');
      if (!tenantId) throw new Error('Tenant context required.');
      const data = await graphqlClient.request<{ createPurchaseOrder: PurchaseOrder }>(
        CREATE_PURCHASE_ORDER,
        { input }
      );
      return data.createPurchaseOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'purchaseOrders') });
    },
  });
}

export function useUpdatePurchaseOrderStatus() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; status: PurchaseOrderStatus }) => {
      if (!token) throw new Error('Authentication required.');
      if (!tenantId) throw new Error('Tenant context required.');
      const data = await graphqlClient.request<{ updatePurchaseOrderStatus: PurchaseOrder }>(
        UPDATE_PO_STATUS,
        { input }
      );
      return data.updatePurchaseOrderStatus;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'purchaseOrders') });
    },
  });
}

export function useReceiveDelivery() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ReceiveDeliveryInput) => {
      if (!token) throw new Error('Authentication required.');
      if (!tenantId) throw new Error('Tenant context required.');
      const data = await graphqlClient.request<{ receiveDelivery: PurchaseOrder }>(
        RECEIVE_DELIVERY,
        { input }
      );
      return data.receiveDelivery;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'purchaseOrders') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageInventory') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'stockMovements') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageOverview') });
    },
  });
}

export function useCancelPurchaseOrder() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) throw new Error('Authentication required.');
      if (!tenantId) throw new Error('Tenant context required.');
      const data = await graphqlClient.request<{ cancelPurchaseOrder: PurchaseOrder }>(
        CANCEL_PO,
        { id }
      );
      return data.cancelPurchaseOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'purchaseOrders') });
    },
  });
}

/**
 * Submit a DRAFT purchase order for review (maker step, DRAFT -> SUBMITTED).
 * Routes through the generic updatePurchaseOrderStatus mutation — the backend
 * state machine allows DRAFT -> SUBMITTED but NOT SUBMITTED -> APPROVED there,
 * so the checker gate stays enforced server-side.
 */
export function useSubmitPurchaseOrder() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) throw new Error('Authentication required.');
      if (!tenantId) throw new Error('Tenant context required.');
      const data = await graphqlClient.request<{ updatePurchaseOrderStatus: PurchaseOrder }>(
        UPDATE_PO_STATUS,
        { input: { id, status: PurchaseOrderStatus.SUBMITTED } }
      );
      return data.updatePurchaseOrderStatus;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'purchaseOrders') });
    },
  });
}

/**
 * Approve a SUBMITTED purchase order (checker step, SUBMITTED -> APPROVED).
 * TENANT_ADMIN only; the backend additionally rejects self-approval
 * (createdBy === current user) with a 403 — SOC2 CC3.4 separation of duties.
 */
export function useApprovePurchaseOrder() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) throw new Error('Authentication required.');
      if (!tenantId) throw new Error('Tenant context required.');
      const data = await graphqlClient.request<{ approvePurchaseOrder: PurchaseOrder }>(
        APPROVE_PO,
        { id }
      );
      return data.approvePurchaseOrder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'purchaseOrders') });
    },
  });
}
