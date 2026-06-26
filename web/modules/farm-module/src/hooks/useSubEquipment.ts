/**
 * SubEquipment hooks
 *
 * Exposes the `createSubEquipment`, `updateSubEquipment`, and
 * `deleteSubEquipment` mutations plus a list query so the
 * SetupPage > EquipmentTab > equipment-detail area can surface
 * the sub-equipment CRUD flow. Phase 3 Tier 1 + Tier 3
 * sub-equipment CRUD of the "Farm modülü kalan kör noktalar" plan.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  createTenantQueryKey,
} from '@aquaculture/shared-ui';

export type EquipmentStatus =
  | 'ACTIVE'
  | 'MAINTENANCE'
  | 'RETIRED'
  | 'INACTIVE';

export interface SubEquipment {
  id: string;
  parentEquipmentId: string;
  subEquipmentTypeId: string;
  name: string;
  code: string;
  description?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  status?: EquipmentStatus;
  specifications?: Record<string, unknown>;
  installationDate?: string;
  notes?: string;
  isActive: boolean;
  subEquipmentType?: {
    id: string;
    name: string;
  };
}

export interface CreateSubEquipmentInput {
  parentEquipmentId: string;
  subEquipmentTypeId: string;
  name: string;
  code: string;
  description?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  status?: EquipmentStatus;
  specifications?: Record<string, unknown>;
  installationDate?: string;
  notes?: string;
}

export interface UpdateSubEquipmentInput {
  id: string;
  name?: string;
  code?: string;
  description?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  status?: EquipmentStatus;
  specifications?: Record<string, unknown>;
  installationDate?: string;
  notes?: string;
  isActive?: boolean;
}

export interface SubEquipmentTypeOption {
  id: string;
  name: string;
  code: string;
  description?: string;
}

const LIST_SUB_EQUIPMENT_TYPES_QUERY = `
  query ListSubEquipmentTypes($filter: SubEquipmentTypeFilterInput) {
    subEquipmentTypes(filter: $filter) {
      id
      name
      code
      description
    }
  }
`;

const LIST_SUB_EQUIPMENT_BY_PARENT_QUERY = `
  query ListSubEquipmentByParent($parentEquipmentId: ID!, $includeInactive: Boolean) {
    subEquipmentByParent(parentEquipmentId: $parentEquipmentId, includeInactive: $includeInactive) {
      id
      parentEquipmentId
      subEquipmentTypeId
      name
      code
      description
      manufacturer
      model
      serialNumber
      status
      specifications
      installationDate
      notes
      isActive
      subEquipmentType {
        id
        name
      }
    }
  }
`;

const CREATE_SUB_EQUIPMENT_MUTATION = `
  mutation CreateSubEquipment($input: CreateSubEquipmentInput!) {
    createSubEquipment(input: $input) {
      id
      parentEquipmentId
      name
      code
    }
  }
`;

const UPDATE_SUB_EQUIPMENT_MUTATION = `
  mutation UpdateSubEquipment($input: UpdateSubEquipmentInput!) {
    updateSubEquipment(input: $input) {
      id
      name
      code
      status
      isActive
    }
  }
`;

const DELETE_SUB_EQUIPMENT_MUTATION = `
  mutation DeleteSubEquipment($id: ID!) {
    deleteSubEquipment(id: $id)
  }
`;

export function useSubEquipmentTypes(
  compatibleWithEquipmentType?: string,
) {
  const { tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(
      tenantId,
      'subEquipmentTypes',
      compatibleWithEquipmentType ?? 'all',
    ),
    queryFn: async () => {
      const data = await graphqlClient.request<{
        subEquipmentTypes: SubEquipmentTypeOption[];
      }>(LIST_SUB_EQUIPMENT_TYPES_QUERY, {
        filter: compatibleWithEquipmentType
          ? { compatibleWithEquipmentType, isActive: true }
          : { isActive: true },
      });
      return data.subEquipmentTypes;
    },
    enabled: !!tenantId,
  });
}

export function useSubEquipmentByParent(
  parentEquipmentId: string | undefined,
  includeInactive = false,
) {
  const { tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(
      tenantId,
      'subEquipment',
      'byParent',
      parentEquipmentId ?? 'none',
      includeInactive ? 'all' : 'active',
    ),
    queryFn: async () => {
      if (!parentEquipmentId) return [] as SubEquipment[];
      const data = await graphqlClient.request<{
        subEquipmentByParent: SubEquipment[];
      }>(LIST_SUB_EQUIPMENT_BY_PARENT_QUERY, {
        parentEquipmentId,
        includeInactive,
      });
      return data.subEquipmentByParent;
    },
    enabled: !!tenantId && !!parentEquipmentId,
  });
}

export function useCreateSubEquipment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateSubEquipmentInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{
        createSubEquipment: SubEquipment;
      }>(CREATE_SUB_EQUIPMENT_MUTATION, { input });
      return data.createSubEquipment;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(
          tenantId,
          'subEquipment',
          'byParent',
          variables.parentEquipmentId,
        ),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'equipment'),
      });
    },
  });
}

export function useUpdateSubEquipment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateSubEquipmentInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{
        updateSubEquipment: SubEquipment;
      }>(UPDATE_SUB_EQUIPMENT_MUTATION, { input });
      return data.updateSubEquipment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'subEquipment'),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'equipment'),
      });
    },
  });
}

export function useDeleteSubEquipment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ deleteSubEquipment: boolean }>(
        DELETE_SUB_EQUIPMENT_MUTATION,
        { id },
      );
      return data.deleteSubEquipment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'subEquipment'),
      });
      queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'equipment'),
      });
    },
  });
}
