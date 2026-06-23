import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { List, ListInput, BlockTitle } from 'konsta/react';
import { ArrowLeft, Package, CheckCircle, AlertCircle, Hand, Settings, Radio } from 'lucide-react';
import { useState, useEffect, useCallback, ChangeEvent, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';



import { GET_TODAYS_FEEDING_PLAN } from '@/graphql/operations';
import { useAuth } from '@/hooks/useAuth';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTanks } from '@/hooks/useTanks';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
// FE-MEDIUM-054: cacheData/getCachedData are the tenant-scoped, AES-GCM-encrypted
// offline cache helpers (same last-known-good pattern used elsewhere in the app).
import { createTenantQueryKey } from '@/utils/tenant-query-keys';



// ============================================================================
// TYPES
// ============================================================================

interface FeedingExecution {
  id: string;
  equipmentId: string;
  equipmentName: string;
  equipmentCode: string;
  calculations: {
    plannedFeedKg?: number;
    feedingRatePercent?: number;
    biomassKg?: number;
    activeFeedCode?: string;
    activeFeedName?: string;
  };
  plannedFeedKg: number;
  actualFeedKg: number | null;
  status: string;
  hasTransitionWarning: boolean;
}

type FeedingMethodOption = 'manual' | 'automatic' | 'demand';

const FEEDING_METHODS: { value: FeedingMethodOption; label: string; Icon: typeof Hand }[] = [
  { value: 'manual', label: 'Manual', Icon: Hand },
  { value: 'automatic', label: 'Automatic', Icon: Settings },
  { value: 'demand', label: 'Demand', Icon: Radio },
];

interface FormErrors {
  tank?: string;
  amount?: string;
  general?: string;
}

// ============================================================================
// HOOK: useTodaysFeedingPlan
// ============================================================================

// PERF-07: Converted from manual useState/useEffect to useQuery.
// Benefits:
//   - Automatic deduplication: mount/unmount cycles do not fire extra fetches.
//   - staleTime prevents re-fetching on every isOnline toggle (network flicker).
//   - refetchOnWindowFocus brings the plan current when the worker returns to the app.
//   - Consistent caching strategy with useTanks and the rest of the app.
// FE-MEDIUM-054: cache key prefix for the last-synced feeding plan. Tenant
// isolation + AES-GCM-at-rest are handled by cacheData/getCachedData (the key is
// stored under the mandatory `cache_${tenantId}:` namespace, wiped on logout).
const FEEDING_PLAN_CACHE_PREFIX = 'feedingPlan_';
// Short TTL so an obviously-stale plan expires rather than misleading a worker
// into feeding against an outdated schedule (the offline cache is a convenience,
// not an authority — the recordFeeding write is still server-validated).
const FEEDING_PLAN_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12h

function useTodaysFeedingPlan(): {
  executions: FeedingExecution[];
  isLoading: boolean;
  isOfflineCached: boolean;
} {
  // CRIT-1 / BUG-01 / SEC-05: Read auth from useAuth hook, not from localStorage.
  // The keys 'accessToken' and 'tenantId' do not exist in localStorage — auth state
  // is managed in memory by AuthProvider (with refresh via httpOnly cookie).
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const cacheKey = `${FEEDING_PLAN_CACHE_PREFIX}${dateStr}`;

  // FE-MEDIUM-054: getCachedData is async but React Query placeholderData must be
  // synchronous, so the last-synced plan is loaded once on mount into state and
  // then handed to the query as placeholderData. This renders the last-known plan
  // immediately offline instead of an empty list.
  const [cachedSeed, setCachedSeed] = useState<FeedingExecution[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!tenantId) return;
    void getCachedData<FeedingExecution[]>(tenantId, cacheKey).then((cached) => {
      if (!cancelled && cached) {
        setCachedSeed(cached);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId, cacheKey]);

  const { data, isLoading, isSuccess } = useQuery<FeedingExecution[]>({
    queryKey: createTenantQueryKey(tenantId, 'feedingPlan', tenantId, dateStr),
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }

      const result = await graphqlRequest<{ dailyFeedingExecutions: FeedingExecution[] }>(
        GET_TODAYS_FEEDING_PLAN,
        { date: dateStr },
      );

      const executions = result.dailyFeedingExecutions ?? [];
      // FE-MEDIUM-054: write-through the last-synced plan on every successful
      // online fetch (encrypted, tenant-scoped, short TTL) so it is available
      // the next time the device is offline.
      await cacheData(tenantId, cacheKey, executions, FEEDING_PLAN_CACHE_TTL_MS);
      return executions;
    },
    // FE-MEDIUM-054: isOnline REMOVED from the gate so the query mounts offline
    // too. refetchOnReconnect (React Query default) brings it current the moment
    // connectivity returns.
    enabled: isAuthenticated && !!accessToken && !!tenantId,
    // 5-minute stale time: prevents re-fetching on brief network flickers while
    // still showing fresh data for a typical field worker's feeding session.
    staleTime: 1000 * 60 * 5,
    // Keep plan data in memory for 1 hour (survives page navigations within the session).
    gcTime: 1000 * 60 * 60,
    refetchOnWindowFocus: true,
  });

  // FE-MEDIUM-054: a successful server fetch wins; otherwise fall back to the
  // cached seed. The seed loads asynchronously on mount (getCachedData is async),
  // so we resolve the displayed plan at the CONSUMER rather than via React
  // Query's placeholderData (which only binds on first render, before the seed
  // has resolved). This makes offline render deterministic regardless of timing.
  const executions = isSuccess ? (data ?? []) : (cachedSeed ?? []);

  // We are showing the cached seed (not a resolved server result) when no
  // successful fetch has landed AND a seed exists — surface the honest
  // "offline — last-synced plan" banner. It clears the moment isSuccess flips.
  const isOfflineCached = !isSuccess && (cachedSeed?.length ?? 0) > 0;

  return { executions, isLoading, isOfflineCached };
}

// ============================================================================
// COMPONENT
// ============================================================================

export function RecordFeedingPage(): JSX.Element {
  const navigate = useNavigate();
  const { tankId } = useParams<{ tankId?: string }>();
  const { data: tanks } = useTanks();
  const { addToQueue, isOnline } = useOfflineQueue();
  const { executions, isLoading: planLoading, isOfflineCached } = useTodaysFeedingPlan();

  const [selectedTankId, setSelectedTankId] = useState(tankId || '');
  const [actualKg, setActualKg] = useState<string>('');
  const [feedingMethod, setFeedingMethod] = useState<FeedingMethodOption>('manual');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (tankId) setSelectedTankId(tankId);
  }, [tankId]);

  // Find the execution for the selected tank
  const selectedExecution = executions.find(
    (e) => e.equipmentId === selectedTankId,
  );

  const plannedKg = selectedExecution?.calculations?.plannedFeedKg ?? selectedExecution?.plannedFeedKg ?? 0;
  const feedCode = selectedExecution?.calculations?.activeFeedCode ?? '-';
  const biomassKg = selectedExecution?.calculations?.biomassKg ?? 0;
  const feedingRate = selectedExecution?.calculations?.feedingRatePercent ?? 0;
  const currentStatus = selectedExecution?.status ?? '';

  // BUG-04: Pre-fill actual amount with planned.
  // Depend on both selectedExecution?.id and plannedKg to avoid the race where
  // plannedKg is initially 0 (data not yet loaded), causing a '0.00' pre-fill
  // that never gets updated. Guard requires plannedKg > 0 before pre-filling.
  useEffect(() => {
    if (selectedExecution && plannedKg > 0 && !actualKg) {
      setActualKg(plannedKg.toFixed(2));
    }
  }, [selectedExecution?.id, plannedKg]); // eslint-disable-line react-hooks/exhaustive-deps

  // Difference
  const parsedActual = parseFloat(actualKg) || 0;
  const difference = parsedActual - plannedKg;
  const differencePercent = plannedKg > 0 ? (difference / plannedKg) * 100 : 0;

  const validateForm = useCallback((): boolean => {
    const newErrors: FormErrors = {};
    if (!selectedTankId) newErrors.tank = 'Please select a tank';
    if (!selectedExecution) newErrors.tank = 'No feeding plan for this tank today';
    if (!actualKg || parsedActual <= 0) newErrors.amount = 'Amount must be greater than 0';
    if (parsedActual > 10000) newErrors.amount = 'Amount cannot exceed 10000 kg';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [selectedTankId, selectedExecution, actualKg, parsedActual]);

  const handleSubmit = async (): Promise<void> => {
    if (!validateForm()) return;
    if (!selectedExecution) return;

    setIsSubmitting(true);
    setErrors({});

    try {
      await addToQueue('recordFeeding', {
        executionId: selectedExecution.id,
        actualKg: parsedActual,
        feedingMethod,
        notes: notes.trim() || undefined,
      });

      setShowSuccess(true);
      setTimeout(() => navigate('/'), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to record feeding';
      setErrors({ general: message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTankChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    setSelectedTankId(e.target.value);
    setActualKg('');
    setErrors((prev) => ({ ...prev, tank: undefined }));
  };

  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-green-50 dark:bg-green-900/10">
        <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-green-600" />
        </div>
        <h2 className="text-xl font-bold text-green-700 dark:text-green-300">Recorded!</h2>
        {/* BUG-08: Always show "Queued for sync" — data goes to the queue first
            regardless of online status, and syncs in the background. */}
        <p className="text-green-600 dark:text-green-400 text-sm mt-1">
          Queued for sync
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-green-600 to-green-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <Package size={22} />
            <h1 className="text-lg font-bold">Record Feeding</h1>
          </div>
        </div>
      </div>

      {/* FE-MEDIUM-054: honest provenance banner — when the displayed plan comes
          from the encrypted offline cache (not a fresh server fetch), tell the
          worker so they know it is the last-synced schedule and will refresh on
          reconnect. */}
      {isOfflineCached && (
        <div className="mx-4 mt-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 flex items-center gap-2 border border-amber-200 dark:border-amber-800">
          <AlertCircle size={18} className="text-amber-500 flex-shrink-0" />
          <span className="text-amber-700 dark:text-amber-300 text-sm">
            Offline — showing last-synced plan. It will refresh when you reconnect.
          </span>
        </div>
      )}

      {/* Error Banner */}
      {errors.general && (
        <div className="mx-4 mt-3 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex items-center gap-2 border border-red-200 dark:border-red-800">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
          <span className="text-red-600 dark:text-red-300 text-sm">{errors.general}</span>
        </div>
      )}

      {/* Tank Selector */}
      {/* WHY: Only tanks with active batches are selectable — feeding requires a batch context
          to look up the daily feeding plan and match to the correct feed program.
          Tanks without batches are shown disabled with their real ID (not empty value) so that
          the user understands which tanks exist but cannot be selected. */}
      {!tankId && (
        <>
          <BlockTitle>Select Tank</BlockTitle>
          <List strongIos insetIos>
            <ListInput type="select" value={selectedTankId} onChange={handleTankChange} error={errors.tank}>
              <option value="">-- Select Tank --</option>
              {tanks?.filter((t) => t.batchMetrics).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.code})
                </option>
              ))}
              {tanks?.filter((t) => !t.batchMetrics).map((t) => (
                <option key={t.id} value={t.id} disabled>
                  {t.name} (No active batch)
                </option>
              ))}
            </ListInput>
          </List>
          {errors.tank && <p className="text-red-500 text-sm px-4 -mt-2">{errors.tank}</p>}
          {/* FIX: Inform user when all tanks lack active batches — prevents confusion when
              every dropdown option is disabled and no selection is possible. */}
          {tanks && tanks.length > 0 && tanks.every((t) => !t.batchMetrics) && (
            <div className="mx-4 mt-2 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 border border-amber-200 dark:border-amber-800">
              <p className="text-amber-700 dark:text-amber-300 text-sm font-medium">
                All tanks currently have no active batches.
              </p>
              <p className="text-amber-600 dark:text-amber-400 text-xs mt-1">
                Stock fish into a tank before recording feeding.
              </p>
            </div>
          )}
        </>
      )}

      {/* Plan Info */}
      {selectedExecution && (
        <div className="mx-4 mt-4 bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-11 h-11 bg-green-50 dark:bg-green-900/20 rounded-xl flex items-center justify-center">
              <Package className="text-green-600" size={22} />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">{selectedExecution.equipmentName}</h3>
              <p className="text-sm text-gray-500">{selectedExecution.equipmentCode}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3">
              <p className="text-xs text-blue-600 font-medium">Planned</p>
              <p className="text-lg font-bold text-blue-900 dark:text-blue-200">{plannedKg.toFixed(2)} kg</p>
              <p className="text-xs text-blue-500">{feedingRate.toFixed(1)}% rate</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-600 font-medium">Feed</p>
              <p className="text-lg font-bold text-gray-900 dark:text-gray-200">{feedCode}</p>
              <p className="text-xs text-gray-500">{biomassKg.toFixed(1)} kg biomass</p>
            </div>
          </div>
          {/* Status */}
          {currentStatus === 'completed' && (
            <div className="mt-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 border border-amber-200 dark:border-amber-800">
              <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">
                Already completed - submitting will update the record
              </p>
            </div>
          )}
        </div>
      )}

      {/* No Plan Warning */}
      {selectedTankId && !planLoading && !selectedExecution && (
        <div className="mx-4 mt-4 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800">
          <p className="text-amber-700 dark:text-amber-300 font-medium">No feeding plan for this tank today</p>
          <p className="text-amber-600 dark:text-amber-400 text-sm mt-1">This tank doesn&apos;t have a feeding program assigned.</p>
        </div>
      )}

      {/* Actual Amount Input */}
      {selectedExecution && (
        <div className="px-4 mt-5">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Actual Amount (kg)</h3>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card p-5 border border-gray-100 dark:border-gray-800">
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              max="10000"
              value={actualKg}
              onChange={(e) => {
                setActualKg(e.target.value);
                setErrors((prev) => ({ ...prev, amount: undefined }));
              }}
              placeholder={`Planned: ${plannedKg.toFixed(2)} kg`}
              className="w-full text-center text-4xl font-bold text-gray-900 dark:text-white bg-transparent border-none focus:outline-none focus:ring-0 placeholder:text-gray-300"
            />
            <p className="text-center text-xs text-gray-400 mt-1 font-medium">kg</p>

            {/* Difference from plan */}
            {parsedActual > 0 && (
              <div className={clsx(
                'mt-3 text-center text-sm font-medium rounded-lg py-2',
                Math.abs(differencePercent) <= 5 ? 'text-green-600 bg-green-50' :
                Math.abs(differencePercent) <= 15 ? 'text-amber-600 bg-amber-50' :
                'text-red-600 bg-red-50'
              )}>
                {difference > 0 ? '+' : ''}{difference.toFixed(2)} kg ({differencePercent > 0 ? '+' : ''}{differencePercent.toFixed(1)}% from plan)
              </div>
            )}
            {errors.amount && <p className="text-red-500 text-sm text-center mt-2">{errors.amount}</p>}
          </div>
        </div>
      )}

      {/* Feeding Method */}
      {selectedExecution && (
        <div className="px-4 mt-5">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Feeding Method</h3>
          <div className="grid grid-cols-3 gap-2">
            {FEEDING_METHODS.map((m) => {
              const Icon = m.Icon;
              return (
                <button
                  key={m.value}
                  onClick={() => setFeedingMethod(m.value)}
                  className={clsx(
                    'flex flex-col items-center p-4 rounded-2xl border-2 transition-all touch-feedback bg-white dark:bg-gray-900',
                    feedingMethod === m.value
                      ? 'border-green-500 bg-green-50 dark:bg-green-900/20 shadow-glow-green'
                      : 'border-gray-100 dark:border-gray-800'
                  )}
                >
                  <Icon size={24} className={feedingMethod === m.value ? 'text-green-600' : 'text-gray-400'} />
                  <span className="text-xs font-semibold mt-1.5">{m.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Notes */}
      {selectedExecution && (
        <>
          <BlockTitle>Notes (Optional)</BlockTitle>
          <List strongIos insetIos>
            <ListInput
              type="textarea"
              placeholder="Additional observations..."
              value={notes}
              onInput={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
              inputClassName="!h-24"
            />
          </List>
        </>
      )}

      {/* Submit Button */}
      {selectedExecution && (
        <div className="px-4 pb-28">
          <button
            onClick={() => { void handleSubmit(); }}
            disabled={!selectedTankId || !selectedExecution || parsedActual <= 0 || isSubmitting}
            className="w-full py-4 bg-gradient-to-r from-green-600 to-green-500 text-white font-bold rounded-2xl shadow-lg shadow-green-500/25 disabled:opacity-50 disabled:cursor-not-allowed touch-feedback transition-all flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                Recording...
              </>
            ) : (
              <>
                <Package size={20} />
                Record {parsedActual > 0 ? `${parsedActual.toFixed(2)} kg` : 'Feeding'}
              </>
            )}
          </button>
          {!isOnline && (
            <p className="text-center text-amber-500 text-sm mt-3 font-medium">
              Offline - will sync when connected
            </p>
          )}
        </div>
      )}
    </div>
  );
}
