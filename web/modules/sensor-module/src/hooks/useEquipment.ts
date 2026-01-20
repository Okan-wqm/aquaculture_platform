/**
 * Equipment hooks for fetching equipment data from farm-service GraphQL API
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@aquaculture/shared-ui';
import {
  EQUIPMENT_LIST_QUERY,
  EQUIPMENT_TYPES_QUERY,
  EQUIPMENT_BY_ID_QUERY,
  EQUIPMENT_BY_DEPARTMENT_QUERY,
} from '../graphql/equipment.queries';

// Types
export interface EquipmentType {
  id: string;
  name: string;
  code: string;
  description?: string;
  category: string;
  icon?: string;
  isActive: boolean;
  sortOrder: number;
}

export interface Department {
  id: string;
  name: string;
  code?: string;
}

export interface Equipment {
  id: string;
  name: string;
  code: string;
  description?: string;
  status: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  isTank: boolean;
  volume?: number;
  isVisibleInSensor?: boolean;
  specifications?: Record<string, unknown>;
  location?: {
    building?: string;
    room?: string;
    coordinates?: { x: number; y: number };
  };
  equipmentType: EquipmentType;
  department?: Department;
  subEquipment?: Array<{
    id: string;
    name: string;
    code: string;
    status: string;
  }>;
}

export interface EquipmentFilterInput {
  departmentId?: string;
  siteId?: string;
  equipmentTypeId?: string;
  status?: string;
  isActive?: boolean;
  hasWarranty?: boolean;
  isVisibleInSensor?: boolean;
  search?: string;
}

export interface PaginationInput {
  page?: number;
  limit?: number;
}

interface PaginatedEquipmentResponse {
  items: Equipment[];
  total: number;
  page: number;
  limit: number;
}

// GraphQL fetch helper
async function graphqlFetch<T>(
  query: string,
  variables: Record<string, unknown>,
  token?: string
): Promise<T> {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

/**
 * Hook to fetch paginated equipment list
 */
export function useEquipmentList(
  filter?: EquipmentFilterInput,
  pagination?: PaginationInput
) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['equipmentList', filter, pagination],
    queryFn: async () => {
      const data = await graphqlFetch<{ equipmentList: PaginatedEquipmentResponse }>(
        EQUIPMENT_LIST_QUERY,
        { filter, pagination },
        token
      );
      return data.equipmentList;
    },
    staleTime: 30000, // 30 seconds
    enabled: !!token,
  });
}

/**
 * Hook to fetch equipment types catalog
 */
export function useEquipmentTypes(filter?: { category?: string; isActive?: boolean }) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['equipmentTypes', filter],
    queryFn: async () => {
      const data = await graphqlFetch<{ equipmentTypes: EquipmentType[] }>(
        EQUIPMENT_TYPES_QUERY,
        { filter },
        token
      );
      return data.equipmentTypes;
    },
    staleTime: 60000, // 1 minute - types don't change often
    enabled: !!token,
  });
}

/**
 * Hook to fetch single equipment by ID
 */
export function useEquipment(id: string, includeRelations = false) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['equipment', id, includeRelations],
    queryFn: async () => {
      const data = await graphqlFetch<{ equipment: Equipment }>(
        EQUIPMENT_BY_ID_QUERY,
        { id, includeRelations },
        token
      );
      return data.equipment;
    },
    staleTime: 30000,
    enabled: !!token && !!id,
  });
}

/**
 * Hook to fetch equipment by department
 */
export function useEquipmentByDepartment(departmentId: string) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['equipmentByDepartment', departmentId],
    queryFn: async () => {
      const data = await graphqlFetch<{ equipmentByDepartment: Equipment[] }>(
        EQUIPMENT_BY_DEPARTMENT_QUERY,
        { departmentId },
        token
      );
      return data.equipmentByDepartment;
    },
    staleTime: 30000,
    enabled: !!token && !!departmentId,
  });
}

/**
 * Group equipment by category
 */
export function groupEquipmentByCategory(equipment: Equipment[]): Record<string, Equipment[]> {
  return equipment.reduce((acc, eq) => {
    const category = eq.equipmentType?.category || 'other';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(eq);
    return acc;
  }, {} as Record<string, Equipment[]>);
}

/**
 * Category labels for display
 */
export const CATEGORY_LABELS: Record<string, string> = {
  tank: 'Tanks',
  pump: 'Pumps',
  aeration: 'Aeration',
  filtration: 'Filtration',
  heating_cooling: 'Heating/Cooling',
  feeding: 'Feeding',
  monitoring: 'Monitoring',
  water_treatment: 'Water Treatment',
  harvesting: 'Harvesting',
  transport: 'Transport',
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  safety: 'Safety',
  other: 'Other',
};
