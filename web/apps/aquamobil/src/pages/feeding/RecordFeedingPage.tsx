/**
 * RecordFeedingPage — öğün-merkezli mobil yemleme kaydı (Faz 6 cutover, P-26).
 *
 * Kaynak: `feedingDayPlans` TİPLİ sorgusu (P-25 — `snapshot` jsonb tele
 * çıkmaz; eski motorun opak `calculations` blob'u öldü). Kayıt:
 * `recordMealFeeding` offline kuyruğu üzerinden (zarf enqueue'da damgalanır —
 * C-17; kısmi döküm D-8: `finalize` operatörün "öğün bitti" onayıdır).
 *
 * FE-MEDIUM-054 davranışı korunur: son eşitlenen plan şifreli tenant-scoped
 * cache'e yazılır ve çevrimdışı açılışta dürüst bir bantla gösterilir.
 * Enum alanları tel üzerinde AD taşır ('SCHEDULED', 'FED', ...).
 */
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { List, ListInput, BlockTitle } from 'konsta/react';
import { ArrowLeft, Package, AlertCircle, Hand, Settings, Radio, Thermometer } from 'lucide-react';
import { useState, useEffect, ChangeEvent, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AlreadyRecordedNotice } from '@/components/AlreadyRecordedNotice';
import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import { GET_FEEDING_DAY_PLANS } from '@/graphql/operations';
import { useAuth } from '@/hooks/useAuth';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useI18n } from '@/i18n';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { logger } from '@/utils/logger';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// ============================================================================
// TYPES — feedingDayPlans tipli sorgusunun aynası (P-25)
// ============================================================================

type MealStatus = 'SCHEDULED' | 'FED' | 'PARTIALLY_FED' | 'SKIPPED' | 'MISSED' | 'CANCELLED';

interface DayPlanMeal {
  id: string;
  mealIndex: number;
  scheduledAt: string;
  percentOfDaily: number;
  plannedKg: number;
  status: MealStatus;
  actualKg: number;
  varianceKg: number | null;
  variancePercent: number | null;
  feedId: string;
  fedAt?: string | null;
  feedingMethod?: string | null;
  notes?: string | null;
}

interface FeedingDayPlanSlice {
  id: string;
  unitId: string;
  unitName: string;
  unitCode: string;
  planDate: string;
  status: string;
  plannedTotalKg: number;
  unplannedActualKg: number;
  mealsPlanned: number;
  avgWeightG: number;
  fishCount: number;
  biomassKg: number;
  waterTempC: number | null;
  temperatureSource: string;
  usingDefaultTemperature: boolean;
  feedId: string;
  feedCode: string;
  feedName: string;
  effectiveRatePercent: number;
  expectedFcr: number;
  meals: DayPlanMeal[];
}

type FeedingMethodOption = 'manual' | 'automatic' | 'demand';

const FEEDING_METHODS: {
  value: FeedingMethodOption;
  labelKey: 'feeding.method.manual' | 'feeding.method.automatic' | 'feeding.method.demand';
  Icon: typeof Hand;
}[] = [
  { value: 'manual', labelKey: 'feeding.method.manual', Icon: Hand },
  { value: 'automatic', labelKey: 'feeding.method.automatic', Icon: Settings },
  { value: 'demand', labelKey: 'feeding.method.demand', Icon: Radio },
];

const MEAL_BADGE: Record<MealStatus, string> = {
  SCHEDULED: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  FED: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  PARTIALLY_FED: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  SKIPPED: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  MISSED: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  CANCELLED: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

/** Döküm alınabilen öğünler (D-8): planlı veya yarım kalmış. */
function isMealOpen(meal: DayPlanMeal): boolean {
  return meal.status === 'SCHEDULED' || meal.status === 'PARTIALLY_FED';
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ============================================================================
// HOOK: useTodaysDayPlans — FE-MEDIUM-054 offline-cache davranışı korunur
// ============================================================================

const DAY_PLANS_CACHE_PREFIX = 'feedingDayPlans_';
// Kısa TTL: bariz bayat bir plan işçiyi yanıltmaktansa süresi dolsun (cache
// kolaylıktır, otorite değildir — recordMealFeeding sunucuda doğrulanır).
const DAY_PLANS_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12h

function useTodaysDayPlans(): {
  plans: FeedingDayPlanSlice[];
  isLoading: boolean;
  isOfflineCached: boolean;
} {
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const cacheKey = `${DAY_PLANS_CACHE_PREFIX}${dateStr}`;

  const [cachedSeed, setCachedSeed] = useState<FeedingDayPlanSlice[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!tenantId) return;
    getCachedData<FeedingDayPlanSlice[]>(tenantId, cacheKey)
      .then((cached) => {
        if (!cancelled && cached) {
          setCachedSeed(cached);
        }
      })
      .catch((error: unknown) => {
        logger.error('[RecordFeedingPage] failed to load cached day-plan seed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, cacheKey]);

  const { data, isLoading, isSuccess } = useQuery<FeedingDayPlanSlice[]>({
    queryKey: createTenantQueryKey(tenantId, 'feedingDayPlans', tenantId, dateStr),
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }
      const result = await graphqlRequest<{ feedingDayPlans: FeedingDayPlanSlice[] }>(
        GET_FEEDING_DAY_PLANS,
        { planDate: dateStr },
      );
      const plans = result.feedingDayPlans ?? [];
      await cacheData(tenantId, cacheKey, plans, DAY_PLANS_CACHE_TTL_MS);
      return plans;
    },
    enabled: isAuthenticated && !!accessToken && !!tenantId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 60,
    refetchOnWindowFocus: true,
  });

  const plans = isSuccess ? (data ?? []) : (cachedSeed ?? []);
  const isOfflineCached = !isSuccess && (cachedSeed?.length ?? 0) > 0;

  return { plans, isLoading, isOfflineCached };
}

// ============================================================================
// COMPONENT
// ============================================================================

interface FormErrors {
  amount?: string;
  general?: string;
}

export function RecordFeedingPage(): JSX.Element {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { tankId } = useParams<{ tankId?: string }>();
  const { addToQueue, isOnline } = useOfflineQueue();
  const { plans, isLoading: plansLoading, isOfflineCached } = useTodaysDayPlans();

  const [selectedUnitId, setSelectedUnitId] = useState(tankId || '');
  const [selectedMealId, setSelectedMealId] = useState<string>('');
  const [pourKg, setPourKg] = useState<string>('');
  const [finalize, setFinalize] = useState(true);
  const [feedingMethod, setFeedingMethod] = useState<FeedingMethodOption>('manual');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Two-phase success UX (C7): the badge tracks the queued op's real sync
  // status; a deduped double-tap renders "Already recorded" (FE-HIGH-050).
  const [queuedOperationId, setQueuedOperationId] = useState('');
  const [wasDuplicate, setWasDuplicate] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (tankId) setSelectedUnitId(tankId);
  }, [tankId]);

  const selectedPlan = plans.find((plan) => plan.unitId === selectedUnitId);
  const meals = [...(selectedPlan?.meals ?? [])].sort((a, b) => a.mealIndex - b.mealIndex);
  const selectedMeal = meals.find((meal) => meal.id === selectedMealId);

  // Öğün seçimi olay-güdümlü: seçim anında kalan plan miktarı ön-dolur
  // (kısmi dökümde kalan kadar) — effect + bağımlılık istisnası gerekmez.
  const handleMealSelect = (meal: DayPlanMeal): void => {
    const nextId = meal.id === selectedMealId ? '' : meal.id;
    setSelectedMealId(nextId);
    if (nextId) {
      const remaining = Math.max(0, meal.plannedKg - meal.actualKg);
      setPourKg(remaining > 0 ? remaining.toFixed(2) : '');
      setFinalize(true);
    } else {
      setPourKg('');
    }
    setErrors({});
  };

  const parsedPour = parseFloat(pourKg) || 0;
  const mealsDone = meals.filter((m) => m.status === 'FED' || m.status === 'SKIPPED').length;
  const mealsTotal = meals.filter((m) => m.status !== 'CANCELLED').length;

  const validate = (): boolean => {
    const next: FormErrors = {};
    if (!pourKg || parsedPour <= 0) next.amount = t('feeding.errors.amountRequired');
    if (parsedPour > 10000) next.amount = t('feeding.errors.amountMax');
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (): Promise<void> => {
    if (!selectedMeal || !validate()) return;

    setIsSubmitting(true);
    setErrors({});
    try {
      const result = await addToQueue('recordMealFeeding', {
        mealId: selectedMeal.id,
        pourKg: parsedPour,
        finalize,
        feedingMethod,
        notes: notes.trim() || undefined,
      });
      setQueuedOperationId(result.id);
      setWasDuplicate(result.status === 'duplicate');
      setTimeout(() => navigate('/'), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('feeding.errors.generic');
      setErrors({ general: message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUnitChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    setSelectedUnitId(e.target.value);
    setSelectedMealId('');
    setPourKg('');
    setErrors({});
  };

  // Kayıt her zaman önce kuyruğa gider; ekran gerçek eşitleme durumunu gösterir
  // (Queued → Syncing → Confirmed / Sync Failed), yeşil "kaydedildi" değil.
  if (queuedOperationId !== '') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-amber-50 dark:bg-amber-900/10">
        {wasDuplicate ? (
          <AlreadyRecordedNotice />
        ) : (
          <QueuedStatusBadge operationId={queuedOperationId} />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-green-600 to-green-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button
            onClick={() => navigate(-1)}
            className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback"
          >
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <Package size={22} />
            <h1 className="text-lg font-bold">{t('feeding.title')}</h1>
          </div>
        </div>
      </div>

      {/* FE-MEDIUM-054: dürüst kaynak bandı — plan şifreli offline cache'ten
          geliyorsa işçiye söyle. */}
      {isOfflineCached && (
        <div className="mx-4 mt-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 flex items-center gap-2 border border-amber-200 dark:border-amber-800">
          <AlertCircle size={18} className="text-amber-500 flex-shrink-0" />
          <span className="text-amber-700 dark:text-amber-300 text-sm">
            {t('feeding.offlineCachedBanner')}
          </span>
        </div>
      )}

      {errors.general && (
        <div className="mx-4 mt-3 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex items-center gap-2 border border-red-200 dark:border-red-800">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
          <span className="text-red-600 dark:text-red-300 text-sm">{errors.general}</span>
        </div>
      )}

      {/* Ünite seçimi — bugünün gün planları (protokol atanmış üniteler) */}
      {!tankId && (
        <>
          <BlockTitle>{t('feeding.selectUnit')}</BlockTitle>
          <List strongIos insetIos>
            <ListInput type="select" value={selectedUnitId} onChange={handleUnitChange}>
              <option value="">{t('feeding.selectUnitPlaceholder')}</option>
              {plans.map((plan) => (
                <option key={plan.unitId} value={plan.unitId}>
                  {plan.unitName} ({plan.unitCode})
                </option>
              ))}
            </ListInput>
          </List>
          {!plansLoading && plans.length === 0 && (
            <div className="mx-4 mt-2 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 border border-amber-200 dark:border-amber-800">
              <p className="text-amber-700 dark:text-amber-300 text-sm font-medium">
                {t('feeding.noPlansToday')}
              </p>
              <p className="text-amber-600 dark:text-amber-400 text-xs mt-1">
                {t('feeding.noPlansTodayHint')}
              </p>
            </div>
          )}
        </>
      )}

      {/* Ünitesi param'dan gelip planı olmayan durum */}
      {selectedUnitId && !plansLoading && !selectedPlan && (
        <div className="mx-4 mt-4 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800">
          <p className="text-amber-700 dark:text-amber-300 font-medium">
            {t('feeding.noPlanForUnit')}
          </p>
          <p className="text-amber-600 dark:text-amber-400 text-sm mt-1">
            {t('feeding.noPlanForUnitHint')}
          </p>
        </div>
      )}

      {/* Plan kartı — tipli alanlar (P-25) */}
      {selectedPlan && (
        <div className="mx-4 mt-4 bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border border-gray-100 dark:border-gray-800">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 bg-green-50 dark:bg-green-900/20 rounded-xl flex items-center justify-center">
                <Package className="text-green-600" size={22} />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-white">
                  {selectedPlan.unitName}
                </h3>
                <p className="text-sm text-gray-500">{selectedPlan.unitCode}</p>
              </div>
            </div>
            <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">
              {t('feeding.progress', { done: mealsDone, total: mealsTotal })}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3">
              <p className="text-xs text-blue-600 font-medium">{t('feeding.plannedTotal')}</p>
              <p className="text-lg font-bold text-blue-900 dark:text-blue-200">
                {Number(selectedPlan.plannedTotalKg).toFixed(2)} kg
              </p>
              <p className="text-xs text-blue-500">
                {t('feeding.rate')} {Number(selectedPlan.effectiveRatePercent).toFixed(2)}% ·{' '}
                {t('feeding.expectedFcr')} {Number(selectedPlan.expectedFcr).toFixed(2)}
              </p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3">
              <p className="text-xs text-gray-600 dark:text-gray-400 font-medium">
                {t('feeding.feed')}
              </p>
              <p className="text-lg font-bold text-gray-900 dark:text-gray-200">
                {selectedPlan.feedCode}
              </p>
              <p className="text-xs text-gray-500">
                {t('feeding.biomass')} {Number(selectedPlan.biomassKg).toFixed(1)} kg
              </p>
            </div>
          </div>
          {/* Sıcaklık provenansı — P-20: sessiz varsayılan yok */}
          <div className="mt-3 flex items-center gap-2 text-xs">
            <Thermometer size={14} className="text-gray-400" />
            {selectedPlan.usingDefaultTemperature ? (
              <span className="text-amber-600 dark:text-amber-400 font-medium">
                {t('feeding.defaultTempWarning')}
              </span>
            ) : (
              <span className="text-gray-500">
                {t('feeding.waterTemp')}: {Number(selectedPlan.waterTempC ?? 0).toFixed(1)}°C (
                {selectedPlan.temperatureSource})
              </span>
            )}
          </div>
        </div>
      )}

      {/* Öğün listesi */}
      {selectedPlan && (
        <div className="px-4 mt-5">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
            {t('feeding.meals')}
          </h3>
          <div className="space-y-2">
            {meals.map((meal) => {
              const open = isMealOpen(meal);
              const selected = meal.id === selectedMealId;
              return (
                <button
                  key={meal.id}
                  disabled={!open}
                  onClick={() => handleMealSelect(meal)}
                  className={clsx(
                    'w-full text-left bg-white dark:bg-gray-900 rounded-2xl p-3 border-2 transition-all touch-feedback',
                    selected
                      ? 'border-green-500 shadow-glow-green'
                      : 'border-gray-100 dark:border-gray-800',
                    !open && 'opacity-60',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-base font-bold text-gray-900 dark:text-white">
                        {timeOf(meal.scheduledAt)}
                      </span>
                      <span className="text-sm text-gray-500">
                        {t('feeding.meal', { index: meal.mealIndex + 1 })}
                      </span>
                    </div>
                    <span
                      className={clsx(
                        'text-xs font-semibold px-2 py-1 rounded-lg',
                        MEAL_BADGE[meal.status],
                      )}
                    >
                      {t(`feeding.mealStatus.${meal.status}`)}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    {Number(meal.plannedKg).toFixed(2)} kg
                    {meal.actualKg > 0 && (
                      <span className="ml-2 text-blue-600 dark:text-blue-400">
                        → {Number(meal.actualKg).toFixed(2)} kg
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Döküm formu */}
      {selectedMeal && (
        <>
          <div className="px-4 mt-5">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
              {t('feeding.pour.amountTitle')}
            </h3>
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card p-5 border border-gray-100 dark:border-gray-800">
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                max="10000"
                value={pourKg}
                onChange={(e) => {
                  setPourKg(e.target.value);
                  setErrors((prev) => ({ ...prev, amount: undefined }));
                }}
                className="w-full text-center text-4xl font-bold text-gray-900 dark:text-white bg-transparent border-none focus:outline-none focus:ring-0 placeholder:text-gray-300"
              />
              <p className="text-center text-xs text-gray-400 mt-1 font-medium">kg</p>
              <p className="text-center text-xs text-gray-500 mt-1">
                {t('feeding.pour.remaining', {
                  kg: Math.max(0, selectedMeal.plannedKg - selectedMeal.actualKg).toFixed(2),
                })}
              </p>
              {errors.amount && (
                <p className="text-red-500 text-sm text-center mt-2">{errors.amount}</p>
              )}
            </div>

            {/* Finalize — D-8 kısmi öğün: kapatmadan döküm eklenebilir */}
            <div className="mt-3 flex items-start gap-3 bg-white dark:bg-gray-900 rounded-2xl p-4 border border-gray-100 dark:border-gray-800">
              <input
                id="finalize-meal"
                type="checkbox"
                checked={finalize}
                onChange={(e) => setFinalize(e.target.checked)}
                className="mt-0.5 h-5 w-5 rounded accent-green-600"
              />
              <span>
                <label
                  htmlFor="finalize-meal"
                  className="block text-sm font-semibold text-gray-900 dark:text-white"
                >
                  {t('feeding.pour.finalize')}
                </label>
                <span className="block text-xs text-gray-500 mt-0.5">
                  {t('feeding.pour.finalizeHint')}
                </span>
              </span>
            </div>
          </div>

          {/* Yöntem */}
          <div className="px-4 mt-5">
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
              {t('feeding.method.title')}
            </h3>
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
                        : 'border-gray-100 dark:border-gray-800',
                    )}
                  >
                    <Icon
                      size={24}
                      className={feedingMethod === m.value ? 'text-green-600' : 'text-gray-400'}
                    />
                    <span className="text-xs font-semibold mt-1.5">{t(m.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Notlar */}
          <BlockTitle>{t('feeding.notes.title')}</BlockTitle>
          <List strongIos insetIos>
            <ListInput
              type="textarea"
              placeholder={t('feeding.notes.placeholder')}
              value={notes}
              onInput={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
              inputClassName="!h-24"
            />
          </List>

          {/* Kaydet */}
          <div className="px-4 pb-28">
            <button
              onClick={() => {
                void handleSubmit();
              }}
              disabled={parsedPour <= 0 || isSubmitting}
              className="w-full py-4 bg-gradient-to-r from-green-600 to-green-500 text-white font-bold rounded-2xl shadow-lg shadow-green-500/25 disabled:opacity-50 disabled:cursor-not-allowed touch-feedback transition-all flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                  {t('feeding.recording')}
                </>
              ) : (
                <>
                  <Package size={20} />
                  {parsedPour > 0
                    ? t('feeding.recordKg', { kg: parsedPour.toFixed(2) })
                    : t('feeding.record')}
                </>
              )}
            </button>
            {!isOnline && (
              <p className="text-center text-amber-500 text-sm mt-3 font-medium">
                {t('feeding.offlineWillSync')}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
