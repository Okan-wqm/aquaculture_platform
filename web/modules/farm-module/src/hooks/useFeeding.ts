/**
 * Feeding hooks for farm-module
 * Handles growth simulation and feed consumption forecasting via GraphQL API
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth, graphqlClient } from '@aquaculture/shared-ui';

// ============================================================================
// TYPES
// ============================================================================

export interface GrowthProjection {
  day: number;
  date: string;
  avgWeightG: number;
  fishCount: number;
  biomassKg: number;
  sgr: number;
  feedCode?: string;
  feedName?: string;
  feedingRatePercent: number;
  dailyFeedKg: number;
  cumulativeFeedKg: number;
  fcr?: number;
  temperature?: number;
  mortality: number;
  cumulativeMortality: number;
}

export interface GrowthSimulationSummary {
  startWeight: number;
  endWeight: number;
  startBiomass: number;
  endBiomass: number;
  totalFeedKg: number;
  avgFCR: number;
  totalMortality: number;
  harvestDate?: string;
  harvestWeight?: number;
}

export interface FeedRequirement {
  feedCode: string;
  feedName: string;
  totalKg: number;
  daysUsed: number;
  startDay: number;
  endDay: number;
}

export interface GrowthSimulationResult {
  projections: GrowthProjection[];
  summary: GrowthSimulationSummary;
  feedRequirements: FeedRequirement[];
}

export interface GrowthSimulationInput {
  tankId?: string;              // Tank-based simulation (preferred)
  batchId?: string;             // Legacy batch-based simulation
  currentWeightG: number;
  currentCount: number;
  sgr: number;
  projectionDays: number;
  mortalityRate?: number;
  temperatureForecast?: number[];
  startDate?: string;
}

/**
 * Active tank info for tank selection
 */
export interface ActiveTank {
  tankId: string;
  tankName?: string;
  tankCode?: string;
  batchId?: string;
  batchNumber?: string;
  fishCount: number;
  avgWeightG: number;
  biomassKg: number;
}

export interface FeedConsumptionBatchInfo {
  batchId: string;
  batchCode: string;
  consumption: number;
}

export interface FeedConsumptionByType {
  feedId: string;
  feedCode: string;
  feedName: string;
  dailyConsumption: number[];
  totalConsumption: number;
  currentStock: number;
  daysUntilStockout: number;
  stockoutDate?: string;
  reorderDate?: string;
  reorderQuantity: number;
  batches: FeedConsumptionBatchInfo[];
}

export interface FeedForecastAlert {
  feedId: string;
  feedCode: string;
  type: 'STOCKOUT_IMMINENT' | 'LOW_STOCK' | 'REORDER_NOW';
  message: string;
  daysUntilStockout: number;
}

export interface FeedForecastResult {
  forecastDays: number;
  startDate: string;
  endDate: string;
  byFeedType: FeedConsumptionByType[];
  alerts: FeedForecastAlert[];
  totalConsumption: number;
  totalCurrentStock: number;
}

export interface FeedForecastInput {
  siteId?: string;
  forecastDays?: number;
  leadTimeDays?: number;
  safetyStockDays?: number;
}

// ============================================================================
// GRAPHQL QUERIES
// ============================================================================

const GROWTH_SIMULATION_QUERY = `
  query GrowthSimulation($tenantId: ID!, $schemaName: String!, $input: GrowthSimulationInput!) {
    growthSimulation(tenantId: $tenantId, schemaName: $schemaName, input: $input) {
      projections {
        day
        date
        avgWeightG
        fishCount
        biomassKg
        sgr
        feedCode
        feedName
        feedingRatePercent
        dailyFeedKg
        cumulativeFeedKg
        fcr
        temperature
        mortality
        cumulativeMortality
      }
      summary {
        startWeight
        endWeight
        startBiomass
        endBiomass
        totalFeedKg
        avgFCR
        totalMortality
        harvestDate
        harvestWeight
      }
      feedRequirements {
        feedCode
        feedName
        totalKg
        daysUsed
        startDay
        endDay
      }
    }
  }
`;

const FEED_CONSUMPTION_FORECAST_QUERY = `
  query FeedConsumptionForecast($tenantId: ID!, $schemaName: String!, $input: FeedForecastInput) {
    feedConsumptionForecast(tenantId: $tenantId, schemaName: $schemaName, input: $input) {
      forecastDays
      startDate
      endDate
      byFeedType {
        feedId
        feedCode
        feedName
        dailyConsumption
        totalConsumption
        currentStock
        daysUntilStockout
        stockoutDate
        reorderDate
        reorderQuantity
        batches {
          batchId
          batchCode
          consumption
        }
      }
      alerts {
        feedId
        feedCode
        type
        message
        daysUntilStockout
      }
      totalConsumption
      totalCurrentStock
    }
  }
`;

const PROJECT_HARVEST_DATE_QUERY = `
  query ProjectHarvestDate($currentWeightG: Float!, $targetWeightG: Float!, $sgr: Float!, $startDate: DateTime) {
    projectHarvestDate(currentWeightG: $currentWeightG, targetWeightG: $targetWeightG, sgr: $sgr, startDate: $startDate)
  }
`;

const ESTIMATE_SGR_QUERY = `
  query EstimateSGR($species: String!, $temperature: Float!) {
    estimateSGR(species: $species, temperature: $temperature)
  }
`;

const ACTIVE_TANKS_QUERY = `
  query ActiveTanks($tenantId: ID!, $schemaName: String!) {
    activeTanks(tenantId: $tenantId, schemaName: $schemaName) {
      tankId
      tankName
      tankCode
      batchId
      batchNumber
      fishCount
      avgWeightG
      biomassKg
    }
  }
`;

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Hook to run growth simulation
 */
export function useGrowthSimulation(
  input: GrowthSimulationInput | null,
  options?: { enabled?: boolean }
) {
  const { token, tenantId } = useAuth();
  // Schema naming convention: tenant_{first8chars_of_uuid} without dashes
  const schemaName = `tenant_${tenantId?.replace(/-/g, '').substring(0, 8).toLowerCase()}`;

  return useQuery({
    queryKey: ['feeding', 'growth-simulation', input],
    queryFn: async () => {
      const data = await graphqlClient.request<{ growthSimulation: GrowthSimulationResult }>(
        GROWTH_SIMULATION_QUERY,
        { tenantId, schemaName, input }
      );
      return data.growthSimulation;
    },
    staleTime: 60000,
    enabled: !!token && !!tenantId && !!input && (options?.enabled !== false),
  });
}

/**
 * Hook to get feed consumption forecast
 */
export function useFeedConsumptionForecast(
  input?: FeedForecastInput,
  options?: { enabled?: boolean }
) {
  const { token, tenantId } = useAuth();
  // Schema naming convention: tenant_{first8chars_of_uuid} without dashes
  const schemaName = `tenant_${tenantId?.replace(/-/g, '').substring(0, 8).toLowerCase()}`;

  return useQuery({
    queryKey: ['feeding', 'forecast', input],
    queryFn: async () => {
      const data = await graphqlClient.request<{ feedConsumptionForecast: FeedForecastResult }>(
        FEED_CONSUMPTION_FORECAST_QUERY,
        { tenantId, schemaName, input: input ?? {} }
      );
      return data.feedConsumptionForecast;
    },
    staleTime: 60000,
    enabled: !!token && !!tenantId && (options?.enabled !== false),
  });
}

/**
 * Hook to project harvest date
 */
export function useProjectHarvestDate(
  currentWeightG: number,
  targetWeightG: number,
  sgr: number,
  startDate?: string,
  options?: { enabled?: boolean }
) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['feeding', 'harvest-date', currentWeightG, targetWeightG, sgr, startDate],
    queryFn: async () => {
      const data = await graphqlClient.request<{ projectHarvestDate: string }>(
        PROJECT_HARVEST_DATE_QUERY,
        { currentWeightG, targetWeightG, sgr, startDate }
      );
      return new Date(data.projectHarvestDate);
    },
    staleTime: 60000,
    enabled: !!token && currentWeightG > 0 && targetWeightG > 0 && sgr > 0 && (options?.enabled !== false),
  });
}

/**
 * Hook to estimate SGR
 */
export function useEstimateSGR(
  species: string,
  temperature: number,
  options?: { enabled?: boolean }
) {
  const { token } = useAuth();

  return useQuery({
    queryKey: ['feeding', 'sgr', species, temperature],
    queryFn: async () => {
      const data = await graphqlClient.request<{ estimateSGR: number }>(
        ESTIMATE_SGR_QUERY,
        { species, temperature }
      );
      return data.estimateSGR;
    },
    staleTime: 300000, // 5 minutes
    enabled: !!token && !!species && temperature > 0 && (options?.enabled !== false),
  });
}

/**
 * Hook to get active tanks with fish
 * Returns tanks that have fish (totalQuantity > 0)
 */
export function useActiveTanks(options?: { enabled?: boolean }) {
  const { token, tenantId } = useAuth();
  // Schema naming convention: tenant_{first8chars_of_uuid} without dashes
  const schemaName = `tenant_${tenantId?.replace(/-/g, '').substring(0, 8).toLowerCase()}`;

  return useQuery({
    queryKey: ['feeding', 'active-tanks', tenantId],
    queryFn: async () => {
      const data = await graphqlClient.request<{ activeTanks: ActiveTank[] }>(
        ACTIVE_TANKS_QUERY,
        { tenantId, schemaName }
      );
      return data.activeTanks;
    },
    staleTime: 60000,
    enabled: !!token && !!tenantId && (options?.enabled !== false),
  });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Calculate SGR from two weight measurements (client-side)
 */
export function calculateSGR(startWeightG: number, endWeightG: number, days: number): number {
  if (days <= 0 || startWeightG <= 0 || endWeightG <= 0) {
    return 0;
  }
  // SGR = (ln(Wt) - ln(W0)) / t × 100
  return ((Math.log(endWeightG) - Math.log(startWeightG)) / days) * 100;
}

/**
 * Calculate projected weight at time t
 */
export function projectWeight(currentWeightG: number, sgr: number, days: number): number {
  // Wt = W0 × e^(SGR × t / 100)
  return currentWeightG * Math.exp((sgr * days) / 100);
}

/**
 * Calculate days to reach target weight
 */
export function daysToTargetWeight(currentWeightG: number, targetWeightG: number, sgr: number): number {
  if (sgr <= 0 || currentWeightG <= 0 || targetWeightG <= currentWeightG) {
    return 0;
  }
  // t = ln(Wt/W0) / (SGR/100)
  return Math.ceil(Math.log(targetWeightG / currentWeightG) / (sgr / 100));
}

/**
 * Format date for display
 */
export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('tr-TR', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Get alert severity color
 */
export function getAlertColor(type: FeedForecastAlert['type']): string {
  switch (type) {
    case 'STOCKOUT_IMMINENT':
      return 'bg-red-100 text-red-800 border-red-200';
    case 'REORDER_NOW':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    case 'LOW_STOCK':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200';
  }
}
