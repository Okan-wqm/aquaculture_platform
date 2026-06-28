/**
 * Parameter-Equipment Mapping hooks for farm-module
 * Handles CRUD + bulk operations for mapping water quality parameters to equipment via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

// ============================================================================
// TYPES
// ============================================================================

export type MonitoringFrequency = 'CONTINUOUS' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'ON_DEMAND';

export interface ParamEquipmentMapping {
  id: string;
  tenantId: string;
  parameterConfigId: string;
  equipmentId: string;
  isActive: boolean;
  monitoringFrequency: MonitoringFrequency;
  sensorId: string | null;
  alertEnabled: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  parameterConfig?: {
    id: string;
    code: string;
    name: string;
    unit: string;
    chartColor: string;
  };
  equipment?: {
    id: string;
    name: string;
    code: string;
  };
}

export interface CreateParamEquipmentInput {
  parameterConfigId: string;
  equipmentId: string;
  monitoringFrequency: MonitoringFrequency;
  sensorId?: string;
  alertEnabled?: boolean;
  notes?: string;
  isActive?: boolean;
}

export interface UpdateParamEquipmentInput {
  id: string;
  monitoringFrequency?: MonitoringFrequency;
  sensorId?: string | null;
  alertEnabled?: boolean;
  notes?: string | null;
  isActive?: boolean;
}

export interface BulkMapParamsEquipmentInput {
  equipmentId: string;
  parameterConfigIds: string[];
  monitoringFrequency: MonitoringFrequency;
  alertEnabled?: boolean;
}

export interface ParamEquipmentMappingFilter {
  equipmentId?: string;
  parameterConfigId?: string;
}

// ============================================================================
// GRAPHQL QUERIES & MUTATIONS
// ============================================================================

const MAPPING_FRAGMENT = `
  id
  tenantId
  parameterConfigId
  equipmentId
  isActive
  monitoringFrequency
  sensorId
  alertEnabled
  notes
  createdAt
  updatedAt
  parameterConfig {
    id
    code
    name
    unit
    chartColor
  }
  equipment {
    id
    name
    code
  }
`;

const GET_PARAM_EQUIPMENT_MAPPINGS = `
  query ParameterEquipmentMappings($equipmentId: ID, $parameterConfigId: ID) {
    parameterEquipmentMappings(equipmentId: $equipmentId, parameterConfigId: $parameterConfigId) {
      ${MAPPING_FRAGMENT}
    }
  }
`;

const GET_EQUIPMENT_PARAMETERS = `
  query EquipmentParameters($equipmentId: ID!) {
    equipmentParameters(equipmentId: $equipmentId) {
      ${MAPPING_FRAGMENT}
    }
  }
`;

const CREATE_PARAM_EQUIPMENT_MAPPING = `
  mutation CreateParamEquipmentMapping($input: CreateParamEquipmentInput!) {
    createParamEquipmentMapping(input: $input) {
      ${MAPPING_FRAGMENT}
    }
  }
`;

const UPDATE_PARAM_EQUIPMENT_MAPPING = `
  mutation UpdateParamEquipmentMapping($input: UpdateParamEquipmentInput!) {
    updateParamEquipmentMapping(input: $input) {
      ${MAPPING_FRAGMENT}
    }
  }
`;

const DELETE_PARAM_EQUIPMENT_MAPPING = `
  mutation DeleteParamEquipmentMapping($id: ID!) {
    deleteParamEquipmentMapping(id: $id)
  }
`;

const BULK_MAP_PARAMS_TO_EQUIPMENT = `
  mutation BulkMapParamsToEquipment($input: BulkMapParamsEquipmentInput!) {
    bulkMapParamsToEquipment(input: $input) {
      ${MAPPING_FRAGMENT}
    }
  }
`;

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Fetch parameter-equipment mappings with optional filtering by equipmentId or parameterConfigId
 */
export function useParamEquipmentMappings(filters?: ParamEquipmentMappingFilter) {
  const { token } = useAuth();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'paramEquipmentMappings', 'list', filters),
    queryFn: async () => {
      const response = await graphqlClient.request<{
        parameterEquipmentMappings: ParamEquipmentMapping[];
      }>(GET_PARAM_EQUIPMENT_MAPPINGS, {
        equipmentId: filters?.equipmentId,
        parameterConfigId: filters?.parameterConfigId,
    enabled: !!tenantId,
      });
      return response.parameterEquipmentMappings;
    },
    enabled: !!token,
    staleTime: 300000, // 5 min
  });
}

/**
 * Fetch all parameter mappings for a specific equipment item
 */
export function useEquipmentParameters(equipmentId: string | null) {
  const { tenantId } = useAuth();
  const { token } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'paramEquipmentMappings', 'equipment', equipmentId),
    queryFn: async () => {
      if (!equipmentId) return [];
      const response = await graphqlClient.request<{
        equipmentParameters: ParamEquipmentMapping[];
      }>(GET_EQUIPMENT_PARAMETERS, { equipmentId });
      return response.equipmentParameters;
    },
    enabled: !!token && !!equipmentId,
    staleTime: 300000, // 5 min
  });
}

/**
 * Create a new parameter-equipment mapping
 */
export function useCreateParamEquipmentMapping() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: CreateParamEquipmentInput) => {
      const response = await graphqlClient.request<{
        createParamEquipmentMapping: ParamEquipmentMapping;
      }>(CREATE_PARAM_EQUIPMENT_MAPPING, { input });
      return response.createParamEquipmentMapping;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'paramEquipmentMappings') });
    },
  });
}

/**
 * Update an existing parameter-equipment mapping
 */
export function useUpdateParamEquipmentMapping() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: UpdateParamEquipmentInput) => {
      const response = await graphqlClient.request<{
        updateParamEquipmentMapping: ParamEquipmentMapping;
      }>(UPDATE_PARAM_EQUIPMENT_MAPPING, { input });
      return response.updateParamEquipmentMapping;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'paramEquipmentMappings') });
    },
  });
}

/**
 * Delete a parameter-equipment mapping
 */
export function useDeleteParamEquipmentMapping() {
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await graphqlClient.request<{
        deleteParamEquipmentMapping: boolean;
      }>(DELETE_PARAM_EQUIPMENT_MAPPING, { id });
      return response.deleteParamEquipmentMapping;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'paramEquipmentMappings') });
    },
  });
}

/**
 * Bulk-map multiple parameters to a single equipment item
 */
export function useBulkMapParamsToEquipment() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: BulkMapParamsEquipmentInput) => {
      const response = await graphqlClient.request<{
        bulkMapParamsToEquipment: ParamEquipmentMapping[];
      }>(BULK_MAP_PARAMS_TO_EQUIPMENT, { input });
      return response.bulkMapParamsToEquipment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'paramEquipmentMappings') });
    },
  });
}

// ============================================================================
// UTILITY CONSTANTS
// ============================================================================

export const MONITORING_FREQUENCY_OPTIONS: {
  value: MonitoringFrequency;
  label: string;
}[] = [
  { value: 'CONTINUOUS', label: 'Continuous' },
  { value: 'HOURLY', label: 'Hourly' },
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'ON_DEMAND', label: 'On Demand' },
];

export function getFrequencyLabel(frequency: MonitoringFrequency): string {
  const found = MONITORING_FREQUENCY_OPTIONS.find((o) => o.value === frequency);
  return found?.label ?? frequency;
}

/**
 * All equipment categories available for parameter-to-equipment mapping.
 * Must include every EquipmentCategory from the backend enum so that
 * all equipment visible in the Record tab can also be mapped in Parameters.
 */
export const EQUIPMENT_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'TANK', label: 'Tank' },
  { value: 'POND', label: 'Pond' },
  { value: 'CAGE', label: 'Cage' },
  { value: 'FILTRATION', label: 'Filtration' },
  { value: 'WATER_TREATMENT', label: 'Water Treatment' },
  { value: 'AERATION', label: 'Aeration' },
  { value: 'PUMP', label: 'Pump' },
  { value: 'MONITORING', label: 'Monitoring' },
  { value: 'HEATING_COOLING', label: 'Heating / Cooling' },
  { value: 'FEEDING', label: 'Feeding' },
  { value: 'HARVESTING', label: 'Harvesting' },
  { value: 'TRANSPORT', label: 'Transport' },
  { value: 'ELECTRICAL', label: 'Electrical' },
  { value: 'PLUMBING', label: 'Plumbing' },
  { value: 'SAFETY', label: 'Safety' },
  { value: 'OTHER', label: 'Other' },
];
