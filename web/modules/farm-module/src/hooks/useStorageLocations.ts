/**
 * Storage Locations hooks for farm-module
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  createTenantQueryKey,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import type { PaginationResultV1 } from '@platform/pagination-contracts';

export enum StorageLocationType {
  WAREHOUSE = 'WAREHOUSE',
  COLD_ROOM = 'COLD_ROOM',
  CHEMICAL_STORE = 'CHEMICAL_STORE',
  FEED_SILO = 'FEED_SILO',
  OUTDOOR = 'OUTDOOR',
  HAZMAT = 'HAZMAT',
}

export interface StorageLocation {
  id: string;
  tenantId: string;
  siteId: string;
  name: string;
  code: string;
  type: StorageLocationType;
  description?: string;
  capacity?: number;
  capacityUnit: string;
  usedCapacity: number;
  temperatureMin?: number;
  temperatureMax?: number;
  humidityMin?: number;
  humidityMax?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface CreateStorageLocationInput {
  siteId: string;
  name: string;
  code: string;
  type: StorageLocationType;
  description?: string;
  capacity?: number;
  capacityUnit?: string;
  temperatureMin?: number;
  temperatureMax?: number;
  humidityMin?: number;
  humidityMax?: number;
}

export interface UpdateStorageLocationInput extends Partial<CreateStorageLocationInput> {
  id: string;
  isActive?: boolean;
}

type PaginatedResponse = PaginationResultV1<StorageLocation>;

const STORAGE_LOCATIONS_LIST_QUERY = `
  query StorageLocations($filter: StorageLocationFilterInput, $pagination: FarmPaginationInput) {
    storageLocations(filter: $filter, pagination: $pagination) {
      items {
        id
        tenantId
        siteId
        name
        code
        type
        description
        capacity
        capacityUnit
        usedCapacity
        temperatureMin
        temperatureMax
        humidityMin
        humidityMax
        isActive
        createdAt
        updatedAt
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

const STORAGE_LOCATION_QUERY = `
  query StorageLocation($id: ID!) {
    storageLocation(id: $id) {
      id
      tenantId
      siteId
      name
      code
      type
      description
      capacity
      capacityUnit
      usedCapacity
      temperatureMin
      temperatureMax
      humidityMin
      humidityMax
      isActive
      createdAt
      updatedAt
    }
  }
`;

const CREATE_STORAGE_LOCATION_MUTATION = `
  mutation CreateStorageLocation($input: CreateStorageLocationInput!) {
    createStorageLocation(input: $input) {
      id
      name
      code
      type
      isActive
    }
  }
`;

const UPDATE_STORAGE_LOCATION_MUTATION = `
  mutation UpdateStorageLocation($input: UpdateStorageLocationInput!) {
    updateStorageLocation(input: $input) {
      id
      name
      code
      type
      isActive
    }
  }
`;

const DELETE_STORAGE_LOCATION_MUTATION = `
  mutation DeleteStorageLocation($id: ID!) {
    deleteStorageLocation(id: $id)
  }
`;

export function useStorageLocationList(filter?: {
  type?: StorageLocationType;
  siteId?: string;
  isActive?: boolean;
  search?: string;
}) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'storageLocations', 'list', filter),
    queryFn: async () => {
      const data = await graphqlClient.request<{ storageLocations: PaginatedResponse }>(
        STORAGE_LOCATIONS_LIST_QUERY,
        { filter, pagination: { page: 1, limit: 100 } }
      );
      return data.storageLocations;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId,
  });
}

export function useStorageLocation(id: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'storageLocations', 'detail', id),
    queryFn: async () => {
      const data = await graphqlClient.request<{ storageLocation: StorageLocation }>(
        STORAGE_LOCATION_QUERY,
        { id }
      );
      return data.storageLocation;
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!id,
  });
}

export function useCreateStorageLocation() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateStorageLocationInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ createStorageLocation: StorageLocation }>(
        CREATE_STORAGE_LOCATION_MUTATION,
        { input }
      );
      return data.createStorageLocation;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageLocations', 'list') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageOverview') });
    },
  });
}

export function useUpdateStorageLocation() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateStorageLocationInput) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ updateStorageLocation: StorageLocation }>(
        UPDATE_STORAGE_LOCATION_MUTATION,
        { input }
      );
      return data.updateStorageLocation;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageLocations', 'list') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageLocations', 'detail', variables.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageOverview') });
    },
  });
}

export function useDeleteStorageLocation() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) throw new Error('Authentication required. Please login first.');
      if (!tenantId) throw new Error('Tenant context required. Please re-login.');
      const data = await graphqlClient.request<{ deleteStorageLocation: boolean }>(
        DELETE_STORAGE_LOCATION_MUTATION,
        { id }
      );
      return data.deleteStorageLocation;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageLocations', 'list') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'storageOverview') });
    },
  });
}
