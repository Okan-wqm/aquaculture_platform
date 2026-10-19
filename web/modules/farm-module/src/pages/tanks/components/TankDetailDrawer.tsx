/**
 * Tank Detail Drawer — the unit popup for the /sites/tanks table.
 *
 * Design reference: design_handoff tenant console "tkDrawer" — a right-side
 * drawer (min(560px, 100vw)) carrying the unit's full operational picture:
 * location header (department · site) with the big unit code and the batch
 * line, the 3×2 metrics grid, the density·capacity bar, live Sıcaklık/DO,
 * the feeding block, and the operation buttons that replaced the page-level
 * quick-actions toolbar.
 *
 * Repo wiring vs. the mock: the mock toasts "form opens" for sampling /
 * transfer / grading and inlines a mortality quick-form; here each button
 * opens the REAL production modal (mortality/transfer/grading/sampling with
 * the fish-type and cleaner-batch disambiguation chain), and Sıcaklık/DO
 * come from the tank's linked sensor through `latestReadingsBatch` — an
 * unlinked sensor or unpublished reading renders an honest dash.
 */
import React, { useMemo } from 'react';
import { useI18n } from '@aquaculture/shared-ui';
import { useLatestSensorReading } from '../../../hooks/useTanks';
import { useFeedingDayPlans } from '../../../hooks/useProtocolFeeding';
import { TankWithBatch } from '../types';

export type TankDetailVariant = 'production' | 'cleanerFish';

interface TankDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  tank: TankWithBatch;
  /** Resolved species display name (localName → commonName → code). */
  speciesName?: string;
  /** Which grid tab opened the drawer — drives the detail block. */
  variant: TankDetailVariant;
  onMortality: () => void;
  onSampling: () => void;
  onTransfer: () => void;
  onGrading: () => void;
  onCull: () => void;
  onWaterTemp: () => void;
  onOpenFeedingPlan: () => void;
  /** Empty unit: "stock this unit" opens the batch creation flow. */
  onStockUnit: () => void;
  /** Cleaner-fish tab: per-batch removal (RemoveModal flow). */
  onRemoveCleanerBatch?: (batchId: string) => void;
}

interface MetricCellProps {
  label: string;
  value: React.ReactNode;
}

const MetricCell: React.FC<MetricCellProps> = ({ label, value }) => (
  <div className="flex min-w-0 flex-col gap-1 bg-white px-4 py-3.5">
    <span className="text-[13px] text-gray-500">{label}</span>
    <span className="whitespace-nowrap text-2xl font-semibold leading-tight text-gray-900">
      {value}
    </span>
  </div>
);

interface FeedingRowProps {
  label: string;
  value: React.ReactNode;
}

const FeedingRow: React.FC<FeedingRowProps> = ({ label, value }) => (
  <div className="grid grid-cols-[150px_1fr] gap-4 border-b border-gray-200 py-3">
    <dt className="text-gray-600">{label}</dt>
    <dd className="m-0 font-medium text-gray-900">{value}</dd>
  </div>
);

export const TankDetailDrawer: React.FC<TankDetailDrawerProps> = ({
  isOpen,
  onClose,
  tank,
  speciesName,
  variant,
  onMortality,
  onSampling,
  onTransfer,
  onGrading,
  onCull,
  onWaterTemp,
  onOpenFeedingPlan,
  onStockUnit,
  onRemoveCleanerBatch,
}) => {
  const { t, locale } = useI18n();
  const { data: latestReading } = useLatestSensorReading(tank.temperatureSensorId);

  // Günlük öğün sayısı — the unit's active feeding-v2 day plan for today
  // (design "5,40 kg · 8 öğün"). No plan → the ration shows kg only.
  const today = new Date().toISOString().slice(0, 10);
  const { data: dayPlans } = useFeedingDayPlans(today);
  const mealsPlanned = useMemo(
    () => dayPlans?.find((plan) => plan.unitId === tank.id)?.mealsPlanned,
    [dayPlans, tank.id],
  );

  const numberLocale = locale === 'tr' ? 'tr-TR' : 'en-US';
  const fmt = (value: number | undefined, decimals = 1): string => {
    if (value === undefined || value === null) return '—';
    return value.toLocaleString(numberLocale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });
  };

  const hasProductionBatch = !!tank.batchNumber;
  const hasAnyStock = hasProductionBatch || tank.hasCleanerFish;

  // Header: "Larva üretimi · Bodrum Kuluçkahanesi" — department · site.
  const locationLine = [tank.departmentName, tank.siteName].filter(Boolean).join(' · ');

  // Batch line: "SPAU-2026-03 · Çipura · Stoklama · 19 gün".
  const batchLineParts: string[] = [];
  if (tank.batchNumber) batchLineParts.push(tank.batchNumber);
  if (speciesName) batchLineParts.push(speciesName);
  if (tank.daysSinceStocking !== undefined && tank.daysSinceStocking !== null) {
    batchLineParts.push(t('tanksV2.popup.stocked', { days: fmt(tank.daysSinceStocking, 0) }));
  }

  const capPercent =
    tank.capacityUsedPercent !== undefined && tank.capacityUsedPercent !== null
      ? Math.min(tank.capacityUsedPercent, 100)
      : undefined;
  const over = !!tank.isOverCapacity;

  const feedRate =
    tank.feedingRatePercent !== undefined && tank.feedingRatePercent !== null
      ? t('tanksV2.popup.feedRateUnit', { value: `%${fmt(tank.feedingRatePercent, 1)}` })
      : '—';

  const temperature = latestReading?.readings?.temperature;
  const dissolvedOxygen = latestReading?.readings?.dissolvedOxygen;
  const doCritical = dissolvedOxygen !== undefined && dissolvedOxygen < 6.5;

  const secondaryOp =
    'inline-flex min-h-12 items-center justify-center border border-gray-300 bg-white px-3 text-[15.5px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40';

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={locationLine || tank.name}
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-0 right-0 top-0 flex w-[min(560px,100%)] flex-col border-l border-gray-200 bg-white shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 p-6">
          <div className="min-w-0">
            <span className="text-[15px] text-gray-500">{locationLine || tank.name}</span>
            <h2 className="mt-0.5 text-4xl font-bold leading-none tracking-tight text-gray-900">
              {tank.code}
            </h2>
            {batchLineParts.length > 0 && (
              <div className="mt-2 text-base text-gray-700">
                <span className="font-semibold text-gray-900">{tank.batchNumber}</span>
                {batchLineParts
                  .slice(1)
                  .map((part) => ` · ${part}`)
                  .join('')}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('tanksV2.popup.close')}
            className="flex h-12 w-12 shrink-0 items-center justify-center border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M18 6L6 18M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
          {hasAnyStock ? (
            <>
              {/* Metrics grid */}
              {hasProductionBatch && (
                <div className="grid grid-cols-3 gap-px border border-gray-200 bg-gray-200">
                  <MetricCell label={t('tanksV2.popup.fish')} value={fmt(tank.pieces, 0)} />
                  <MetricCell
                    label={t('tanksV2.popup.avgWeight')}
                    value={`${fmt(tank.avgWeight, tank.avgWeight !== undefined && tank.avgWeight < 1 ? 2 : 0)} g`}
                  />
                  <MetricCell
                    label={t('tanksV2.popup.biomass')}
                    value={`${fmt(tank.biomass)} kg`}
                  />
                  <MetricCell label={t('tanksV2.popup.fcr')} value={fmt(tank.fcr, 2)} />
                  <MetricCell
                    label={t('tanksV2.popup.survival')}
                    value={
                      tank.survivalRate !== undefined && tank.survivalRate !== null
                        ? `%${fmt(tank.survivalRate, 1)}`
                        : '—'
                    }
                  />
                  <MetricCell
                    label={t('tanksV2.popup.volume')}
                    value={
                      tank.volume !== undefined && tank.volume !== null
                        ? `${fmt(tank.volume)} m³`
                        : '—'
                    }
                  />
                </div>
              )}

              {/* Density · capacity */}
              {tank.density !== undefined && tank.density !== null && (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-[15.5px]">
                    <span className="font-medium">{t('tanksV2.popup.densityCapacity')}</span>
                    <span>
                      {fmt(tank.density)} / {fmt(tank.maxDensity, 0)} kg/m³ ·{' '}
                      <span className="font-bold">
                        {tank.capacityUsedPercent !== undefined && tank.capacityUsedPercent !== null
                          ? `%${fmt(tank.capacityUsedPercent, 0)}`
                          : '—'}
                      </span>
                    </span>
                  </div>
                  <div className="h-3.5 border border-gray-300">
                    <div
                      className={`h-full ${over ? 'bg-amber-500' : 'bg-blue-600'}`}
                      style={{ width: `${capPercent ?? 0}%` }}
                    />
                  </div>
                  {over && (
                    <span className="text-[15px] font-bold text-amber-600">
                      {t('tanksV2.popup.overCap')}
                    </span>
                  )}
                </div>
              )}

              {/* Live environment */}
              <div className="grid grid-cols-2 gap-4">
                <div className="flex justify-between gap-3 border border-gray-200 px-3.5 py-3 text-[15.5px]">
                  <span className="text-gray-600">{t('tanksV2.popup.temperature')}</span>
                  <span className="whitespace-nowrap font-bold text-gray-900">
                    {temperature !== undefined ? `${fmt(temperature)} °C` : '—'}
                  </span>
                </div>
                <div className="flex justify-between gap-3 border border-gray-200 px-3.5 py-3 text-[15.5px]">
                  <span className="text-gray-600">{t('tanksV2.popup.do')}</span>
                  <span
                    className={`whitespace-nowrap font-bold ${
                      doCritical ? 'text-red-600' : 'text-gray-900'
                    }`}
                  >
                    {dissolvedOxygen !== undefined ? `${fmt(dissolvedOxygen)} mg/L` : '—'}
                  </span>
                </div>
              </div>

              {/* Feeding block */}
              {variant === 'production' && hasProductionBatch && (
                <section className="flex flex-col gap-2">
                  <h3 className="m-0 text-xl font-semibold text-gray-900">
                    {t('tanksV2.popup.feeding')}
                  </h3>
                  <dl className="m-0 border-t border-gray-200">
                    <FeedingRow
                      label={t('tanksV2.popup.feed')}
                      value={tank.feedName || tank.feedCode || '—'}
                    />
                    <FeedingRow label={t('tanksV2.popup.feedRate')} value={feedRate} />
                    <FeedingRow
                      label={t('tanksV2.popup.dailyRation')}
                      value={
                        tank.dailyFeedKg !== undefined && tank.dailyFeedKg !== null
                          ? `${fmt(tank.dailyFeedKg, 2)} kg${
                              mealsPlanned ? ` · ${mealsPlanned} ${t('tanksV2.popup.meals')}` : ''
                            }`
                          : '—'
                      }
                    />
                  </dl>
                </section>
              )}

              {/* Cleaner-fish block */}
              {tank.hasCleanerFish && (
                <section className="flex flex-col gap-2">
                  <h3 className="m-0 text-xl font-semibold text-gray-900">
                    {t('tanksV2.popup.cleanerFish')}
                  </h3>
                  <div className="overflow-hidden rounded border border-gray-200">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                            {t('tanksV2.col.batch')}
                          </th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">
                            {t('tanksV2.col.fish')}
                          </th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">
                            {t('tanksV2.col.avgWeight')}
                          </th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">
                            {t('tanksV2.col.biomass')}
                          </th>
                          {variant === 'cleanerFish' && onRemoveCleanerBatch && (
                            <th className="px-3 py-2" />
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 bg-white">
                        {(tank.cleanerFishDetails ?? []).map((cf) => (
                          <tr key={cf.batchId}>
                            <td className="px-3 py-2 font-mono text-xs">{cf.batchNumber}</td>
                            <td className="px-3 py-2 text-right">{fmt(cf.quantity, 0)}</td>
                            <td className="px-3 py-2 text-right">{fmt(cf.avgWeightG, 1)} g</td>
                            <td className="px-3 py-2 text-right">{fmt(cf.biomassKg, 1)} kg</td>
                            {variant === 'cleanerFish' && onRemoveCleanerBatch && (
                              <td className="px-3 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => onRemoveCleanerBatch(cf.batchId)}
                                  className="text-xs font-medium text-red-600 hover:underline"
                                >
                                  {t('tanksV2.popup.removeBatch')}
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {/* Operations */}
              <section className="flex flex-col gap-3">
                <h3 className="m-0 text-xl font-semibold text-gray-900">
                  {t('tanksV2.popup.operations')}
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={onMortality}
                    disabled={!hasAnyStock}
                    className="inline-flex min-h-12 items-center justify-center bg-blue-600 px-3 text-[15.5px] font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('tanksV2.popup.recordMortality')}
                  </button>
                  <button
                    type="button"
                    onClick={onSampling}
                    disabled={!hasProductionBatch}
                    className={secondaryOp}
                  >
                    {t('tanksV2.popup.sampling')}
                  </button>
                  <button
                    type="button"
                    onClick={onTransfer}
                    disabled={!hasAnyStock}
                    className={secondaryOp}
                  >
                    {t('tanksV2.popup.transfer')}
                  </button>
                  <button
                    type="button"
                    onClick={onGrading}
                    disabled={!hasProductionBatch}
                    className={secondaryOp}
                  >
                    {t('tanksV2.popup.grading')}
                  </button>
                  <button
                    type="button"
                    onClick={onCull}
                    disabled={!hasProductionBatch}
                    className={secondaryOp}
                  >
                    {t('tanksV2.popup.cull')}
                  </button>
                  <button type="button" onClick={onWaterTemp} className={secondaryOp}>
                    {t('tanksV2.popup.waterTemp')}
                  </button>
                  <button
                    type="button"
                    onClick={onOpenFeedingPlan}
                    className="inline-flex min-h-12 col-span-2 items-center justify-center border border-gray-300 bg-white px-3 text-[15.5px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    {t('tanksV2.popup.openFeedingPlan')}
                  </button>
                </div>
              </section>
            </>
          ) : (
            <>
              <p className="m-0 text-gray-600">{t('tanksV2.unit.emptyReady')}</p>
              <button
                type="button"
                onClick={onStockUnit}
                className="self-start bg-blue-600 px-5 py-3 text-base font-medium text-white hover:bg-blue-700"
              >
                {t('tanksV2.popup.stockUnit')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
