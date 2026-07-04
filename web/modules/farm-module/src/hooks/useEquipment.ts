/**
 * Equipment hooks for farm-module
 * Handles CRUD operations for equipment via GraphQL API
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  useTenantQuery,
  type SpecificationSchema,
} from '@aquaculture/shared-ui';

// Types
export interface EquipmentType {
  id: string;
  name: string;
  code: string;
  category: string;
  description?: string;
  icon?: string;
  specificationSchema?: SpecificationSchema;
  isActive: boolean;
}

export interface EquipmentSystemInfo {
  id: string;
  systemId: string;
  systemName?: string;
  systemCode?: string;
  isPrimary?: boolean;
  role?: string;
  criticalityLevel?: number;
  notes?: string;
}

export interface EquipmentSummary {
  id: string;
  name: string;
  code: string;
  status: string;
  equipmentType?: {
    id: string;
    name: string;
    code: string;
    category: string;
  };
}

export interface Equipment {
  id: string;
  name: string;
  code: string;
  description?: string;
  status: string;
  equipmentTypeId: string;
  equipmentType?: EquipmentType;
  departmentId: string;
  department?: {
    id: string;
    name: string;
    siteId?: string;
  };
  systems?: EquipmentSystemInfo[];
  systemIds?: string[];
  // Parent/Child equipment hierarchy
  parentEquipmentId?: string;
  parentEquipment?: EquipmentSummary;
  childEquipment?: EquipmentSummary[];
  subEquipmentCount?: number;
  // Details
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  specifications?: Record<string, unknown>;
  purchaseDate?: string;
  installationDate?: string;
  warrantyEndDate?: string;
  purchasePrice?: number;
  supplierId?: string;
  notes?: string;
  isActive: boolean;
  isVisibleInSensor?: boolean;
  // Linked temperature sensor (sensor-service sensors.id) driving the feed rate.
  temperatureSensorId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateEquipmentInput {
  name: string;
  code: string;
  departmentId?: string;
  systemIds?: string[];
  equipmentTypeId?: string;
  parentEquipmentId?: string;
  supplierId?: string;
  description?: string;
  serialNumber?: string;
  model?: string;
  manufacturer?: string;
  specifications?: Record<string, unknown>;
  purchaseDate?: string;
  installationDate?: string;
  warrantyEndDate?: string;
  purchasePrice?: number;
  currency?: string;
  status?: string;
  notes?: string;
  isVisibleInSensor?: boolean;
  // Linked temperature sensor (sensor-service sensors.id) driving the feed rate.
  temperatureSensorId?: string;
}

export interface UpdateEquipmentInput extends Partial<CreateEquipmentInput> {
  id: string;
}

interface PaginatedResponse {
  items: Equipment[];
  total: number;
  page: number;
  limit: number;
}

// GraphQL queries
const EQUIPMENT_LIST_QUERY = `
  query EquipmentList($filter: EquipmentFilterInput, $pagination: FarmPaginationInput) {
    equipmentList(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        code
        description
        status
        equipmentTypeId
        equipmentType {
          id
          name
          code
          category
          icon
        }
        departmentId
        department {
          id
          name
          siteId
        }
        systemIds
        systems {
          id
          systemId
          systemName
          systemCode
          isPrimary
          criticalityLevel
        }
        parentEquipmentId
        parentEquipment {
          id
          name
          code
          status
          equipmentType {
            id
            name
            code
            category
          }
        }
        childEquipment {
          id
          name
          code
          status
          equipmentType {
            id
            name
            code
            category
          }
        }
        subEquipmentCount
        manufacturer
        model
        serialNumber
        specifications
        supplierId
        purchaseDate
        installationDate
        warrantyEndDate
        purchasePrice
        notes
        isActive
        isVisibleInSensor
        temperatureSensorId
        createdAt
        updatedAt
      }
      total
      page
      limit
    }
  }
`;

const EQUIPMENT_TYPES_QUERY = `
  query EquipmentTypes {
    equipmentTypes {
      id
      name
      code
      category
      description
      icon
      specificationSchema
      isActive
    }
  }
`;

const CREATE_EQUIPMENT_MUTATION = `
  mutation CreateEquipment($input: CreateEquipmentInput!) {
    createEquipment(input: $input) {
      id
      name
      code
      status
      systemIds
      systems {
        id
        systemId
        systemName
        isPrimary
      }
      equipmentType {
        id
        name
        code
        category
      }
      parentEquipmentId
      parentEquipment {
        id
        name
        code
      }
      subEquipmentCount
    }
  }
`;

const UPDATE_EQUIPMENT_MUTATION = `
  mutation UpdateEquipment($input: UpdateEquipmentInput!) {
    updateEquipment(input: $input) {
      id
      name
      code
      status
      equipmentTypeId
      equipmentType {
        id
        name
        code
        category
      }
      departmentId
      department {
        id
        name
        siteId
      }
      systemIds
      systems {
        id
        systemId
        systemName
        isPrimary
      }
      parentEquipmentId
      parentEquipment {
        id
        name
        code
      }
      subEquipmentCount
      manufacturer
      model
      serialNumber
      specifications
      supplierId
      purchaseDate
      warrantyEndDate
      isVisibleInSensor
      temperatureSensorId
    }
  }
`;

const DELETE_EQUIPMENT_MUTATION = `
  mutation DeleteEquipment($id: ID!, $cascade: Boolean!) {
    deleteEquipment(id: $id, cascade: $cascade)
  }
`;

const EQUIPMENT_DELETE_PREVIEW_QUERY = `
  query EquipmentDeletePreview($id: ID!) {
    equipmentDeletePreview(id: $id) {
      equipment {
        id
        name
        code
      }
      canDelete
      blockers
      affectedItems {
        childEquipment {
          id
          name
          code
          status
        }
        subEquipment {
          id
          name
          code
          status
        }
        totalCount
      }
    }
  }
`;

// graphqlClient from shared-ui handles token/tenantId automatically

function isTenantEquipmentQuery(queryKey: readonly unknown[], tenantId?: string | null): boolean {
  return queryKey[0] === 'tenant' && queryKey[1] === tenantId && queryKey[2] === 'equipment';
}

/**
 * Hook to fetch equipment list
 */
export function useEquipmentList(filter?: {
  departmentId?: string;
  siteId?: string;
  systemId?: string;
  equipmentTypeId?: string;
  status?: string;
  isActive?: boolean;
  search?: string;
}) {
  return useTenantQuery(
    ['equipment', 'list', filter],
    async () => {
      const data = await graphqlClient.request<{ equipmentList: PaginatedResponse }>(
        EQUIPMENT_LIST_QUERY,
        { filter, pagination: { page: 1, limit: 100 } },
      );
      return data.equipmentList;
    },
    { staleTime: 30000 },
  );
}

/**
 * Hook to fetch equipment types
 */
export function useEquipmentTypes() {
  // Per-tenant catalog (no @SkipTenantGuard) — useTenantQuery enforces the tenant
  // prefix + the token/tenant enabled gate + keep-previous-data, so this hook no
  // longer hand-rolls them.
  return useTenantQuery(
    ['equipment', 'types'],
    async () => {
      const data = await graphqlClient.request<{ equipmentTypes: EquipmentType[] }>(
        EQUIPMENT_TYPES_QUERY,
        {},
      );
      return data.equipmentTypes;
    },
    { staleTime: 60000 },
  );
}

/**
 * Hook to create equipment
 */
export function useCreateEquipment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateEquipmentInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ createEquipment: Equipment }>(
        CREATE_EQUIPMENT_MUTATION,
        { input },
      );
      return data.createEquipment;
    },
    onSuccess: () => {
      // Use predicate to match all equipment list queries regardless of filter
      queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) && isTenantEquipmentQuery(query.queryKey, tenantId),
      });
    },
  });
}

/**
 * Hook to update equipment
 */
export function useUpdateEquipment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateEquipmentInput) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ updateEquipment: Equipment }>(
        UPDATE_EQUIPMENT_MUTATION,
        { input },
      );
      return data.updateEquipment;
    },
    onSuccess: () => {
      // Use predicate to match all equipment list queries regardless of filter
      queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) && isTenantEquipmentQuery(query.queryKey, tenantId),
      });
    },
  });
}

// Delete Preview Types
export interface EquipmentDeletePreviewResult {
  equipment: { id: string; name: string; code: string };
  canDelete: boolean;
  blockers: string[];
  affectedItems: {
    childEquipment: Array<{ id: string; name: string; code: string; status: string }>;
    subEquipment: Array<{ id: string; name: string; code: string; status: string }>;
    totalCount: number;
  };
}

/**
 * Hook to get equipment delete preview
 */
export function useEquipmentDeletePreview(id: string | null) {
  return useTenantQuery(
    ['equipment', 'deletePreview', id],
    async () => {
      const data = await graphqlClient.request<{
        equipmentDeletePreview: EquipmentDeletePreviewResult;
      }>(EQUIPMENT_DELETE_PREVIEW_QUERY, { id });
      return data.equipmentDeletePreview;
    },
    // token+tenant gate is added by useTenantQuery; !!id is ANDed on top.
    { staleTime: 0, enabled: !!id },
  );
}

/**
 * Hook to delete equipment
 * @param cascade - If true, cascade delete all related items
 */
export function useDeleteEquipment() {
  const { token, tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, cascade = false }: { id: string; cascade?: boolean }) => {
      if (!token) {
        throw new Error('Authentication required. Please login first.');
      }
      if (!tenantId) {
        throw new Error('Tenant context required. Please re-login.');
      }
      const data = await graphqlClient.request<{ deleteEquipment: boolean }>(
        DELETE_EQUIPMENT_MUTATION,
        { id, cascade },
      );
      return data.deleteEquipment;
    },
    onSuccess: () => {
      // Use predicate to match all equipment list queries regardless of filter
      queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) && isTenantEquipmentQuery(query.queryKey, tenantId),
      });
    },
  });
}
