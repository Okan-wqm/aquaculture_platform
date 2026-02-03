/**
 * Daily Feeding Dashboard
 *
 * Dashboard for daily feeding execution tracking:
 * - Date picker for selecting feeding date
 * - Summary cards: Total Feed, Completed, Pending, Transitions
 * - DataTable with tank feeding status
 * - Record Feeding Modal with FCR/Growth preview
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, Modal, Button, useToast } from '@aquaculture/shared-ui';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum allowed feed amount in kg (biological/practical limit) */
const MAX_FEED_AMOUNT_KG = 10000;

/** Default SGR (Specific Growth Rate) percentage per day */
const DEFAULT_SGR_PERCENT = 1.0;

/** Minimum weight gain threshold to avoid division by zero */
const MIN_WEIGHT_GAIN_KG = 0.001;

/** Maximum biological FCR limit for sanity checking */
const MAX_BIOLOGICAL_FCR = 10;

/** Polling interval for real-time updates (ms) */
const POLLING_INTERVAL_MS = 30000;

/** Number of items per page for pagination */
const PAGE_SIZE = 20;

// ============================================================================
// TYPES
// ============================================================================

// Issue #5: Incomplete status type definition - Add IN_PROGRESS, SKIPPED statuses
export type FeedingStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'SKIPPED'
  | 'PARTIAL'
  | 'TRANSITION_WARNING';

export interface DailyFeedingExecution {
  id: string;
  tankId: string;
  tankName: string;
  tankCode: string;
  batchId: string;
  batchNumber: string;
  speciesCode?: string;
  // Fish metrics
  fishCount: number;
  avgWeightG: number;
  biomassKg: number;
  // Feed info
  feedId?: string;
  feedCode?: string;
  feedName?: string;
  // Planned values
  plannedAmountKg: number;
  feedingRatePercent: number;
  // Actual values (null if not yet recorded)
  actualAmountKg?: number | null;
  recordedAt?: string | null;
  recordedBy?: string | null;
  // Status
  status: FeedingStatus;
  // Transition info
  isTransitionDay?: boolean;
  transitionFromFeed?: string;
  transitionToFeed?: string;
  transitionPercent?: number;
  // Notes
  notes?: string;
  // Skip info
  skipReason?: string;
  skippedAt?: string;
  skippedBy?: string;
  // Expected FCR from species/feed data
  expectedFCR?: number;
  // Expected SGR from species data
  expectedSGR?: number;
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

export interface RecordFeedingInput {
  executionId: string;
  tankId: string;
  actualAmountKg: number;
  notes?: string;
  recordedAt?: string;
}

export interface FeedingPreview {
  fcr: number;
  expectedGrowthG: number;
  newBiomassKg: number;
  newAvgWeightG: number;
  feedingRateActualPercent: number;
  weightGainKg: number;
}

export interface SkipFeedingInput {
  executionId: string;
  reason: string;
}

// Issue #15: Status display mapping
interface StatusConfig {
  label: string;
  icon: string;
  colorClass: string;
}

const STATUS_CONFIG: Record<FeedingStatus, StatusConfig> = {
  PENDING: {
    label: 'Pending',
    icon: '\u23F3', // Hourglass
    colorClass: 'bg-yellow-100 text-yellow-800',
  },
  IN_PROGRESS: {
    label: 'In Progress',
    icon: '\u25B6\uFE0F', // Play button
    colorClass: 'bg-blue-100 text-blue-800',
  },
  COMPLETED: {
    label: 'Completed',
    icon: '\u2705', // Check mark
    colorClass: 'bg-green-100 text-green-800',
  },
  SKIPPED: {
    label: 'Skipped',
    icon: '\u23ED\uFE0F', // Skip forward
    colorClass: 'bg-gray-100 text-gray-800',
  },
  PARTIAL: {
    label: 'Partial',
    icon: '\u26A0\uFE0F', // Warning
    colorClass: 'bg-amber-100 text-amber-800',
  },
  TRANSITION_WARNING: {
    label: 'Transition',
    icon: '\u26A0\uFE0F', // Warning
    colorClass: 'bg-orange-100 text-orange-800',
  },
};

// ============================================================================
// GRAPHQL QUERIES & MUTATIONS
// ============================================================================

// NOTE: tenantId is automatically extracted from X-Tenant-Id header by @Tenant() decorator
// graphqlClient automatically sets this header from stored tenant context
const DAILY_FEEDING_EXECUTIONS_QUERY = `
  query DailyFeedingExecutions($date: Date!) {
    dailyFeedingExecutions(date: $date) {
      id
      tankId
      tankName
      tankCode
      batchId
      batchNumber
      speciesCode
      fishCount
      avgWeightG
      biomassKg
      feedId
      feedCode
      feedName
      plannedAmountKg
      feedingRatePercent
      actualAmountKg
      recordedAt
      recordedBy
      status
      isTransitionDay
      transitionFromFeed
      transitionToFeed
      transitionPercent
      notes
      skipReason
      skippedAt
      skippedBy
      expectedFCR
      expectedSGR
    }
  }
`;

const RECORD_DAILY_FEEDING_MUTATION = `
  mutation RecordDailyFeeding($input: RecordDailyFeedingInput!) {
    recordDailyFeeding(input: $input) {
      id
      actualAmountKg
      recordedAt
      status
    }
  }
`;

const SKIP_DAILY_FEEDING_MUTATION = `
  mutation SkipDailyFeeding($input: SkipDailyFeedingInput!) {
    skipDailyFeeding(input: $input) {
      id
      status
      skipReason
      skippedAt
      skippedBy
    }
  }
`;

// ============================================================================
// HOOKS
// ============================================================================

function useDailyFeedingExecutions(date: string) {
  const { token, tenantId } = useAuth();

  return useQuery({
    // Include tenantId in cache key to prevent cross-tenant cache issues
    queryKey: ['feeding', 'daily-executions', tenantId, date],
    queryFn: async () => {
      if (!tenantId) throw new Error('Tenant context required');

      // tenantId is automatically sent via X-Tenant-Id header by graphqlClient
      const data = await graphqlClient.request<{
        dailyFeedingExecutions: DailyFeedingExecution[];
      }>(DAILY_FEEDING_EXECUTIONS_QUERY, { date });

      // Build summary from executions
      const executions = data.dailyFeedingExecutions || [];
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
    // Polling for real-time multi-user updates
    refetchInterval: POLLING_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

function useRecordDailyFeeding(date: string) {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RecordFeedingInput) => {
      if (!tenantId) throw new Error('Tenant context required');

      // tenantId is automatically sent via X-Tenant-Id header by graphqlClient
      const data = await graphqlClient.request<{
        recordDailyFeeding: DailyFeedingExecution;
      }>(RECORD_DAILY_FEEDING_MUTATION, { input: {
        executionId: input.executionId,
        actualKg: input.actualAmountKg,
        notes: input.notes,
      }});
      return { success: true, execution: data.recordDailyFeeding };
    },
    // Optimistic updates for better UX
    onMutate: async (input) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['feeding', 'daily-executions', tenantId, date] });

      // Snapshot the previous value
      const previousData = queryClient.getQueryData(['feeding', 'daily-executions', tenantId, date]);

      // Optimistically update
      queryClient.setQueryData(
        ['feeding', 'daily-executions', tenantId, date],
        (old: { executions: DailyFeedingExecution[]; summary: DailyFeedingSummary } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            executions: old.executions.map((exec) =>
              exec.id === input.executionId
                ? { ...exec, actualAmountKg: input.actualAmountKg, status: 'COMPLETED' as FeedingStatus }
                : exec
            ),
          };
        }
      );

      return { previousData };
    },
    onError: (_err, _input, context) => {
      // Rollback on error
      if (context?.previousData) {
        queryClient.setQueryData(['feeding', 'daily-executions', tenantId, date], context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['feeding', 'daily-executions', tenantId] });
    },
  });
}

function useSkipDailyFeeding(date: string) {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SkipFeedingInput) => {
      if (!tenantId) throw new Error('Tenant context required');

      // tenantId is automatically sent via X-Tenant-Id header by graphqlClient
      const data = await graphqlClient.request<{
        skipDailyFeeding: DailyFeedingExecution;
      }>(SKIP_DAILY_FEEDING_MUTATION, { input: {
        executionId: input.executionId,
        skipReason: input.reason,
      }});
      return { success: true, execution: data.skipDailyFeeding };
    },
    // Optimistic update for skip
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ['feeding', 'daily-executions', tenantId, date] });
      const previousData = queryClient.getQueryData(['feeding', 'daily-executions', tenantId, date]);

      queryClient.setQueryData(
        ['feeding', 'daily-executions', tenantId, date],
        (old: { executions: DailyFeedingExecution[]; summary: DailyFeedingSummary } | undefined) => {
          if (!old) return old;
          return {
            ...old,
            executions: old.executions.map((exec) =>
              exec.id === input.executionId
                ? { ...exec, status: 'SKIPPED' as FeedingStatus, skipReason: input.reason }
                : exec
            ),
          };
        }
      );

      return { previousData };
    },
    onError: (_err, _input, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['feeding', 'daily-executions', tenantId, date], context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['feeding', 'daily-executions', tenantId] });
    },
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Issue #4: Timezone issues with date formatting - Use local date formatting instead of toISOString
function formatDateLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatNumber(value: number | undefined | null, decimals = 1): string {
  if (value === undefined || value === null) return '-';
  return value.toLocaleString('tr-TR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

// Issue #15: Use STATUS_CONFIG for status display
function getStatusIcon(status: FeedingStatus): string {
  return STATUS_CONFIG[status]?.icon ?? '\u2753'; // Question mark as fallback
}

function getStatusColor(status: FeedingStatus): string {
  return STATUS_CONFIG[status]?.colorClass ?? 'bg-gray-100 text-gray-800';
}

function getStatusLabel(status: FeedingStatus): string {
  return STATUS_CONFIG[status]?.label ?? status;
}

// Issue #17: Error display sanitization
function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Remove sensitive information like stack traces, file paths, etc.
    const message = error.message;
    // Filter out potentially sensitive patterns
    const sanitized = message
      .replace(/at\s+[\w./\\]+:\d+:\d+/g, '') // Remove stack trace locations
      .replace(/\/[\w./\\]+/g, '[path]') // Replace file paths
      .replace(/tenant_\w+/g, '[tenant]') // Replace tenant identifiers
      .trim();
    return sanitized || 'An unexpected error occurred';
  }
  return 'An unexpected error occurred';
}

// Calculate feeding preview on client-side
// Issue #6 & #7: Fix division by zero and make SGR configurable
function calculateFeedingPreview(
  execution: DailyFeedingExecution,
  actualAmountKg: number
): FeedingPreview | null {
  // Validate inputs to prevent division by zero and invalid calculations
  if (actualAmountKg <= 0) return null;
  if (execution.fishCount <= 0 || execution.biomassKg <= 0) return null;

  // Issue #7: SGR - Use species data if available, otherwise use default
  // Typical SGR for salmon: 0.8-1.5% per day
  const estimatedSGR = execution.expectedSGR ?? DEFAULT_SGR_PERCENT;
  const expectedGrowthG = execution.avgWeightG * (estimatedSGR / 100);

  // New average weight
  const newAvgWeightG = execution.avgWeightG + expectedGrowthG;

  // New biomass
  const newBiomassKg = (execution.fishCount * newAvgWeightG) / 1000;

  // Actual feeding rate
  const feedingRateActualPercent = (actualAmountKg / execution.biomassKg) * 100;

  // FCR calculation (Feed Conversion Ratio)
  // FCR = Feed given / Weight gain
  const weightGainKg = (execution.fishCount * expectedGrowthG) / 1000;

  // Issue #6: Division by zero in FCR calculation when weightGainKg approaches 0
  let fcr = 0;
  if (weightGainKg > MIN_WEIGHT_GAIN_KG) {
    fcr = actualAmountKg / weightGainKg;

    // Sanity check for biological limits
    if (fcr > MAX_BIOLOGICAL_FCR) {
      console.warn(`Calculated FCR (${fcr.toFixed(2)}) exceeds biological limit of ${MAX_BIOLOGICAL_FCR}`);
    }
  }

  return {
    fcr: Math.round(fcr * 100) / 100,
    expectedGrowthG: Math.round(expectedGrowthG * 10) / 10,
    newBiomassKg: Math.round(newBiomassKg * 10) / 10,
    newAvgWeightG: Math.round(newAvgWeightG * 10) / 10,
    feedingRateActualPercent: Math.round(feedingRateActualPercent * 100) / 100,
    weightGainKg: Math.round(weightGainKg * 1000) / 1000,
  };
}

// ============================================================================
// RECORD FEEDING MODAL COMPONENT
// ============================================================================

interface RecordFeedingModalProps {
  isOpen: boolean;
  onClose: () => void;
  execution: DailyFeedingExecution;
  onSuccess: () => void;
  onSkip: (executionId: string, reason: string) => Promise<void>;
  date: string;
}

const RecordFeedingModal: React.FC<RecordFeedingModalProps> = ({
  isOpen,
  onClose,
  execution,
  onSuccess,
  onSkip,
  date,
}) => {
  const [actualAmountKg, setActualAmountKg] = useState<number>(execution.plannedAmountKg);
  const [notes, setNotes] = useState<string>('');
  // Issue #14: Add error state to keep modal open on error
  const [error, setError] = useState<string | null>(null);
  // Issue #8: Add skip mode state
  const [isSkipMode, setIsSkipMode] = useState(false);
  const [skipReason, setSkipReason] = useState<string>('');

  const recordMutation = useRecordDailyFeeding(date);
  // Issue #12: Replace alert with toast notification
  const { toast } = useToast();

  // Issue #1: Reset state when execution changes
  useEffect(() => {
    if (execution) {
      setActualAmountKg(execution.plannedAmountKg);
      setNotes('');
      setError(null);
      setIsSkipMode(false);
      setSkipReason('');
    }
  }, [execution?.id]); // Use execution.id as dependency

  // Issue #9: Fix preview dependency chain - use execution.id for stable reference
  const preview = useMemo(() => {
    if (actualAmountKg <= 0) return null;
    return calculateFeedingPreview(execution, actualAmountKg);
  }, [execution?.id, execution?.fishCount, execution?.biomassKg, execution?.avgWeightG, execution?.expectedSGR, actualAmountKg]);

  // Difference from planned
  const difference = actualAmountKg - execution.plannedAmountKg;
  const differencePercent =
    execution.plannedAmountKg > 0 ? (difference / execution.plannedAmountKg) * 100 : 0;

  // Issue #10 & #11: Input validation for maximum feed amount and NaN handling
  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;

    // Issue #11: Handle empty string properly
    if (value === '' || value === null) {
      setActualAmountKg(0);
      return;
    }

    const parsed = parseFloat(value);

    // Handle NaN
    if (Number.isNaN(parsed)) {
      setActualAmountKg(0);
      return;
    }

    // Issue #10: Validate against maximum
    if (parsed > MAX_FEED_AMOUNT_KG) {
      setError(`Maximum feed amount is ${MAX_FEED_AMOUNT_KG} kg`);
      setActualAmountKg(MAX_FEED_AMOUNT_KG);
      return;
    }

    if (parsed < 0) {
      setActualAmountKg(0);
      return;
    }

    setError(null);
    setActualAmountKg(parsed);
  };

  // Issue #12: Replace alert with toast, Issue #14: Keep modal open on error
  const handleSubmit = async () => {
    if (actualAmountKg <= 0) {
      setError('Feed amount must be greater than 0');
      return;
    }

    try {
      await recordMutation.mutateAsync({
        executionId: execution.id,
        tankId: execution.tankId,
        actualAmountKg,
        notes: notes || undefined,
      });
      toast({
        title: 'Success',
        description: `Feeding recorded for ${execution.tankName}`,
        variant: 'success',
      });
      onSuccess();
      onClose();
    } catch (err) {
      console.error('Failed to record feeding:', err);
      // Issue #14: Keep modal open on error
      const errorMessage = sanitizeErrorMessage(err);
      setError(errorMessage);
      toast({
        title: 'Error',
        description: errorMessage,
        variant: 'error',
      });
      // Don't close modal on error
    }
  };

  // Issue #8: Handle skip feeding
  const handleSkip = async () => {
    if (!skipReason.trim()) {
      setError('Please provide a reason for skipping');
      return;
    }

    try {
      await onSkip(execution.id, skipReason.trim());
      toast({
        title: 'Feeding Skipped',
        description: `Feeding skipped for ${execution.tankName}`,
        variant: 'info',
      });
      onClose();
    } catch (err) {
      console.error('Failed to skip feeding:', err);
      const errorMessage = sanitizeErrorMessage(err);
      setError(errorMessage);
      toast({
        title: 'Error',
        description: errorMessage,
        variant: 'error',
      });
    }
  };

  const handleClose = () => {
    setActualAmountKg(execution.plannedAmountKg);
    setNotes('');
    setError(null);
    setIsSkipMode(false);
    setSkipReason('');
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={isSkipMode ? 'Skip Feeding' : 'Record Feeding'} size="lg">
      <div className="space-y-6">
        {/* Error Display */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <div className="flex items-center">
              <span className="text-red-500 mr-2">{'\u26A0\uFE0F'}</span>
              <p className="text-sm text-red-700">{error}</p>
            </div>
          </div>
        )}

        {/* Tank Info (readonly) */}
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 mb-1">Tank</p>
              <p className="font-medium text-gray-900">{execution.tankName}</p>
              <p className="text-sm text-gray-500">{execution.tankCode}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Batch</p>
              <p className="font-medium text-gray-900">{execution.batchNumber}</p>
              <p className="text-sm text-gray-500">{execution.speciesCode || '-'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Fish Count</p>
              <p className="font-medium text-gray-900">{formatNumber(execution.fishCount, 0)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Avg Weight</p>
              <p className="font-medium text-gray-900">{formatNumber(execution.avgWeightG, 1)} g</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Biomass</p>
              <p className="font-medium text-gray-900">{formatNumber(execution.biomassKg, 1)} kg</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Feed Type</p>
              <p className="font-medium text-gray-900">{execution.feedName || execution.feedCode || '-'}</p>
            </div>
          </div>
        </div>

        {/* Transition Warning */}
        {execution.isTransitionDay && (
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
            <div className="flex items-start">
              <span className="text-xl mr-2">{'\u26A0\uFE0F'}</span>
              <div>
                <h4 className="font-medium text-orange-800">Feed Transition Day</h4>
                <p className="text-sm text-orange-700">
                  Transitioning from <strong>{execution.transitionFromFeed}</strong> to{' '}
                  <strong>{execution.transitionToFeed}</strong> ({execution.transitionPercent}% new feed)
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Planned Amount (readonly) */}
        <div className="bg-blue-50 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-blue-800">Planned Amount</p>
              <p className="text-xs text-blue-600">
                Feeding Rate: {formatNumber(execution.feedingRatePercent, 2)}%
              </p>
            </div>
            <p className="text-2xl font-bold text-blue-900">
              {formatNumber(execution.plannedAmountKg, 2)} kg
            </p>
          </div>
        </div>

        {/* Skip Mode UI */}
        {isSkipMode ? (
          <div>
            <label htmlFor="skipReason" className="block text-sm font-medium text-gray-700">
              Reason for Skipping <span className="text-red-500">*</span>
            </label>
            <textarea
              id="skipReason"
              rows={3}
              value={skipReason}
              onChange={(e) => setSkipReason(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Enter reason for skipping this feeding..."
            />
          </div>
        ) : (
          <>
            {/* Actual Feed Given (input) */}
            <div>
              <label htmlFor="actualAmount" className="block text-sm font-medium text-gray-700">
                Actual Feed Given (kg) <span className="text-red-500">*</span>
              </label>
              <div className="mt-1 relative">
                <input
                  type="number"
                  id="actualAmount"
                  min="0"
                  max={MAX_FEED_AMOUNT_KG}
                  step="0.1"
                  value={actualAmountKg || ''}
                  onChange={handleAmountChange}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm pr-16"
                  placeholder="Enter actual amount"
                  aria-describedby="amount-hint"
                />
                <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                  <span className="text-gray-500 sm:text-sm">kg</span>
                </div>
              </div>
              <p id="amount-hint" className="sr-only">
                Maximum allowed: {MAX_FEED_AMOUNT_KG} kg
              </p>
              {difference !== 0 && (
                <p
                  className={`mt-1 text-sm ${
                    difference > 0 ? 'text-orange-600' : 'text-green-600'
                  }`}
                >
                  {difference > 0 ? '+' : ''}
                  {formatNumber(difference, 2)} kg ({differencePercent > 0 ? '+' : ''}
                  {formatNumber(differencePercent, 1)}% from plan)
                </p>
              )}
            </div>
          </>
        )}

        {/* Preview Section - only show when not in skip mode */}
        {!isSkipMode && preview && actualAmountKg > 0 && (
          <div className="bg-gray-50 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-700 mb-3">Expected Results</h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 mb-1">FCR (Estimated)</p>
                <p
                  className={`text-xl font-bold ${
                    preview.fcr <= 1.2
                      ? 'text-green-600'
                      : preview.fcr <= 1.5
                      ? 'text-yellow-600'
                      : 'text-red-600'
                  }`}
                >
                  {formatNumber(preview.fcr, 2)}
                </p>
              </div>
              <div className="bg-white rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 mb-1">Expected Growth</p>
                <p className="text-xl font-bold text-blue-600">
                  +{formatNumber(preview.expectedGrowthG, 1)} g
                </p>
              </div>
              <div className="bg-white rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 mb-1">New Biomass</p>
                <p className="text-xl font-bold text-gray-900">
                  {formatNumber(preview.newBiomassKg, 1)} kg
                </p>
                <p className="text-xs text-gray-500">
                  (+{formatNumber(preview.newBiomassKg - execution.biomassKg, 1)} kg)
                </p>
              </div>
              <div className="bg-white rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 mb-1">New Avg Weight</p>
                <p className="text-xl font-bold text-gray-900">
                  {formatNumber(preview.newAvgWeightG, 1)} g
                </p>
                <p className="text-xs text-gray-500">
                  (+{formatNumber(preview.expectedGrowthG, 1)} g)
                </p>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-gray-200">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Actual Feeding Rate:</span>
                <span
                  className={`font-medium ${
                    Math.abs(preview.feedingRateActualPercent - execution.feedingRatePercent) < 0.2
                      ? 'text-green-600'
                      : 'text-orange-600'
                  }`}
                >
                  {formatNumber(preview.feedingRateActualPercent, 2)}% of biomass
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Notes - only show when not in skip mode */}
        {!isSkipMode && (
          <div>
            <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
              Notes (optional)
            </label>
            <textarea
              id="notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Add any observations..."
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-4 border-t">
          {/* Issue #8: Add skip button */}
          <div>
            {!isSkipMode && execution.status !== 'COMPLETED' && execution.status !== 'SKIPPED' && (
              <Button
                variant="secondary"
                onClick={() => setIsSkipMode(true)}
                className="text-gray-600 hover:text-gray-800"
              >
                Skip Feeding
              </Button>
            )}
            {isSkipMode && (
              <Button
                variant="secondary"
                onClick={() => {
                  setIsSkipMode(false);
                  setSkipReason('');
                  setError(null);
                }}
              >
                Back to Record
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            {isSkipMode ? (
              <Button
                variant="primary"
                onClick={handleSkip}
                disabled={!skipReason.trim()}
                className="bg-gray-600 hover:bg-gray-700"
              >
                Confirm Skip
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={handleSubmit}
                disabled={actualAmountKg <= 0 || recordMutation.isPending}
              >
                {recordMutation.isPending ? 'Saving...' : 'Save & Calculate'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
};

// ============================================================================
// SUMMARY CARD COMPONENT
// ============================================================================

interface SummaryCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  bgColor: string;
  iconBgColor: string;
  highlight?: boolean;
}

const SummaryCard: React.FC<SummaryCardProps> = ({
  title,
  value,
  subtitle,
  icon,
  bgColor,
  iconBgColor,
  highlight = false,
}) => (
  <div className={`rounded-lg shadow p-4 ${bgColor} ${highlight ? 'ring-2 ring-offset-2 ring-blue-500' : ''}`}>
    <div className="flex items-center">
      <div className={`flex-shrink-0 rounded-lg p-3 ${iconBgColor}`}>{icon}</div>
      <div className="ml-4">
        <p className="text-sm font-medium text-gray-500">{title}</p>
        <p className="text-2xl font-semibold text-gray-900">{value}</p>
        {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
      </div>
    </div>
  </div>
);

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const DailyFeedingDashboard: React.FC = () => {
  // State - Issue #4: Use formatDateLocal instead of formatDate
  const [selectedDate, setSelectedDate] = useState<string>(formatDateLocal(new Date()));
  const [selectedExecution, setSelectedExecution] = useState<DailyFeedingExecution | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // Issue #20: Add pagination state
  const [currentPage, setCurrentPage] = useState(1);

  // Fetch data
  const { data, isLoading, error, refetch } = useDailyFeedingExecutions(selectedDate);

  // Issue #8: Initialize skip mutation hook
  const skipMutation = useSkipDailyFeeding(selectedDate);

  // Handlers
  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedDate(e.target.value);
    setCurrentPage(1); // Reset pagination on date change
  };

  const handleRowClick = useCallback((execution: DailyFeedingExecution) => {
    setSelectedExecution(execution);
    setIsModalOpen(true);
  }, []);

  const handleModalClose = useCallback(() => {
    setIsModalOpen(false);
    setSelectedExecution(null);
  }, []);

  const handleFeedingSuccess = useCallback(() => {
    refetch();
  }, [refetch]);

  // Issue #8: Handle skip feeding
  const handleSkipFeeding = useCallback(async (executionId: string, reason: string) => {
    await skipMutation.mutateAsync({ executionId, reason });
  }, [skipMutation]);

  // Summary data
  const summary = data?.summary;
  const allExecutions = data?.executions || [];

  // Issue #20: Paginated executions
  const totalPages = Math.ceil(allExecutions.length / PAGE_SIZE);
  const paginatedExecutions = useMemo(() => {
    const startIndex = (currentPage - 1) * PAGE_SIZE;
    return allExecutions.slice(startIndex, startIndex + PAGE_SIZE);
  }, [allExecutions, currentPage]);

  // Calculate completion percentage
  const completionPercent =
    summary && summary.totalTanks > 0
      ? Math.round((summary.completedTanks / summary.totalTanks) * 100)
      : 0;

  // Issue #16: Dynamic skeleton count based on PAGE_SIZE
  const skeletonCount = Math.min(PAGE_SIZE, 8);

  // Loading state - Issue #16: Dynamic skeleton count
  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-64 mb-4" />
          <div className="grid grid-cols-4 gap-4 mb-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-200 rounded-lg" />
            ))}
          </div>
          {/* Dynamic skeleton rows based on PAGE_SIZE */}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="h-12 bg-gray-100 border-b" />
            {[...Array(skeletonCount)].map((_, i) => (
              <div key={i} className="h-16 bg-gray-50 border-b last:border-b-0" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Error state - Issue #17: Sanitize error message
  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4" role="alert">
          <h3 className="text-red-800 font-medium">Error loading feeding data</h3>
          <p className="text-red-600 text-sm mt-1">{sanitizeErrorMessage(error)}</p>
          <button
            onClick={() => refetch()}
            className="mt-3 px-4 py-2 bg-red-100 text-red-800 rounded-lg hover:bg-red-200"
            aria-label="Retry loading feeding data"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with Date Picker */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Daily Feeding Dashboard</h2>
            <p className="text-sm text-gray-500">
              Track and record daily feeding executions by tank
            </p>
          </div>
          <div className="flex items-center gap-4">
            <label htmlFor="date-picker" className="text-sm font-medium text-gray-700">Date:</label>
            <input
              type="date"
              id="date-picker"
              value={selectedDate}
              onChange={handleDateChange}
              max={formatDateLocal(new Date())}
              className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              aria-label="Select feeding date"
            />
            <button
              onClick={() => setSelectedDate(formatDateLocal(new Date()))}
              className="px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded-md"
              aria-label="Go to today"
            >
              Today
            </button>
            <button
              onClick={() => refetch()}
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
              title="Refresh"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Total Feed */}
        <SummaryCard
          title="Total Feed"
          value={`${formatNumber(summary?.totalPlannedKg || 0, 1)} kg`}
          subtitle={`Actual: ${formatNumber(summary?.totalActualKg || 0, 1)} kg`}
          bgColor="bg-white"
          iconBgColor="bg-blue-100"
          icon={
            <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          }
        />

        {/* Completed */}
        <SummaryCard
          title="Completed"
          value={summary?.completedTanks || 0}
          subtitle={`${completionPercent}% of tanks`}
          bgColor="bg-white"
          iconBgColor="bg-green-100"
          icon={
            <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        />

        {/* Pending */}
        <SummaryCard
          title="Pending"
          value={summary?.pendingTanks || 0}
          subtitle={summary?.pendingTanks ? 'Awaiting feeding' : 'All done!'}
          bgColor={summary?.pendingTanks ? 'bg-yellow-50' : 'bg-white'}
          iconBgColor={summary?.pendingTanks ? 'bg-yellow-100' : 'bg-gray-100'}
          highlight={!!summary?.pendingTanks}
          icon={
            <svg
              className={`w-6 h-6 ${summary?.pendingTanks ? 'text-yellow-600' : 'text-gray-600'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        />

        {/* Transitions */}
        <SummaryCard
          title="Transitions"
          value={summary?.transitionTanks || 0}
          subtitle={summary?.transitionTanks ? 'Feed changes today' : 'No transitions'}
          bgColor={summary?.transitionTanks ? 'bg-orange-50' : 'bg-white'}
          iconBgColor={summary?.transitionTanks ? 'bg-orange-100' : 'bg-gray-100'}
          icon={
            <svg
              className={`w-6 h-6 ${summary?.transitionTanks ? 'text-orange-600' : 'text-gray-600'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
              />
            </svg>
          }
        />
      </div>

      {/* Progress Bar */}
      {summary && summary.totalTanks > 0 && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Daily Progress</span>
            <span className="text-sm text-gray-500">
              {summary.completedTanks} / {summary.totalTanks} tanks completed
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className={`h-3 rounded-full transition-all duration-500 ${
                completionPercent === 100
                  ? 'bg-green-500'
                  : completionPercent >= 50
                  ? 'bg-blue-500'
                  : 'bg-yellow-500'
              }`}
              style={{ width: `${completionPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Data Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Feeding Executions</h3>
          <p className="text-sm text-gray-500">
            Click on a row to record feeding for that tank
            {allExecutions.length > PAGE_SIZE && (
              <span className="ml-2 text-gray-400">
                (Showing {paginatedExecutions.length} of {allExecutions.length})
              </span>
            )}
          </p>
        </div>
        <div className="overflow-x-auto">
          {/* Issue #19: Add accessibility attributes to table */}
          <table className="min-w-full divide-y divide-gray-200" role="grid" aria-label="Daily feeding executions">
            <thead className="bg-gray-50">
              <tr role="row">
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tank
                </th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Fish Count
                </th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Avg Weight (g)
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Feed
                </th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Planned (kg)
                </th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actual (kg)
                </th>
                <th scope="col" className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paginatedExecutions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-500">
                    No feeding executions found for this date
                  </td>
                </tr>
              ) : (
                paginatedExecutions.map((execution) => (
                  // Issue #19: Add accessibility attributes to table rows
                  <tr
                    key={execution.id}
                    onClick={() => handleRowClick(execution)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleRowClick(execution);
                      }
                    }}
                    role="row"
                    tabIndex={0}
                    aria-label={`${execution.tankName}, ${getStatusLabel(execution.status)}, Planned: ${execution.plannedAmountKg}kg`}
                    className={`hover:bg-gray-50 cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 ${
                      execution.status === 'COMPLETED' ? 'bg-green-50/50' : ''
                    } ${execution.status === 'SKIPPED' ? 'bg-gray-50/50 opacity-60' : ''} ${
                      execution.isTransitionDay ? 'border-l-4 border-l-orange-400' : ''
                    }`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-medium text-gray-900">{execution.tankName}</div>
                      <div className="text-sm text-gray-500">
                        {execution.batchNumber}
                        {execution.speciesCode && ` - ${execution.speciesCode}`}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900">
                      {formatNumber(execution.fishCount, 0)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900">
                      {formatNumber(execution.avgWeightG, 1)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        {execution.feedCode || '-'}
                      </div>
                      {execution.isTransitionDay && (
                        <div className="text-xs text-orange-600">
                          {'\u2192'} {execution.transitionToFeed} ({execution.transitionPercent}%)
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900">
                      {formatNumber(execution.plannedAmountKg, 2)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm">
                      {execution.actualAmountKg !== null && execution.actualAmountKg !== undefined ? (
                        <span
                          className={`font-medium ${
                            Math.abs(execution.actualAmountKg - execution.plannedAmountKg) < 0.5
                              ? 'text-green-600'
                              : 'text-orange-600'
                          }`}
                        >
                          {formatNumber(execution.actualAmountKg, 2)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    {/* Issue #15: Use status mapping for display */}
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                          execution.status
                        )}`}
                      >
                        <span className="mr-1" aria-hidden="true">{getStatusIcon(execution.status)}</span>
                        {getStatusLabel(execution.status)}
                      </span>
                      {/* Show skip reason tooltip */}
                      {execution.status === 'SKIPPED' && execution.skipReason && (
                        <span className="block text-xs text-gray-500 mt-1 truncate max-w-[120px]" title={execution.skipReason}>
                          {execution.skipReason}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Issue #20: Pagination controls */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
            <div className="text-sm text-gray-500">
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Previous page"
              >
                Previous
              </button>
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-3 py-1 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Next page"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Record Feeding Modal */}
      {selectedExecution && (
        <RecordFeedingModal
          isOpen={isModalOpen}
          onClose={handleModalClose}
          execution={selectedExecution}
          onSuccess={handleFeedingSuccess}
          onSkip={handleSkipFeeding}
          date={selectedDate}
        />
      )}
    </div>
  );
};

export default DailyFeedingDashboard;
