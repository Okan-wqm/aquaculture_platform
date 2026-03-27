/**
 * Parameter Config hooks for farm-module
 * Handles CRUD operations for water quality parameter configurations via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// ============================================================================
// TYPES
// ============================================================================

export type ParameterDataType = 'number' | 'enum' | 'boolean';

export type ParameterGroup =
  | 'basic'
  | 'nitrogen_cycle'
  | 'metals'
  | 'biological'
  | 'organic'
  | 'custom';

export interface ParameterConfig {
  id: string;
  code: string;
  name: string;
  unit: string;
  dataType: ParameterDataType;
  precision: number;
  group: ParameterGroup;
  optimalMin: number | null;
  optimalMax: number | null;
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
  speciesLimits: Record<string, unknown> | null;
  enumValues: string[] | null;
  chartColor: string;
  icon: string | null;
  displayOrder: number;
  isVisible: boolean;
  isRequired: boolean;
  isActive: boolean;
  chartAxisGroup: string | null;
  isQuickAccess: boolean;
  templateSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParameterTemplate {
  templateId: string;
  name: string;
  description: string;
  species: string[];
  parameterCount: number;
  parameterCodes: string[];
}

export interface ParameterConfigFilter {
  group?: ParameterGroup;
  isActive?: boolean;
  isVisible?: boolean;
}

export interface CreateParameterConfigInput {
  code: string;
  name: string;
  unit: string;
  dataType: ParameterDataType;
  precision?: number;
  group: ParameterGroup;
  optimalMin?: number;
  optimalMax?: number;
  warningMin?: number;
  warningMax?: number;
  criticalMin?: number;
  criticalMax?: number;
  chartColor?: string;
  enumValues?: string[];
  displayOrder?: number;
  isVisible?: boolean;
  isRequired?: boolean;
  isActive?: boolean;
  chartAxisGroup?: string;
}

export interface UpdateParameterConfigInput {
  id: string;
  code?: string;
  name?: string;
  unit?: string;
  dataType?: ParameterDataType;
  precision?: number;
  group?: ParameterGroup;
  optimalMin?: number | null;
  optimalMax?: number | null;
  warningMin?: number | null;
  warningMax?: number | null;
  criticalMin?: number | null;
  criticalMax?: number | null;
  chartColor?: string;
  enumValues?: string[] | null;
  displayOrder?: number;
  isVisible?: boolean;
  isRequired?: boolean;
  isActive?: boolean;
  chartAxisGroup?: string | null;
  isQuickAccess?: boolean;
}

export interface ReorderInput {
  id: string;
  displayOrder: number;
}

// ============================================================================
// GRAPHQL QUERIES
// ============================================================================

const PARAMETER_CONFIG_FRAGMENT = `
  id
  code
  name
  unit
  dataType
  precision
  group
  optimalMin
  optimalMax
  warningMin
  warningMax
  criticalMin
  criticalMax
  speciesLimits
  enumValues
  chartColor
  icon
  displayOrder
  isVisible
  isRequired
  isActive
  chartAxisGroup
  isQuickAccess
  templateSource
  createdAt
  updatedAt
`;

const GET_PARAMETER_CONFIGS = `
  query ParameterConfigs($filter: ParameterConfigFilterInput) {
    parameterConfigs(filter: $filter) {
      ${PARAMETER_CONFIG_FRAGMENT}
    }
  }
`;

const GET_PARAMETER_CONFIG = `
  query ParameterConfig($id: ID!) {
    parameterConfig(id: $id) {
      ${PARAMETER_CONFIG_FRAGMENT}
    }
  }
`;

const GET_PARAMETER_CONFIG_BY_CODE = `
  query ParameterConfigByCode($code: String!) {
    parameterConfigByCode(code: $code) {
      ${PARAMETER_CONFIG_FRAGMENT}
    }
  }
`;

const GET_PARAMETER_TEMPLATES = `
  query ParameterTemplates {
    parameterTemplates {
      templateId
      name
      description
      species
      parameterCount
      parameterCodes
    }
  }
`;

const CREATE_PARAMETER_CONFIG = `
  mutation CreateParameterConfig($input: CreateParameterConfigInput!) {
    createParameterConfig(input: $input) {
      ${PARAMETER_CONFIG_FRAGMENT}
    }
  }
`;

const UPDATE_PARAMETER_CONFIG = `
  mutation UpdateParameterConfig($input: UpdateParameterConfigInput!) {
    updateParameterConfig(input: $input) {
      ${PARAMETER_CONFIG_FRAGMENT}
    }
  }
`;

const DELETE_PARAMETER_CONFIG = `
  mutation DeleteParameterConfig($id: ID!) {
    deleteParameterConfig(id: $id)
  }
`;

const APPLY_PARAMETER_TEMPLATE = `
  mutation ApplyParameterTemplate($input: ApplyParameterTemplateInput!) {
    applyParameterTemplate(input: $input) {
      ${PARAMETER_CONFIG_FRAGMENT}
    }
  }
`;

const REORDER_PARAMETER_CONFIGS = `
  mutation ReorderParameterConfigs($input: ReorderParameterConfigsInput!) {
    reorderParameterConfigs(input: $input) {
      ${PARAMETER_CONFIG_FRAGMENT}
    }
  }
`;

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Fetch parameter configs list with optional filtering
 */
export function useParameterConfigList(filter?: ParameterConfigFilter) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['parameterConfigs', 'list', filter],
    queryFn: async () => {
      const response = await graphqlClient.request<{
        parameterConfigs: ParameterConfig[];
      }>(GET_PARAMETER_CONFIGS, { filter });
      return response.parameterConfigs;
    },
    enabled: !!token,
    staleTime: 300000, // 5 min — matches backend cache TTL
  });
}

/**
 * Fetch single parameter config by ID
 */
export function useParameterConfig(id: string | null) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['parameterConfigs', 'detail', id],
    queryFn: async () => {
      if (!id) return null;
      const response = await graphqlClient.request<{
        parameterConfig: ParameterConfig;
      }>(GET_PARAMETER_CONFIG, { id });
      return response.parameterConfig;
    },
    enabled: !!token && !!id,
    staleTime: 300000,
  });
}

/**
 * Fetch single parameter config by code
 */
export function useParameterConfigByCode(code: string | null) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['parameterConfigs', 'byCode', code],
    queryFn: async () => {
      if (!code) return null;
      const response = await graphqlClient.request<{
        parameterConfigByCode: ParameterConfig;
      }>(GET_PARAMETER_CONFIG_BY_CODE, { code });
      return response.parameterConfigByCode;
    },
    enabled: !!token && !!code,
    staleTime: 300000,
  });
}

/**
 * Fetch available parameter templates
 */
export function useParameterTemplates() {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['parameterConfigs', 'templates'],
    queryFn: async () => {
      const response = await graphqlClient.request<{
        parameterTemplates: ParameterTemplate[];
      }>(GET_PARAMETER_TEMPLATES, {});
      return response.parameterTemplates;
    },
    enabled: !!token,
    staleTime: 300000,
  });
}

/**
 * Create parameter config mutation
 */
export function useCreateParameterConfig() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateParameterConfigInput) => {
      const response = await graphqlClient.request<{
        createParameterConfig: ParameterConfig;
      }>(CREATE_PARAMETER_CONFIG, { input });
      return response.createParameterConfig;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parameterConfigs'] });
    },
  });
}

/**
 * Update parameter config mutation
 */
export function useUpdateParameterConfig() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateParameterConfigInput) => {
      const response = await graphqlClient.request<{
        updateParameterConfig: ParameterConfig;
      }>(UPDATE_PARAMETER_CONFIG, { input });
      return response.updateParameterConfig;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['parameterConfigs'] });
    },
  });
}

/**
 * Delete parameter config mutation
 */
export function useDeleteParameterConfig() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await graphqlClient.request<{
        deleteParameterConfig: boolean;
      }>(DELETE_PARAMETER_CONFIG, { id });
      return response.deleteParameterConfig;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parameterConfigs'] });
    },
  });
}

/**
 * Apply a parameter template mutation
 */
export function useApplyParameterTemplate() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { templateId: string; overwrite: boolean }) => {
      const response = await graphqlClient.request<{
        applyParameterTemplate: ParameterConfig[];
      }>(APPLY_PARAMETER_TEMPLATE, { input });
      return response.applyParameterTemplate;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parameterConfigs'] });
    },
  });
}

/**
 * Reorder parameter configs mutation
 */
export function useReorderParameterConfigs() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orderedIds: string[]) => {
      const response = await graphqlClient.request<{
        reorderParameterConfigs: ParameterConfig[];
      }>(REORDER_PARAMETER_CONFIGS, { input: { orderedIds } });
      return response.reorderParameterConfigs;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parameterConfigs'] });
    },
  });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get display label for a parameter group
 */
export function getGroupLabel(group: ParameterGroup): string {
  switch (group) {
    case 'basic':
      return 'Temel Parametreler';
    case 'nitrogen_cycle':
      return 'Azot Dongüsü';
    case 'metals':
      return 'Metaller';
    case 'biological':
      return 'Biyolojik';
    case 'organic':
      return 'Organik';
    case 'custom':
      return 'Özel';
    default:
      return group;
  }
}

/**
 * Get Tailwind color class for a parameter group
 */
export function getGroupColor(group: ParameterGroup): string {
  switch (group) {
    case 'basic':
      return 'text-blue-600 bg-blue-100';
    case 'nitrogen_cycle':
      return 'text-green-600 bg-green-100';
    case 'metals':
      return 'text-gray-600 bg-gray-100';
    case 'biological':
      return 'text-purple-600 bg-purple-100';
    case 'organic':
      return 'text-amber-600 bg-amber-100';
    case 'custom':
      return 'text-teal-600 bg-teal-100';
    default:
      return 'text-gray-600 bg-gray-100';
  }
}

/** Dropdown options for parameter groups */
export const GROUP_OPTIONS: { value: ParameterGroup; label: string }[] = [
  { value: 'basic', label: 'Temel Parametreler' },
  { value: 'nitrogen_cycle', label: 'Azot Dongüsü' },
  { value: 'metals', label: 'Metaller' },
  { value: 'biological', label: 'Biyolojik' },
  { value: 'organic', label: 'Organik' },
  { value: 'custom', label: 'Özel' },
];

/** Dropdown options for parameter data types */
export const DATA_TYPE_OPTIONS: { value: ParameterDataType; label: string }[] = [
  { value: 'number', label: 'Sayısal' },
  { value: 'enum', label: 'Seçenek Listesi' },
  { value: 'boolean', label: 'Evet/Hayır' },
];
