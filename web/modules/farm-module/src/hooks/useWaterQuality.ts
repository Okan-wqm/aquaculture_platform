/**
 * Water Quality hooks for farm-module
 * Handles CRUD operations for water quality measurements via GraphQL API
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

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
  systemId?: string;
  status?: WaterQualityStatus;
  source?: MeasurementSource;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

/**
 * SINGLE-INGRESS (Tier-1): `dynamicParameters` keyed by tenant-config parameter
 * codes is the SOLE parameter channel, mirroring the backend
 * CreateWaterQualityInput DTO. The legacy fixed `parameters` object was removed.
 * `equipmentId` is required so the backend can validate the submitted values
 * against the equipment's mapped parameter configs.
 */
export interface CreateWaterQualityInput {
  tankId?: string;
  pondId?: string;
  siteId?: string;
  batchId?: string;
  equipmentId: string;
  measuredAt: string;
  source: MeasurementSource;
  measuredBy?: string;
  dynamicParameters: Record<string, number | string | boolean>;
  idempotencyKey?: string;
  notes?: string;
  weatherConditions?: string;
}

/**
 * Bulk-creation input mirrors the backend `CreateBatchWaterQualityInput`
 * DTO at apps/farm-service/src/water-quality/dto/create-batch-water-quality.input.ts.
 *
 * Constraints (enforced server-side; UI mirrors them as gates):
 *   - 1..50 measurements per request
 *   - dynamicParameters keys must match the equipment's mapped parameter
 *     configs (the backend's WaterQualityValidationService rejects
 *     unknown keys when strict mode is enabled)
 *   - idempotencyKey must be a UUID — frontend mints with crypto.randomUUID()
 *     so a duplicate submit (network retry, double-click) maps to the same
 *     server-side row instead of creating a second record
 *   - notes <= 500 chars per row (server bound; UI gates this too)
 */
export interface BatchMeasurementItemInput {
  equipmentId: string;
  dynamicParameters: Record<string, number | string | boolean>;
  idempotencyKey: string;
  notes?: string;
}

export interface CreateBatchWaterQualityInput {
  measuredAt: string;
  source: MeasurementSource;
  measurements: BatchMeasurementItemInput[];
}

export interface UpdateWaterQualityInput {
  id: string;
  dynamicParameters?: Record<string, number | string | boolean>;
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
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
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

const CREATE_BATCH_WATER_QUALITY = `
  mutation CreateBatchWaterQualityMeasurements($input: CreateBatchWaterQualityInput!) {
    createBatchWaterQualityMeasurements(input: $input) {
      ${WATER_QUALITY_FRAGMENT}
    }
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

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'waterQuality', 'list', filters),
    queryFn: async () => {
      const response = await graphqlClient.request<{
        waterQualityMeasurements: {
          items: WaterQualityMeasurement[];
          total: number;
          page: number;
          limit: number;
          totalPages: number;
          hasNextPage: boolean;
          hasPreviousPage: boolean;
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

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'waterQuality', 'detail', id),
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
  const { tenantId } = useAuth();
  const { token } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'waterQuality', 'latest', tankId),
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

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'waterQuality', 'critical'),
    queryFn: async () => {
      const response = await graphqlClient.request<{
        criticalWaterQuality: WaterQualityMeasurement[];
      }>(GET_CRITICAL_WATER_QUALITY, {});
      return response.criticalWaterQuality;
    },
    enabled: !!token,
    // Poll at 5 min for critical data — 30 s was too aggressive and caused excess requests (PERF-006)
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
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
  const { tenantId } = useAuth();
  const { token } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'waterQuality', 'chart', tankId, fromDate?.toISOString(), toDate?.toISOString()),
    queryFn: async () => {
      if (!tankId || !fromDate || !toDate) return [];
      const response = await graphqlClient.request<{
        waterQualityChart: WaterQualityMeasurement[];
      }>(GET_WATER_QUALITY_CHART, {
        tankId,
        fromDate: fromDate.toISOString(),
        toDate: toDate.toISOString(),
    enabled: !!tenantId,
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

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'waterQuality', 'statistics', tankId, days),
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

// ============================================================================
// SYSTEM-LEVEL HOOKS
// ============================================================================

const GET_WATER_QUALITY_CHART_BY_SYSTEM = `
  query WaterQualityChartBySystem($systemId: ID!, $fromDate: DateTime!, $toDate: DateTime!) {
    waterQualityChartBySystem(systemId: $systemId, fromDate: $fromDate, toDate: $toDate) {
      id
      measuredAt
      tankId
      temperature
      dissolvedOxygen
      pH
      ammonia
      nitrite
      overallStatus
      parameters
    }
  }
`;

const GET_WATER_QUALITY_STATISTICS_BY_SYSTEM = `
  query WaterQualityStatisticsBySystem($systemId: ID!, $days: Int) {
    waterQualityStatisticsBySystem(systemId: $systemId, days: $days) {
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

/**
 * Fetch chart data for all tanks in a system
 */
export function useWaterQualityChartBySystem(
  systemId: string | null,
  fromDate: Date | null,
  toDate: Date | null,
) {
  const { tenantId } = useAuth();
  const { token } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'waterQuality', 'chartBySystem', systemId, fromDate?.toISOString(), toDate?.toISOString()),
    queryFn: async () => {
      if (!systemId || !fromDate || !toDate) return [];
      const response = await graphqlClient.request<{
        waterQualityChartBySystem: WaterQualityMeasurement[];
      }>(GET_WATER_QUALITY_CHART_BY_SYSTEM, {
        systemId,
        fromDate: fromDate.toISOString(),
        toDate: toDate.toISOString(),
    enabled: !!tenantId,
      });
      return response.waterQualityChartBySystem;
    },
    enabled: !!token && !!systemId && !!fromDate && !!toDate,
  });
}

/**
 * Fetch aggregate statistics for all tanks in a system
 */
export function useWaterQualityStatisticsBySystem(
  systemId: string | null,
  days: number = 7,
) {
  const { tenantId } = useAuth();
  const { token } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'waterQuality', 'statisticsBySystem', systemId, days),
    queryFn: async () => {
      if (!systemId) return null;
      const response = await graphqlClient.request<{
        waterQualityStatisticsBySystem: WaterQualityStatistics;
      }>(GET_WATER_QUALITY_STATISTICS_BY_SYSTEM, { systemId, days });
      return response.waterQualityStatisticsBySystem;
    },
    enabled: !!token && !!systemId,
    staleTime: 300000,
  });
}

/**
 * Create water quality measurement mutation
 */
export function useCreateWaterQuality() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (input: CreateWaterQualityInput) => {
      const response = await graphqlClient.request<{
        createWaterQualityMeasurement: WaterQualityMeasurement;
      }>(CREATE_WATER_QUALITY, { input });
      return response.createWaterQualityMeasurement;
    },
    onSuccess: (data) => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality', 'list') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality', 'latest', data.tankId) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality', 'critical') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality', 'statistics', data.tankId) });
    },
  });
}

/**
 * Bulk water quality creation — single transactional call that writes
 * 1..50 measurements (one per equipment) under a shared `measuredAt` and
 * `source`. Used by the BulkRecordTab to let a tank-walker enter the
 * morning's WQ readings for every tank in one round.
 *
 * Cache invalidation strategy
 * ---------------------------
 * Bulk inserts touch many equipment + many derived views at once.
 * Rather than fan out to per-equipment `latest` keys (which would be a
 * 50-key invalidation parade), we invalidate the broad `waterQuality`
 * root and let TanStack Query's tag matcher walk the tree. This is
 * cheaper than a per-row useCreateWaterQuality flow and keeps the
 * dashboard / critical-alerts panel reactive without staleness windows.
 */
export function useCreateBatchWaterQuality() {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: CreateBatchWaterQualityInput) => {
      const response = await graphqlClient.request<{
        createBatchWaterQualityMeasurements: WaterQualityMeasurement[];
      }>(CREATE_BATCH_WATER_QUALITY, { input });
      return response.createBatchWaterQualityMeasurements;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality') });
    },
  });
}

/**
 * Update water quality measurement mutation
 */
export function useUpdateWaterQuality() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();

  return useMutation({
    mutationFn: async (input: UpdateWaterQualityInput) => {
      const response = await graphqlClient.request<{
        updateWaterQualityMeasurement: WaterQualityMeasurement;
      }>(UPDATE_WATER_QUALITY, { input });
      return response.updateWaterQualityMeasurement;
    },
    onSuccess: (data) => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality', 'list') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality', 'detail', data.id) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality', 'latest', data.tankId) });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality', 'critical') });
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality', 'statistics', data.tankId) });
    },
  });
}

/**
 * Delete water quality measurement mutation
 */
export function useDeleteWaterQuality() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await graphqlClient.request<{
        deleteWaterQualityMeasurement: boolean;
      }>(DELETE_WATER_QUALITY, { id });
      return response.deleteWaterQualityMeasurement;
    },
    onSuccess: () => {
      // Invalidate all water quality queries
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'waterQuality') });
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
