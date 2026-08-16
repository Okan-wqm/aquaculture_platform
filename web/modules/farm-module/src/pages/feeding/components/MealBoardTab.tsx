/**
 * MealBoardTab — günün öğünleri, ünite bazında (Faz 6).
 *
 * Legacy günlük-plan/execution sekmelerinin varisi (öncülleri Faz 8'de
 * silindi): veri kaynağı v2 motorunun
 * `feedingDayPlans` sorgusudur (legacy execution'lar değil). Kısmi döküm
 * akışı (D-8): "döküm ekle" kümülatif kg biriktirir, "öğünü bitir" finalize
 * eder (varyans + büyüme + kalan öğün recalc'ı BACKEND'de aynı tx'te koşar).
 * Az-atım rozeti hem öğün hem gün seviyesinde görünür (D-16); plansız-atama
 * şeridi D-5 görünürlüğünün pano bacağıdır. `recordMealFeeding` stok düşüren
 * komut olduğundan zarf ZORUNLUDUR (C-17) — hook zarfı üretir.
 */
import React, { useMemo, useState } from 'react';
import { Modal, useCanMutate, useI18n, type MessageKey } from '@aquaculture/shared-ui';
import {
  FEEDING_MEAL_MOBILE_COMMAND_V1,
  FEEDING_MEAL_QUANTITY_POLICY_V1,
  decodeFeedingMealQuantityKgV1,
} from '@aquaculture/feeding-contracts';
import {
  useFeedingDayPlans,
  useFeedingProtocolsV2,
  useProtocolAssignments,
  useRecordMealFeeding,
  useFinalizeMeal,
  useSkipMeal,
  useCorrectMealPour,
  useRegenerateDayPlan,
  type FeedingDayPlanView,
  type FeedingMealView,
  type FeedingDayPlanStatus,
  type FeedingMealStatus,
  type FcrResolvedSource,
} from '../../../hooks/useProtocolFeeding';
import { useSiteList } from '../../../hooks/useSites';

// ============================================================================
// HELPERS
// ============================================================================

// Anahtarlar tel değerleridir: GraphQL enum'ları AD serileştirir (kasa kuralı
// useProtocolFeeding.ts başında).
const MEAL_STATUS_KEY: Record<FeedingMealStatus, MessageKey> = {
  SCHEDULED: 'feedingV2.mealBoard.status.scheduled',
  FED: 'feedingV2.mealBoard.status.fed',
  PARTIALLY_FED: 'feedingV2.mealBoard.status.partiallyFed',
  SKIPPED: 'feedingV2.mealBoard.status.skipped',
  MISSED: 'feedingV2.mealBoard.status.missed',
  CANCELLED: 'feedingV2.mealBoard.status.cancelled',
};

const MEAL_STATUS_BADGE: Record<FeedingMealStatus, string> = {
  SCHEDULED: 'bg-gray-100 text-gray-700',
  FED: 'bg-green-100 text-green-800',
  PARTIALLY_FED: 'bg-blue-100 text-blue-800',
  SKIPPED: 'bg-yellow-100 text-yellow-800',
  MISSED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-gray-100 text-gray-500',
};

const READINESS_BADGE: Record<
  NonNullable<FeedingMealView['readiness']>['status'],
  string
> = {
  ready: 'bg-green-50 text-green-700',
  low_oxygen: 'bg-red-50 text-red-700',
  no_reading: 'bg-amber-50 text-amber-800',
  not_instrumented: 'bg-amber-50 text-amber-800',
};

const READINESS_LABEL: Record<
  NonNullable<FeedingMealView['readiness']>['status'],
  MessageKey
> = {
  ready: 'feedingV2.mealBoard.readiness.ready',
  low_oxygen: 'feedingV2.mealBoard.readiness.lowOxygen',
  no_reading: 'feedingV2.mealBoard.readiness.noReading',
  not_instrumented: 'feedingV2.mealBoard.readiness.notInstrumented',
};

const PLAN_STATUS_KEY: Record<FeedingDayPlanStatus, MessageKey> = {
  PLANNED: 'feedingV2.mealBoard.planStatus.planned',
  IN_PROGRESS: 'feedingV2.mealBoard.planStatus.in_progress',
  COMPLETED: 'feedingV2.mealBoard.planStatus.completed',
  SKIPPED: 'feedingV2.mealBoard.planStatus.skipped',
  CANCELLED: 'feedingV2.mealBoard.planStatus.cancelled',
};

const FCR_SOURCE_KEY: Record<FcrResolvedSource, MessageKey> = {
  override: 'feedingV2.mealBoard.fcrSource.override',
  band: 'feedingV2.mealBoard.fcrSource.band',
  matrix: 'feedingV2.mealBoard.fcrSource.matrix',
  feed: 'feedingV2.mealBoard.fcrSource.feed',
};

/**
 * D-2 uyarı eşiği: batch'ler arası ağırlık-CV'si bunu aşarsa tank ortalaması
 * içindeki heterojenlik operatöre karışık-tank rozetinin yanında gösterilir
 * (sunum eşiği — hesap BE snapshot'ından gelir).
 */
const HIGH_WEIGHT_CV_WARNING_PERCENT = 25;

function localDay(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function actualTotalOf(plan: FeedingDayPlanView): number {
  const meals = plan.meals ?? [];
  return (
    meals.reduce((acc, meal) => acc + Number(meal.actualKg || 0), 0) +
    Number(plan.unplannedActualKg || 0)
  );
}

// ============================================================================
// COMPONENT
// ============================================================================

interface PourModalState {
  meal: FeedingMealView;
  unitCode: string;
}

interface CorrectModalState {
  meal: FeedingMealView;
  pourIndex: number;
}

export function MealBoardTab(): React.ReactElement {
  const { t } = useI18n();
  const canRecord = useCanMutate(FEEDING_MEAL_MOBILE_COMMAND_V1.operationType);
  const canSkip = useCanMutate('skipMeal');
  const canFinalize = useCanMutate('finalizeMeal');
  const canCorrect = useCanMutate('correctMealPour');
  const canRegenerate = useCanMutate('regenerateDayPlan');

  const [planDate, setPlanDate] = useState(localDay());
  const [siteId, setSiteId] = useState<string>('');

  const { data: plans, isLoading, isError } = useFeedingDayPlans(planDate, siteId || undefined);
  const { data: protocols } = useFeedingProtocolsV2();
  const { data: assignments } = useProtocolAssignments({ status: 'ACTIVE' });
  const { data: sitesPage } = useSiteList();

  const recordMeal = useRecordMealFeeding();
  const skipMeal = useSkipMeal();
  const finalizeMeal = useFinalizeMeal();
  const correctPour = useCorrectMealPour();
  const regenerate = useRegenerateDayPlan();

  const [pourModal, setPourModal] = useState<PourModalState | null>(null);
  const [pourKg, setPourKg] = useState('');
  const [finalize, setFinalize] = useState(false);
  const [skipModalMeal, setSkipModalMeal] = useState<FeedingMealView | null>(null);
  const [skipReason, setSkipReason] = useState('');
  const [correctModal, setCorrectModal] = useState<CorrectModalState | null>(null);
  const [correctedKg, setCorrectedKg] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const underfeedThresholdByProtocol = useMemo(() => {
    const map = new Map<string, number>();
    for (const protocol of protocols?.items ?? []) {
      map.set(protocol.id, protocol.settings.underfeedAlertThresholdPercent ?? 15);
    }
    return map;
  }, [protocols]);

  // D-5 pano şeridi: aktif ataması olup bu tarih için planı olmayan üniteler.
  const plannedUnitIds = useMemo(() => new Set((plans ?? []).map((plan) => plan.unitId)), [plans]);
  const unplannedAssignments = useMemo(
    () =>
      (assignments?.items ?? []).filter(
        (assignment) =>
          !plannedUnitIds.has(assignment.unitId) && (!siteId || assignment.siteId === siteId),
      ),
    [assignments, plannedUnitIds, siteId],
  );

  const submitPour = async (): Promise<void> => {
    if (!pourModal) return;
    setActionError(null);
    let kg: number;
    try {
      kg = decodeFeedingMealQuantityKgV1(Number(pourKg), 'meal-board pourKg');
    } catch {
      setActionError(
        t('feedingV2.mealBoard.quantityInvalid', {
          minimumKg: FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg,
          maximumKg: FEEDING_MEAL_QUANTITY_POLICY_V1.maximumKg,
          stepKg: FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg,
        }),
      );
      return;
    }
    try {
      await recordMeal.mutateAsync({ mealId: pourModal.meal.id, pourKg: kg, finalize });
      setPourModal(null);
      setPourKg('');
      setFinalize(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const submitSkip = async (): Promise<void> => {
    if (!skipModalMeal || !skipReason.trim()) return;
    setActionError(null);
    try {
      await skipMeal.mutateAsync({ mealId: skipModalMeal.id, reason: skipReason.trim() });
      setSkipModalMeal(null);
      setSkipReason('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const submitFinalize = async (meal: FeedingMealView): Promise<void> => {
    if (!window.confirm(t('feedingV2.mealBoard.finalizeExistingConfirm'))) return;
    setActionError(null);
    try {
      await finalizeMeal.mutateAsync(meal.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const submitCorrection = async (): Promise<void> => {
    if (!correctModal) return;
    setActionError(null);
    let kg: number;
    try {
      kg = decodeFeedingMealQuantityKgV1(Number(correctedKg), 'meal-board correctedKg');
    } catch {
      setActionError(
        t('feedingV2.mealBoard.quantityInvalid', {
          minimumKg: FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg,
          maximumKg: FEEDING_MEAL_QUANTITY_POLICY_V1.maximumKg,
          stepKg: FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg,
        }),
      );
      return;
    }
    try {
      await correctPour.mutateAsync({
        mealId: correctModal.meal.id,
        pourIndex: correctModal.pourIndex,
        correctedKg: kg,
      });
      setCorrectModal(null);
      setCorrectedKg('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const onRegenerate = async (plan: FeedingDayPlanView): Promise<void> => {
    if (!window.confirm(t('feedingV2.mealBoard.regenerateConfirm', { unit: plan.unitCode }))) {
      return;
    }
    setActionError(null);
    try {
      await regenerate.mutateAsync(plan.unitId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t('feedingV2.mealBoard.title')}</h2>
          <p className="text-sm text-gray-500">{t('feedingV2.mealBoard.subtitle')}</p>
        </div>
        <div className="flex items-end gap-3">
          <label className="block text-sm">
            <span className="text-gray-600">{t('feedingV2.mealBoard.date')}</span>
            <input
              type="date"
              value={planDate}
              onChange={(event) => setPlanDate(event.target.value)}
              className="mt-1 block rounded-md border-gray-300 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">{t('feedingV2.mealBoard.site')}</span>
            <select
              value={siteId}
              onChange={(event) => setSiteId(event.target.value)}
              className="mt-1 block rounded-md border-gray-300 text-sm"
            >
              <option value="">{t('feedingV2.mealBoard.allSites')}</option>
              {(sitesPage?.items ?? []).map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {actionError && (
        <div className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">{actionError}</div>
      )}

      {isError && (
        <div className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {t('feedingV2.mealBoard.loadError')}
        </div>
      )}

      {unplannedAssignments.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-sm font-medium text-amber-800">
            {t('feedingV2.mealBoard.unplannedUnits')}
          </div>
          <div className="mt-1 flex flex-wrap gap-2">
            {unplannedAssignments.map((assignment) => (
              <span
                key={assignment.id}
                className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
              >
                {assignment.unitCode}
              </span>
            ))}
          </div>
        </div>
      )}

      {isLoading && <div className="py-8 text-center text-sm text-gray-500">…</div>}

      {!isLoading && (plans ?? []).length === 0 && (
        <div className="rounded-md border border-dashed border-gray-300 py-10 text-center text-sm text-gray-500">
          {t('feedingV2.mealBoard.empty')}
        </div>
      )}

      {(plans ?? []).map((plan) => {
        const actualTotal = actualTotalOf(plan);
        const planned = Number(plan.plannedTotalKg || 0);
        const dayVariancePercent = planned > 0 ? ((actualTotal - planned) / planned) * 100 : 0;
        const threshold = underfeedThresholdByProtocol.get(plan.protocolId) ?? 15;
        const dayUnderfed =
          planned > 0 &&
          (plan.status === 'COMPLETED' || plan.status === 'IN_PROGRESS') &&
          dayVariancePercent < -threshold;
        const lastRecalc = plan.recalcLog[plan.recalcLog.length - 1];
        const snapshot = plan.snapshot;
        const resolution = plan.resolution;

        return (
          <div key={plan.id} className="rounded-lg border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="text-base font-semibold text-gray-900">{plan.unitCode}</span>
                <span className="text-sm text-gray-500">{plan.unitName}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    plan.status === 'COMPLETED'
                      ? 'bg-green-100 text-green-800'
                      : plan.status === 'IN_PROGRESS'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {t(PLAN_STATUS_KEY[plan.status])}
                </span>
                {dayUnderfed && (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">
                    {t('feedingV2.mealBoard.underfed')} {dayVariancePercent.toFixed(1)}%
                  </span>
                )}
                {snapshot.mixedBatch && (
                  <span
                    className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-800"
                    title={t('feedingV2.mealBoard.mixedBatchTitle')}
                  >
                    {t('feedingV2.mealBoard.mixedBatch')}
                  </span>
                )}
                {snapshot.mixedBatch &&
                  (snapshot.weightCvPercent ?? 0) > HIGH_WEIGHT_CV_WARNING_PERCENT && (
                    <span
                      className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
                      title={t('feedingV2.mealBoard.highWeightCvTitle')}
                    >
                      {t('feedingV2.mealBoard.highWeightCv')}{' '}
                      {(snapshot.weightCvPercent ?? 0).toFixed(0)}%
                    </span>
                  )}
              </div>
              <div className="flex items-center gap-3 text-sm text-gray-600">
                <span>
                  {t('feedingV2.mealBoard.planned')}: <strong>{planned.toFixed(2)} kg</strong>
                </span>
                <span>
                  {t('feedingV2.mealBoard.actual')}: <strong>{actualTotal.toFixed(2)} kg</strong>
                </span>
                {Number(plan.unplannedActualKg) > 0 && (
                  <span className="text-amber-700">
                    {t('feedingV2.mealBoard.unplanned')}:{' '}
                    {Number(plan.unplannedActualKg).toFixed(2)} kg
                  </span>
                )}
                {canRegenerate && (
                  <button
                    type="button"
                    onClick={() => void onRegenerate(plan)}
                    className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                  >
                    {t('feedingV2.mealBoard.regenerate')}
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-4 border-b border-gray-100 px-4 py-2 text-xs text-gray-600">
              <span>
                {t('feedingV2.mealBoard.biomass')}: {snapshot.biomassKg.toFixed(1)} kg
              </span>
              <span>
                {t('feedingV2.mealBoard.fishCount')}: {snapshot.fishCount}
              </span>
              <span>
                {t('feedingV2.mealBoard.avgWeight')}: {snapshot.avgWeightG.toFixed(1)} g
              </span>
              <span>
                {resolution.feed.code} — {resolution.feed.name}
              </span>
              <span>
                {t('feedingV2.mealBoard.rate')}: {resolution.effectiveRatePercent.toFixed(2)}%
              </span>
              <span>
                {t('feedingV2.mealBoard.expectedFcr')}: {resolution.expectedFcr.toFixed(2)}{' '}
                <span className="rounded bg-gray-100 px-1">
                  {t(FCR_SOURCE_KEY[resolution.fcrResolvedSource])}
                </span>
              </span>
              {resolution.temperatureSource === 'none' ? (
                <span className="text-amber-700">
                  {t('feedingV2.mealBoard.defaultTempWarning')}
                </span>
              ) : (
                <span>
                  {resolution.waterTempC?.toFixed(1)}°C ({resolution.temperatureSource})
                </span>
              )}
              {lastRecalc && (
                <span>
                  {t('feedingV2.mealBoard.lastRecalc')}: {lastRecalc.reason} {timeOf(lastRecalc.at)}
                </span>
              )}
            </div>

            <table className="min-w-full divide-y divide-gray-100 text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="px-4 py-2">{t('feedingV2.mealBoard.meal')}</th>
                  <th className="px-4 py-2">{t('feedingV2.mealBoard.time')}</th>
                  <th className="px-4 py-2">{t('feedingV2.mealBoard.planned')}</th>
                  <th className="px-4 py-2">{t('feedingV2.mealBoard.actual')}</th>
                  <th className="px-4 py-2">{t('feedingV2.statusLabel')}</th>
                  <th className="px-4 py-2">{t('feedingV2.mealBoard.pours')}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {(plan.meals ?? []).map((meal) => {
                  const open = meal.status === 'SCHEDULED' || meal.status === 'PARTIALLY_FED';
                  return (
                    <tr key={meal.id}>
                      <td className="px-4 py-2">#{meal.mealIndex + 1}</td>
                      <td className="px-4 py-2">{timeOf(meal.scheduledAt)}</td>
                      <td className="px-4 py-2">{Number(meal.plannedKg).toFixed(2)} kg</td>
                      <td className="px-4 py-2">
                        {Number(meal.actualKg || 0).toFixed(2)} kg
                        {meal.variancePercent != null && (
                          <span
                            className={`ml-2 text-xs ${
                              meal.variancePercent < 0 ? 'text-red-600' : 'text-green-600'
                            }`}
                          >
                            {meal.variancePercent > 0 ? '+' : ''}
                            {Number(meal.variancePercent).toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${MEAL_STATUS_BADGE[meal.status]}`}
                        >
                          {t(MEAL_STATUS_KEY[meal.status])}
                        </span>
                        {meal.readiness && (
                          <span
                            className={`ml-2 rounded-full px-2 py-0.5 text-xs ${READINESS_BADGE[meal.readiness.status]}`}
                            title={t('feedingV2.mealBoard.readiness.title', {
                              floor: meal.readiness.minDissolvedOxygen,
                              observed: meal.readiness.observedDissolvedOxygen ?? '—',
                            })}
                          >
                            {t(READINESS_LABEL[meal.readiness.status])}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-600">
                        {(meal.pours ?? []).map((pour) => (
                          <span
                            key={pour.pourIndex}
                            className="mr-2 inline-flex items-center gap-1"
                          >
                            {pour.kg} kg
                            {canCorrect && meal.status !== 'CANCELLED' && (
                              <button
                                type="button"
                                onClick={() => {
                                  setCorrectModal({ meal, pourIndex: pour.pourIndex });
                                  setCorrectedKg(String(pour.kg));
                                }}
                                className="text-blue-600 underline"
                              >
                                {t('feedingV2.mealBoard.correctPour')}
                              </button>
                            )}
                          </span>
                        ))}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {open && canRecord && (
                          <button
                            type="button"
                            onClick={() => setPourModal({ meal, unitCode: plan.unitCode })}
                            className="mr-2 rounded-md bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
                          >
                            {t('feedingV2.mealBoard.addPour')}
                          </button>
                        )}
                        {meal.status === 'PARTIALLY_FED' && canFinalize && (
                          <button
                            type="button"
                            disabled={finalizeMeal.isPending}
                            onClick={() => void submitFinalize(meal)}
                            className="mr-2 rounded-md border border-green-600 px-2 py-1 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50"
                          >
                            {t('feedingV2.mealBoard.finalizeExisting')}
                          </button>
                        )}
                        {meal.status === 'SCHEDULED' && canSkip && (
                          <button
                            type="button"
                            onClick={() => setSkipModalMeal(meal)}
                            className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                          >
                            {t('feedingV2.mealBoard.skip')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      {pourModal && (
        <Modal
          isOpen
          onClose={() => setPourModal(null)}
          title={`${pourModal.unitCode} — ${t('feedingV2.mealBoard.addPour')}`}
        >
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="text-gray-600">{t('feedingV2.mealBoard.pourKg')}</span>
              <input
                type="number"
                min={FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg}
                max={FEEDING_MEAL_QUANTITY_POLICY_V1.maximumKg}
                step={FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg}
                value={pourKg}
                onChange={(event) => setPourKg(event.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={finalize}
                onChange={(event) => setFinalize(event.target.checked)}
              />
              {t('feedingV2.mealBoard.finalize')}
            </label>
            <p className="text-xs text-gray-500">{t('feedingV2.mealBoard.finalizeHint')}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPourModal(null)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              >
                {t('feedingV2.mealBoard.cancel')}
              </button>
              <button
                type="button"
                disabled={recordMeal.isPending}
                onClick={() => void submitPour()}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {t('feedingV2.mealBoard.save')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {skipModalMeal && (
        <Modal isOpen onClose={() => setSkipModalMeal(null)} title={t('feedingV2.mealBoard.skip')}>
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="text-gray-600">{t('feedingV2.mealBoard.skipReason')}</span>
              <input
                type="text"
                maxLength={500}
                value={skipReason}
                onChange={(event) => setSkipReason(event.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 text-sm"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSkipModalMeal(null)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              >
                {t('feedingV2.mealBoard.cancel')}
              </button>
              <button
                type="button"
                disabled={skipMeal.isPending || !skipReason.trim()}
                onClick={() => void submitSkip()}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {t('feedingV2.mealBoard.save')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {correctModal && (
        <Modal
          isOpen
          onClose={() => setCorrectModal(null)}
          title={t('feedingV2.mealBoard.correctPour')}
        >
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="text-gray-600">{t('feedingV2.mealBoard.correctedKg')}</span>
              <input
                type="number"
                min={FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg}
                max={FEEDING_MEAL_QUANTITY_POLICY_V1.maximumKg}
                step={FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg}
                value={correctedKg}
                onChange={(event) => setCorrectedKg(event.target.value)}
                className="mt-1 block w-full rounded-md border-gray-300 text-sm"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCorrectModal(null)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              >
                {t('feedingV2.mealBoard.cancel')}
              </button>
              <button
                type="button"
                disabled={correctPour.isPending}
                onClick={() => void submitCorrection()}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {t('feedingV2.mealBoard.save')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default MealBoardTab;
