/**
 * Consumables hooks for farm-module
 * Handles CRUD operations for consumables via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

export enum ConsumableCategory {
  NET = 'NET',
  ROPE = 'ROPE',
  PPE = 'PPE',
  SPARE_PART = 'SPARE_PART',
  OXYGEN = 'OXYGEN',
  PACKAGING = 'PACKAGING',
  CLEANING = 'CLEANING',
  TOOL = 'TOOL',
  ELECTRICAL = 'ELECTRICAL',
  PIPE_FITTING = 'PIPE_FITTING',
  OTHER = 'OTHER',
}

export enum ConsumableStatus {
  AVAILABLE = 'AVAILABLE',
  LOW_STOCK = 'LOW_STOCK',
  OUT_OF_STOCK = 'OUT_OF_STOCK',
  DISCONTINUED = 'DISCONTINUED',
}

export interface Consumable {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  category: ConsumableCategory;
  description?: string;
  unit: string;
  brand?: string;
  supplierId?: string;
  quantity: number;
  minStock: number;
  status: ConsumableStatus;
  /** @deprecated Float — use `unitPriceDecimal` (exact decimal string, ADR-0004). */
  unitPrice?: number;
  unitPriceDecimal?: string | null;
  currency: string;
  storageTempMin?: number;
  storageTempMax?: number;
  storageHumidityMin?: number;
  storageHumidityMax?: number;
  storageRequirements?: string;
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface CreateConsumableInput {
  name: string;
  code: string;
  category: ConsumableCategory;
  unit: string;
  description?: string;
  brand?: string;
  supplierId?: string;
  quantity?: number;
  minStock?: number;
  unitPrice?: number;
  currency?: string;
  storageTempMin?: number;
  storageTempMax?: number;
  storageHumidityMin?: number;
  storageHumidityMax?: number;
  storageRequirements?: string;
  notes?: string;
}

export interface UpdateConsumableInput extends Partial<CreateConsumableInput> {
  id: string;
  status?: ConsumableStatus;
  isActive?: boolean;
}

interface PaginatedResponse {
  items: Consumable[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const CONSUMABLES_LIST_QUERY = `
  query Consumables($filter: ConsumableFilterInput, $pagination: FarmPaginationInput) {
    consumables(filter: $filter, pagination: $pagination) {
      items {
        id
        tenantId
        name
        code
        category
        description
        unit
        brand
        supplierId
        quantity
        minStock
        status
        unitPrice
        unitPriceDecimal
        currency
        storageTempMin
        storageTempMax
        storageHumidityMin
        storageHumidityMax
        storageRequirements
        notes
        isActive
        createdAt
        updatedAt
      }
      total
      page
      limit
      totalPages
    }
  }
`;

const CONSUMABLE_QUERY = `
  query Consumable($id: ID!) {
    consumable(id: $id) {
      id
      tenantId
      name
      code
      category
      description
      unit
      brand
      supplierId
      quantity
      minStock
      status
      unitPrice
      unitPriceDecimal
      currency
      storageTempMin
      storageTempMax
      storageHumidityMin
      storageHumidityMax
      storageRequirements
      notes
      isActive
      createdAt
      updatedAt
    }
  }
`;

const CREATE_CONSUMABLE_MUTATION = `
  mutation CreateConsumable($input: CreateConsumableInput!) {
    createConsumable(input: $input) {
      id
      name
      code
      category
      status
      isActive
    }
  }
`;

const UPDATE_CONSUMABLE_MUTATION = `
  mutation UpdateConsumable($input: UpdateConsumableInput!) {
    updateConsumable(input: $input) {
      id
      name
      code
      category
      status
      isActive
    }
  }
`;

const DELETE_CONSUMABLE_MUTATION = `
  mutation DeleteConsumable($id: ID!) {
    deleteConsumable(id: $id)
  }
`;

export function useConsumableList(filter?: {
  category?: ConsumableCategory;
  status?: ConsumableStatus;
  isActive?: boolean;
  supplierId?: string;
  search?: string;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'consumables', 'list', filter),
    queryFn: async () => {
      const data = await graphqlClient.request<{ consumables: PaginatedResponse }>(
        CONSUMABLES_LIST_QUERY,
        { filter, pagination: { page: 1, limit: 100 } }
      );
      return data.consumables;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

export function useConsumable(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'consumables', 'detail', id),
    queryFn: async () => {
      const data = await graphqlClient.request<{ consumable: Consumable }>(
        CONSUMABLE_QUERY,
        { id }
      );
      return data.consumable;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

export function useCreateConsumable() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateConsumableInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ createConsumable: Consumable }>(
        CREATE_CONSUMABLE_MUTATION,
        { input }
      );
      return data.createConsumable;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'consumables', 'list') });
    },
  });
}

export function useUpdateConsumable() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateConsumableInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ updateConsumable: Consumable }>(
        UPDATE_CONSUMABLE_MUTATION,
        { input }
      );
      return data.updateConsumable;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'consumables', 'list') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'consumables', 'detail', variables.id) });
    },
  });
}

export function useDeleteConsumable() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ deleteConsumable: boolean }>(
        DELETE_CONSUMABLE_MUTATION,
        { id }
      );
      return data.deleteConsumable;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'consumables', 'list') });
    },
  });
}
