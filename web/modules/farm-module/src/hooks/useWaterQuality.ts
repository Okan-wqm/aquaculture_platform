/**
 * Water Quality hooks for farm-module
 * Handles CRUD operations for water quality measurements via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// ============================================================================
// TYPES
// ============================================================================

export type WaterQualityStatus =
  | 'OPTIMAL'
  | 'ACCEPTABLE'
  | 'WARNING'
  | 'CRITICAL'
  | 'UNKNOWN';

export type MeasurementSource =
  | 'MANUAL'
  | 'SENSOR_AUTOMATIC'
  | 'SENSOR_TRIGGERED'
  | 'LAB_ANALYSIS'
  | 'CALIBRATION';

export interface WaterParameters {
  temperature?: number;
  dissolvedOxygen?: number;
  oxygenSaturation?: number;
  pH?: number;
  salinity?: number;
  conductivity?: number;
  ammonia?: number;
  ammonium?: number;
  totalAmmoniaNitrogen?: number;
  nitrite?: number;
  nitrate?: number;
  alkalinity?: number;
  hardness?: number;
  turbidity?: number;
  transparency?: number;
  co2?: number;
  chlorine?: number;
  hydrogen_sulfide?: number;
  bod?: number;
  cod?: number;
  tss?: number;
  bacteriaCount?: number;
  algaeLevel?: 'none' | 'low' | 'moderate' | 'high' | 'bloom';
}

export interface ParameterEvaluation {
  parameter: string;
  value: number;
  unit: string;
  status: 'OPTIMAL' | 'LOW' | 'HIGH' | 'CRITICAL_LOW' | 'CRITICAL_HIGH' | 'NOT_MEASURED';
  optimalMin?: number;
  optimalMax?: number;
  criticalMin?: number;
  criticalMax?: number;
  message?: string;
}

export interface WaterQualitySummary {
  overallStatus: WaterQualityStatus;
  criticalCount: number;
  warningCount: number;
  optimalCount: number;
  evaluations: ParameterEvaluation[];
  recommendations: string[];
}

export interface WaterQualityMeasurement {
  id: string;
  tenantId: string;
  tankId?: string;
  pondId?: string;
  siteId?: string;
  batchId?: string;
  measuredAt: string;
  source: MeasurementSource;
  measuredBy?: string;
  parameters: WaterParameters;
  temperature?: number;
  dissolvedOxygen?: number;
  pH?: number;
  ammonia?: number;
  nitrite?: number;
  overallStatus: WaterQualityStatus;
  summary?: WaterQualitySummary;
  hasAlarm: boolean;
  notes?: string;
  weatherConditions?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WaterQualityStatistics {
  avgTemperature: number | null;
  avgDO: number | null;
  avgPH: number | null;
  avgAmmonia: number | null;
  avgNitrite: number | null;
  measurementCount: number;
  criticalCount: number;
  warningCount: number;
  lastMeasurement: WaterQualityMeasurement | null;
}

export interface WaterQualityFilters {
  tankId?: string;
  pondId?: string;
  siteId?: string;
  batchId?: string;
  status?: WaterQualityStatus;
  source?: MeasurementSource;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export interface CreateWaterQualityInput {
  tankId?: string;
  pondId?: string;
  siteId?: string;
  batchId?: string;
  measuredAt: string;
  source: MeasurementSource;
  measuredBy?: string;
  parameters: {
    temperature?: number;
    dissolvedOxygen?: number;
    pH?: number;
    ammonia?: number;
    nitrite?: number;
    nitrate?: number;
    salinity?: number;
    turbidity?: number;
    alkalinity?: number;
    hardness?: number;
  };
  notes?: string;
  weatherConditions?: string;
}

export interface UpdateWaterQualityInput {
  id: string;
  parameters?: {
    temperature?: number;
    dissolvedOxygen?: number;
    pH?: number;
    ammonia?: number;
    nitrite?: number;
    nitrate?: number;
    salinity?: number;
    turbidity?: number;
    alkalinity?: number;
    hardness?: number;
  };
  notes?: string;
  weatherConditions?: string;
}

// ============================================================================
// GRAPHQL QUERIES
// ============================================================================

const WATER_QUALITY_FRAGMENT = `
  id
  tenantId
  tankId
  pondId
  siteId
  batchId
  measuredAt
  source
  measuredBy
  parameters
  temperature
  dissolvedOxygen
  pH
  ammonia
  nitrite
  overallStatus
  summary
  hasAlarm
  notes
  weatherConditions
  createdAt
  updatedAt
`;

const GET_WATER_QUALITY_LIST = `
  query WaterQualityMeasurements($filter: WaterQualityFilterInput) {
    waterQualityMeasurements(filter: $filter) {
      items {
        ${WATER_QUALITY_FRAGMENT}
      }
      total
      limit
      offset
      hasMore
    }
  }
`;

const GET_WATER_QUALITY_BY_ID = `
  query WaterQuality($id: ID!) {
    waterQuality(id: $id) {
      ${WATER_QUALITY_FRAGMENT}
    }
  }
`;

const GET_LATEST_WATER_QUALITY = `
  query LatestWaterQuality($tankId: ID!) {
    latestWaterQuality(tankId: $tankId) {
      ${WATER_QUALITY_FRAGMENT}
    }
  }
`;

const GET_CRITICAL_WATER_QUALITY = `
  query CriticalWaterQuality {
    criticalWaterQuality {
      ${WATER_QUALITY_FRAGMENT}
    }
  }
`;

const GET_WATER_QUALITY_CHART = `
  query WaterQualityChart($tankId: ID!, $fromDate: DateTime!, $toDate: DateTime!) {
    waterQualityChart(tankId: $tankId, fromDate: $fromDate, toDate: $toDate) {
      id
      measuredAt
      temperature
      dissolvedOxygen
      pH
      ammonia
      nitrite
      overallStatus
    }
  }
`;

const GET_WATER_QUALITY_STATISTICS = `
  query WaterQualityStatistics($tankId: ID!, $days: Int) {
    waterQualityStatistics(tankId: $tankId, days: $days) {
      avgTemperature
      avgDO
      avgPH
      avgAmmonia
      avgNitrite
      measurementCount
      criticalCount
      warningCount
      lastMeasurement {
        ${WATER_QUALITY_FRAGMENT}
      }
    }
  }
`;

const CREATE_WATER_QUALITY = `
  mutation CreateWaterQualityMeasurement($input: CreateWaterQualityInput!) {
    createWaterQualityMeasurement(input: $input) {
      ${WATER_QUALITY_FRAGMENT}
    }
  }
`;

const UPDATE_WATER_QUALITY = `
  mutation UpdateWaterQualityMeasurement($input: UpdateWaterQualityInput!) {
    updateWaterQualityMeasurement(input: $input) {
      ${WATER_QUALITY_FRAGMENT}
    }
  }
`;

const DELETE_WATER_QUALITY = `
  mutation DeleteWaterQualityMeasurement($id: ID!) {
    deleteWaterQualityMeasurement(id: $id)
  }
`;

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Fetch water quality measurements list
 */
export function useWaterQualityList(filters?: WaterQualityFilters) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['waterQuality', 'list', filters],
    queryFn: async () => {
      const response = await graphqlClient.request<{
        waterQualityMeasurements: {
          items: WaterQualityMeasurement[];
          total: number;
          limit: number;
          offset: number;
          hasMore: boolean;
        };
      }>(GET_WATER_QUALITY_LIST, { filter: filters });
      return response.waterQualityMeasurements;
    },
    enabled: !!token,
  });
}

/**
 * Fetch single water quality measurement by ID
 */
export function useWaterQuality(id: string | null) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['waterQuality', 'detail', id],
    queryFn: async () => {
      if (!id) return null;
      const response = await graphqlClient.request<{
        waterQuality: WaterQualityMeasurement;
      }>(GET_WATER_QUALITY_BY_ID, { id });
      return response.waterQuality;
    },
    enabled: !!token && !!id,
  });
}

/**
 * Fetch latest water quality for a tank
 */
export function useLatestWaterQuality(tankId: string | null) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['waterQuality', 'latest', tankId],
    queryFn: async () => {
      if (!tankId) return null;
      const response = await graphqlClient.request<{
        latestWaterQuality: WaterQualityMeasurement | null;
      }>(GET_LATEST_WATER_QUALITY, { tankId });
      return response.latestWaterQuality;
    },
    enabled: !!token && !!tankId,
    staleTime: 60000, // 1 minute cache
  });
}

/**
 * Fetch critical water quality measurements
 */
export function useCriticalWaterQuality() {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['waterQuality', 'critical'],
    queryFn: async () => {
      const response = await graphqlClient.request<{
        criticalWaterQuality: WaterQualityMeasurement[];
      }>(GET_CRITICAL_WATER_QUALITY, {});
      return response.criticalWaterQuality;
    },
    enabled: !!token,
    refetchInterval: 30000, // Refresh every 30 seconds for critical data
  });
}

/**
 * Fetch water quality chart data for a tank
 */
export function useWaterQualityChart(
  tankId: string | null,
  fromDate: Date | null,
  toDate: Date | null,
) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['waterQuality', 'chart', tankId, fromDate?.toISOString(), toDate?.toISOString()],
    queryFn: async () => {
      if (!tankId || !fromDate || !toDate) return [];
      const response = await graphqlClient.request<{
        waterQualityChart: WaterQualityMeasurement[];
      }>(GET_WATER_QUALITY_CHART, {
        tankId,
        fromDate: fromDate.toISOString(),
        toDate: toDate.toISOString(),
      });
      return response.waterQualityChart;
    },
    enabled: !!token && !!tankId && !!fromDate && !!toDate,
  });
}

/**
 * Fetch water quality statistics for a tank
 */
export function useWaterQualityStatistics(tankId: string | null, days: number = 7) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['waterQuality', 'statistics', tankId, days],
    queryFn: async () => {
      if (!tankId) return null;
      const response = await graphqlClient.request<{
        waterQualityStatistics: WaterQualityStatistics;
      }>(GET_WATER_QUALITY_STATISTICS, { tankId, days });
      return response.waterQualityStatistics;
    },
    enabled: !!token && !!tankId,
    staleTime: 300000, // 5 minute cache for statistics
  });
}

/**
 * Create water quality measurement mutation
 */
export function useCreateWaterQuality() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateWaterQualityInput) => {
      const response = await graphqlClient.request<{
        createWaterQualityMeasurement: WaterQualityMeasurement;
      }>(CREATE_WATER_QUALITY, { input });
      return response.createWaterQualityMeasurement;
    },
    onSuccess: (data) => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: ['waterQuality', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['waterQuality', 'latest', data.tankId] });
      queryClient.invalidateQueries({ queryKey: ['waterQuality', 'critical'] });
      queryClient.invalidateQueries({ queryKey: ['waterQuality', 'statistics', data.tankId] });
    },
  });
}

/**
 * Update water quality measurement mutation
 */
export function useUpdateWaterQuality() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateWaterQualityInput) => {
      const response = await graphqlClient.request<{
        updateWaterQualityMeasurement: WaterQualityMeasurement;
      }>(UPDATE_WATER_QUALITY, { input });
      return response.updateWaterQualityMeasurement;
    },
    onSuccess: (data) => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: ['waterQuality', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['waterQuality', 'detail', data.id] });
      queryClient.invalidateQueries({ queryKey: ['waterQuality', 'latest', data.tankId] });
      queryClient.invalidateQueries({ queryKey: ['waterQuality', 'critical'] });
      queryClient.invalidateQueries({ queryKey: ['waterQuality', 'statistics', data.tankId] });
    },
  });
}

/**
 * Delete water quality measurement mutation
 */
export function useDeleteWaterQuality() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await graphqlClient.request<{
        deleteWaterQualityMeasurement: boolean;
      }>(DELETE_WATER_QUALITY, { id });
      return response.deleteWaterQualityMeasurement;
    },
    onSuccess: () => {
      // Invalidate all water quality queries
      queryClient.invalidateQueries({ queryKey: ['waterQuality'] });
    },
  });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get status color class
 */
export function getStatusColor(status: WaterQualityStatus): string {
  switch (status) {
    case 'OPTIMAL':
      return 'text-green-600 bg-green-100';
    case 'ACCEPTABLE':
      return 'text-blue-600 bg-blue-100';
    case 'WARNING':
      return 'text-yellow-600 bg-yellow-100';
    case 'CRITICAL':
      return 'text-red-600 bg-red-100';
    default:
      return 'text-gray-600 bg-gray-100';
  }
}

/**
 * Get status label in Turkish
 */
export function getStatusLabel(status: WaterQualityStatus): string {
  switch (status) {
    case 'OPTIMAL':
      return 'Optimal';
    case 'ACCEPTABLE':
      return 'Kabul Edilebilir';
    case 'WARNING':
      return 'Dikkat';
    case 'CRITICAL':
      return 'Kritik';
    default:
      return 'Bilinmiyor';
  }
}

/**
 * Get source label in Turkish
 */
export function getSourceLabel(source: MeasurementSource): string {
  switch (source) {
    case 'MANUAL':
      return 'Manuel';
    case 'SENSOR_AUTOMATIC':
      return 'Otomatik Sensör';
    case 'SENSOR_TRIGGERED':
      return 'Tetiklenmiş Sensör';
    case 'LAB_ANALYSIS':
      return 'Laboratuvar';
    case 'CALIBRATION':
      return 'Kalibrasyon';
    default:
      return source;
  }
}

/**
 * Format parameter value with unit
 */
export function formatParameterValue(
  parameter: keyof WaterParameters,
  value: number | undefined,
): string {
  if (value === undefined || value === null) return '-';

  const units: Record<string, string> = {
    temperature: '°C',
    dissolvedOxygen: 'mg/L',
    oxygenSaturation: '%',
    pH: '',
    salinity: 'ppt',
    conductivity: 'µS/cm',
    ammonia: 'mg/L',
    ammonium: 'mg/L',
    totalAmmoniaNitrogen: 'mg/L',
    nitrite: 'mg/L',
    nitrate: 'mg/L',
    alkalinity: 'mg/L',
    hardness: 'mg/L',
    turbidity: 'NTU',
    transparency: 'cm',
    co2: 'mg/L',
    chlorine: 'mg/L',
    hydrogen_sulfide: 'mg/L',
    bod: 'mg/L',
    cod: 'mg/L',
    tss: 'mg/L',
    bacteriaCount: 'CFU/mL',
  };

  const unit = units[parameter] || '';
  return `${value.toFixed(2)}${unit ? ` ${unit}` : ''}`;
}
