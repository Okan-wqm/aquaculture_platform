/**
 * Daily Feeding Execution Hooks
 *
 * Shared hooks for daily feeding execution operations:
 * - useDailyFeedingExecutions: Fetch executions for a date (with polling)
 * - useRecordDailyFeeding: Record actual feeding mutation
 * - useSkipDailyFeeding: Skip feeding mutation
 */
import { useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Polling interval for real-time updates (ms) */
const POLLING_INTERVAL_MS = 30000;

/** Maximum allowed feed amount in kg */
export const MAX_FEED_AMOUNT_KG = 10000;

/** Default SGR percentage per day */
const DEFAULT_SGR_PERCENT = 1.0;

/** Minimum weight gain threshold */
const MIN_WEIGHT_GAIN_KG = 0.001;

/** Maximum biological FCR limit */
const MAX_BIOLOGICAL_FCR = 10;

// ============================================================================
// TYPES
// ============================================================================

export type FeedingStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'SKIPPED'
  | 'PARTIAL'
  | 'TRANSITION_WARNING';

/**
 * Feeding method type — uses GraphQL enum KEYS (uppercase).
 * Backend FeedingMethod enum: MANUAL='manual', AUTOMATIC='automatic', etc.
 * GraphQL always uses the KEY, not the DB value.
 */
export type FeedingMethodType =
  | 'MANUAL'
  | 'AUTOMATIC'
  | 'DEMAND'
  | 'BROADCAST'
  | 'SPOT';

export interface DailyFeedingExecution {
  id: string;
  // Tank info (from backend entity)
  equipmentId: string;
  equipmentName: string;
  equipmentCode: string;
  equipmentType: string;
  // Mapped names for UI convenience
  tankId: string;
  tankName: string;
  tankCode: string;
  // Calculations (from JSONB)
  fishCount: number;
  avgWeightG: number;
  biomassKg: number;
  feedId?: string;
  feedCode?: string;
  feedName?: string;
  feedingRatePercent: number;
  mealsPerDay?: number;
  perMealKg?: number;
  expectedFCR?: number;
  expectedSGR?: number;
  waterTempC?: number;
  // Planned
  plannedAmountKg: number;
  // Actual
  actualAmountKg?: number | null;
  // Variance
  varianceKg?: number | null;
  variancePercent?: number | null;
  // Status
  status: FeedingStatus;
  // Transition
  isTransitionDay?: boolean;
  transitionFromFeed?: string;
  transitionToFeed?: string;
  transitionPercent?: number;
  // Feeder info
  feederEquipmentId?: string;
  feederName?: string;
  feedingMethod?: FeedingMethodType;
  // Notes & metadata
  notes?: string;
  skipReason?: string;
  completedBy?: string;
  completedAt?: string;
  // Program info
  feedingProgram?: { id: string; name: string; code: string };
  feedingProgramTank?: { id: string; equipmentName: string; currentFeedCode?: string };
}

export interface DailyFeedingSummary {
  date: string;
  totalPlannedKg: number;
  totalActualKg: number;
  totalTanks: number;
  completedTanks: number;
  pendingTanks: number;
  transitionTanks: number;
  skippedTanks: number;
  inProgressTanks: number;
}

export interface FeedingPreview {
  fcr: number | null;
  expectedGrowthG: number;
  newBiomassKg: number;
  newAvgWeightG: number;
  feedingRateActualPercent: number;
  weightGainKg: number;
}

// ============================================================================
// STATUS CONFIG
// ============================================================================

interface StatusConfig {
  label: string;
  icon: string;
  colorClass: string;
}

export const STATUS_CONFIG: Record<FeedingStatus, StatusConfig> = {
  PENDING: { label: 'Pending', icon: '\u23F3', colorClass: 'bg-yellow-100 text-yellow-800' },
  IN_PROGRESS: { label: 'In Progress', icon: '\u25B6\uFE0F', colorClass: 'bg-blue-100 text-blue-800' },
  COMPLETED: { label: 'Completed', icon: '\u2705', colorClass: 'bg-green-100 text-green-800' },
  SKIPPED: { label: 'Skipped', icon: '\u23ED\uFE0F', colorClass: 'bg-gray-100 text-gray-800' },
  PARTIAL: { label: 'Partial', icon: '\u26A0\uFE0F', colorClass: 'bg-amber-100 text-amber-800' },
  TRANSITION_WARNING: { label: 'Transition', icon: '\u26A0\uFE0F', colorClass: 'bg-orange-100 text-orange-800' },
};

export function getStatusIcon(status: FeedingStatus): string {
  return STATUS_CONFIG[status]?.icon ?? '\u2753';
}

export function getStatusColor(status: FeedingStatus): string {
  return STATUS_CONFIG[status]?.colorClass ?? 'bg-gray-100 text-gray-800';
}

export function getStatusLabel(status: FeedingStatus): string {
  return STATUS_CONFIG[status]?.label ?? status;
}

// ============================================================================
// GRAPHQL QUERIES & MUTATIONS
// ============================================================================

// SCHEMA-CONTRACT: NestJS maps TypeScript Date → GraphQL DateTime, not Date
const DAILY_FEEDING_EXECUTIONS_QUERY = `
  query DailyFeedingExecutions($date: DateTime!, $siteId: ID) {
    dailyFeedingExecutions(date: $date, siteId: $siteId) {
      id
      equipmentId
      equipmentName
      equipmentCode
      equipmentType
      calculations
      actualResults
      plannedFeedKg
      actualFeedKg
      varianceKg
      variancePercent
      status
      hasTransitionWarning
      feedTransitioned
      notes
      skipReason
      feederEquipmentId
      feederName
      feedingMethod
      completedBy
      completedAt
      feedingProgram { id name code }
      feedingProgramTank { id equipmentName }
    }
  }
`;

const RECORD_DAILY_FEEDING_MUTATION = `
  mutation RecordDailyFeeding($input: RecordDailyFeedingInput!) {
    recordDailyFeeding(input: $input) {
      id
      actualFeedKg
      status
      feedingMethod
      feederName
      completedAt
    }
  }
`;

const SKIP_DAILY_FEEDING_MUTATION = `
  mutation SkipDailyFeeding($input: SkipDailyFeedingInput!) {
    skipDailyFeeding(input: $input) {
      id
      status
      skipReason
    }
  }
`;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export function formatDateLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatNumber(value: number | undefined | null, decimals = 1): string {
  if (value === undefined || value === null) return '-';
  return value.toLocaleString('tr-TR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const sanitized = error.message
      // Strip stack frame references (both Unix and Windows paths)
      .replace(/at\s+[\w./\\]+:\d+:\d+/g, '')
      // Strip Unix-style paths
      .replace(/\/[\w./\\-]+/g, '[path]')
      // Strip Windows-style paths (C:\..., D:\...)
      .replace(/[A-Za-z]:[\\/][\w.\\/:-]+/g, '[path]')
      // Strip tenant schema names
      .replace(/tenant_\w+/g, '[tenant]')
      // Strip SQL table/column references
      .replace(/\b\w+\.\w+\s*=\s*\$\d+/g, '[sql]')
      .trim();
    return sanitized || 'An unexpected error occurred';
  }
  return 'An unexpected error occurred';
}

export function calculateFeedingPreview(
  execution: DailyFeedingExecution,
  actualAmountKg: number,
): FeedingPreview | null {
  if (actualAmountKg <= 0) return null;
  if (execution.fishCount <= 0 || execution.biomassKg <= 0) return null;

  const estimatedSGR = execution.expectedSGR ?? DEFAULT_SGR_PERCENT;
  const expectedGrowthG = execution.avgWeightG * (estimatedSGR / 100);
  const newAvgWeightG = execution.avgWeightG + expectedGrowthG;
  const newBiomassKg = (execution.fishCount * newAvgWeightG) / 1000;
  const feedingRateActualPercent = (actualAmountKg / execution.biomassKg) * 100;
  const weightGainKg = (execution.fishCount * expectedGrowthG) / 1000;

  let fcr: number | null = null;
  if (weightGainKg > MIN_WEIGHT_GAIN_KG) {
    fcr = actualAmountKg / weightGainKg;
    if (fcr > MAX_BIOLOGICAL_FCR) {
      if (import.meta.env.DEV) {
        console.warn(`Calculated FCR (${fcr.toFixed(2)}) exceeds biological limit`);
      }
    }
    fcr = Math.round(fcr * 100) / 100;
  }

  return {
    fcr,
    expectedGrowthG: Math.round(expectedGrowthG * 10) / 10,
    newBiomassKg: Math.round(newBiomassKg * 10) / 10,
    newAvgWeightG: Math.round(newAvgWeightG * 10) / 10,
    feedingRateActualPercent: Math.round(feedingRateActualPercent * 100) / 100,
    weightGainKg: Math.round(weightGainKg * 1000) / 1000,
  };
}

/**
 * Get variance-based row color class for the comparison table
 */
export function getVarianceColor(variancePercent: number | null | undefined, status: FeedingStatus): string {
  if (status === 'PENDING' || status === 'IN_PROGRESS' || variancePercent === null || variancePercent === undefined) {
    return ''; // white/default
  }
  if (status === 'SKIPPED') return 'bg-gray-50/50 opacity-60';

  const v = variancePercent;
  if (v >= -5 && v <= 5) return 'bg-green-50';
  if (v > 5 && v <= 15) return 'bg-amber-50';
  if (v > 15) return 'bg-orange-50';
  if (v < -5 && v >= -15) return 'bg-yellow-100';
  if (v < -15) return 'bg-red-50';
  return '';
}

/**
 * Format feeding method for display
 */
export function formatFeedingMethod(method?: FeedingMethodType, feederName?: string): string {
  if (!method) return '-';
  const labels: Record<FeedingMethodType, string> = {
    MANUAL: 'Manuel',
    AUTOMATIC: 'Auto',
    DEMAND: 'Demand',
    BROADCAST: 'Broadcast',
    SPOT: 'Spot',
  };
  const label = labels[method] ?? method;
  return feederName ? `${label} / ${feederName}` : label;
}

// ============================================================================
// RESPONSE MAPPING
// ============================================================================

interface RawExecution {
  id: string;
  equipmentId: string;
  equipmentName: string;
  equipmentCode: string;
  equipmentType: string;
  calculations: {
    avgWeightG?: number;
    fishCount?: number;
    biomassKg?: number;
    activeFeedId?: string;
    activeFeedCode?: string;
    activeFeedName?: string;
    feedingRatePercent?: number;
    plannedFeedKg?: number;
    mealsPerDay?: number;
    perMealKg?: number;
    expectedFCR?: number;
    waterTempC?: number;
    transitionWarning?: {
      nextFeedCode?: string;
      currentRange?: string;
      nextRange?: string;
    };
  };
  actualResults?: {
    actualFeedGivenKg?: number;
    variance?: number;
    variancePercent?: number;
  };
  plannedFeedKg: number;
  actualFeedKg: number | null;
  varianceKg: number | null;
  variancePercent: number | null;
  status: string;
  hasTransitionWarning: boolean;
  feedTransitioned: boolean;
  notes?: string;
  skipReason?: string;
  feederEquipmentId?: string;
  feederName?: string;
  feedingMethod?: FeedingMethodType;
  completedBy?: string;
  completedAt?: string;
  feedingProgram?: { id: string; name: string; code: string };
  feedingProgramTank?: { id: string; equipmentName: string };
}

function mapExecution(raw: RawExecution): DailyFeedingExecution {
  const calc = raw.calculations || {};
  const statusMap: Record<string, FeedingStatus> = {
    planned: 'PENDING',
    in_progress: 'IN_PROGRESS',
    completed: 'COMPLETED',
    skipped: 'SKIPPED',
    partial: 'PARTIAL',
  };

  return {
    id: raw.id,
    equipmentId: raw.equipmentId,
    equipmentName: raw.equipmentName,
    equipmentCode: raw.equipmentCode,
    equipmentType: raw.equipmentType,
    // Mapped for UI
    tankId: raw.equipmentId,
    tankName: raw.equipmentName,
    tankCode: raw.equipmentCode,
    // From calculations JSONB
    fishCount: calc.fishCount ?? 0,
    avgWeightG: calc.avgWeightG ?? 0,
    biomassKg: calc.biomassKg ?? 0,
    feedId: calc.activeFeedId,
    feedCode: calc.activeFeedCode,
    feedName: calc.activeFeedName,
    feedingRatePercent: calc.feedingRatePercent ?? 0,
    mealsPerDay: calc.mealsPerDay,
    perMealKg: calc.perMealKg,
    expectedFCR: calc.expectedFCR,
    waterTempC: calc.waterTempC,
    // Planned & actual
    plannedAmountKg: raw.plannedFeedKg ?? calc.plannedFeedKg ?? 0,
    actualAmountKg: raw.actualFeedKg,
    varianceKg: raw.varianceKg,
    variancePercent: raw.variancePercent,
    // Status — warn on unknown values so schema mismatches are caught early.
    // BUG-022: TRANSITION_WARNING is an overlay on PENDING status, not a separate backend status.
    // Set it when the tank has a pending feed and a transition warning, so the orange
    // left-border indicator in the UI table is actually reachable.
    status: (() => {
      const mapped = statusMap[raw.status];
      if (!mapped && import.meta.env.DEV) {
        console.warn(`Unknown feeding status from server: "${raw.status}" for execution ${raw.id}`);
      }
      const base = mapped ?? 'PENDING';
      // Apply TRANSITION_WARNING overlay only on PENDING executions with a transition warning
      if (base === 'PENDING' && raw.hasTransitionWarning) return 'TRANSITION_WARNING';
      return base;
    })(),
    // Transition
    isTransitionDay: raw.hasTransitionWarning,
    transitionToFeed: calc.transitionWarning?.nextFeedCode,
    // Feeder
    feederEquipmentId: raw.feederEquipmentId,
    feederName: raw.feederName,
    feedingMethod: raw.feedingMethod,
    // Metadata
    notes: raw.notes,
    skipReason: raw.skipReason,
    completedBy: raw.completedBy,
    completedAt: raw.completedAt,
    feedingProgram: raw.feedingProgram,
    feedingProgramTank: raw.feedingProgramTank,
  };
}

// ============================================================================
// HOOKS
// ============================================================================

export function useDailyFeedingExecutions(date: string, siteId?: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'feeding', 'daily-executions', tenantId, date, siteId),
    queryFn: async () => {
      if (!tenantId) throw new Error('Tenant context required');

      const variables: Record<string, unknown> = { date };
      if (siteId) variables.siteId = siteId;

      const data = await graphqlClient.request<{
        dailyFeedingExecutions: RawExecution[];
      }>(DAILY_FEEDING_EXECUTIONS_QUERY, variables);

      const executions = (data.dailyFeedingExecutions || []).map(mapExecution);

      const summary: DailyFeedingSummary = {
        date,
        totalPlannedKg: executions.reduce((sum, e) => sum + (e.plannedAmountKg || 0), 0),
        totalActualKg: executions.reduce((sum, e) => sum + (e.actualAmountKg || 0), 0),
        totalTanks: executions.length,
        completedTanks: executions.filter(e => e.status === 'COMPLETED').length,
        pendingTanks: executions.filter(e => e.status === 'PENDING' || e.status === 'IN_PROGRESS').length,
        transitionTanks: executions.filter(e => e.isTransitionDay).length,
        skippedTanks: executions.filter(e => e.status === 'SKIPPED').length,
        inProgressTanks: executions.filter(e => e.status === 'IN_PROGRESS').length,
      };

      return { executions, summary };
    },
    staleTime: 30000,
    enabled: !!token && !!tenantId && !!date,
    refetchInterval: POLLING_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export interface RecordFeedingInput {
  executionId: string;
  actualKg: number;
  notes?: string;
  feederEquipmentId?: string;
  feedingMethod?: FeedingMethodType;
}

export function useRecordDailyFeeding(date: string) {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RecordFeedingInput) => {
      if (!tenantId) throw new Error('Tenant context required');

      const data = await graphqlClient.request<{
        recordDailyFeeding: { id: string; actualFeedKg: number; status: string };
      }>(RECORD_DAILY_FEEDING_MUTATION, {
        input: {
          executionId: input.executionId,
          actualKg: input.actualKg,
          notes: input.notes,
          feederEquipmentId: input.feederEquipmentId,
          feedingMethod: input.feedingMethod,
        },
      });
      return { success: true, execution: data.recordDailyFeeding };
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding', 'daily-executions', tenantId, date) });
      const previousData = queryClient.getQueryData(['feeding', 'daily-executions', tenantId, date]);

      queryClient.setQueryData(
        ['feeding', 'daily-executions', tenantId, date],
        (old: { executions: DailyFeedingExecution[]; summary: DailyFeedingSummary } | undefined) => {
          if (!old) return old;
          const updatedExecutions = old.executions.map((exec) =>
            exec.id === input.executionId
              ? {
                  ...exec,
                  actualAmountKg: input.actualKg,
                  status: 'COMPLETED' as FeedingStatus,
                  feedingMethod: input.feedingMethod,
                }
              : exec,
          );
          const newSummary: DailyFeedingSummary = {
            date: old.summary.date,
            totalPlannedKg: updatedExecutions.reduce((s, e) => s + (e.plannedAmountKg || 0), 0),
            totalActualKg: updatedExecutions.reduce((s, e) => s + (e.actualAmountKg || 0), 0),
            totalTanks: updatedExecutions.length,
            completedTanks: updatedExecutions.filter(e => e.status === 'COMPLETED').length,
            pendingTanks: updatedExecutions.filter(e => e.status === 'PENDING' || e.status === 'IN_PROGRESS').length,
            transitionTanks: updatedExecutions.filter(e => e.isTransitionDay).length,
            skippedTanks: updatedExecutions.filter(e => e.status === 'SKIPPED').length,
            inProgressTanks: updatedExecutions.filter(e => e.status === 'IN_PROGRESS').length,
          };
          return { executions: updatedExecutions, summary: newSummary };
        },
      );

      return { previousData };
    },
    onError: (_err, _input, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['feeding', 'daily-executions', tenantId, date], context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding', 'daily-executions', tenantId) });
    },
  });
}

export interface SkipFeedingInput {
  executionId: string;
  reason: string;
}

export function useSkipDailyFeeding(date: string) {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SkipFeedingInput) => {
      if (!tenantId) throw new Error('Tenant context required');

      const data = await graphqlClient.request<{
        skipDailyFeeding: { id: string; status: string; skipReason: string };
      }>(SKIP_DAILY_FEEDING_MUTATION, {
        input: {
          executionId: input.executionId,
          skipReason: input.reason,
        },
      });
      return { success: true, execution: data.skipDailyFeeding };
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding', 'daily-executions', tenantId, date) });
      const previousData = queryClient.getQueryData(['feeding', 'daily-executions', tenantId, date]);

      queryClient.setQueryData(
        ['feeding', 'daily-executions', tenantId, date],
        (old: { executions: DailyFeedingExecution[]; summary: DailyFeedingSummary } | undefined) => {
          if (!old) return old;
          const updatedExecutions = old.executions.map((exec) =>
            exec.id === input.executionId
              ? { ...exec, status: 'SKIPPED' as FeedingStatus, skipReason: input.reason }
              : exec,
          );
          const newSummary: DailyFeedingSummary = {
            date: old.summary.date,
            totalPlannedKg: updatedExecutions.reduce((s, e) => s + (e.plannedAmountKg || 0), 0),
            totalActualKg: updatedExecutions.reduce((s, e) => s + (e.actualAmountKg || 0), 0),
            totalTanks: updatedExecutions.length,
            completedTanks: updatedExecutions.filter(e => e.status === 'COMPLETED').length,
            pendingTanks: updatedExecutions.filter(e => e.status === 'PENDING' || e.status === 'IN_PROGRESS').length,
            transitionTanks: updatedExecutions.filter(e => e.isTransitionDay).length,
            skippedTanks: updatedExecutions.filter(e => e.status === 'SKIPPED').length,
            inProgressTanks: updatedExecutions.filter(e => e.status === 'IN_PROGRESS').length,
          };
          return { executions: updatedExecutions, summary: newSummary };
        },
      );

      return { previousData };
    },
    onError: (_err, _input, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['feeding', 'daily-executions', tenantId, date], context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'feeding', 'daily-executions', tenantId) });
    },
  });
}
