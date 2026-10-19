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
import { Button, Drawer, useI18n } from '@aquaculture/shared-ui';
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
  <div className="flex min-w-0 flex-col gap-1 bg-white px-4 py-3.5 dark:bg-gray-900">
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

  const secondaryOp = 'min-h-12 text-[15.5px] font-medium';

  if (!isOpen) return null;

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      side="right"
      size="lg"
      title={tank.code}
      description={
        <span>
          {locationLine || tank.name}
          {batchLineParts.length > 0 && (
            <span className="mt-1 block">
              <span className="font-semibold">{tank.batchNumber}</span>
              {batchLineParts
                .slice(1)
                .map((part) => ` · ${part}`)
                .join('')}
            </span>
          )}
        </span>
      }
    >
      <div className="flex flex-col gap-6">
        {hasAnyStock ? (
          <>
            {/* Metrics grid */}
            {hasProductionBatch && (
              <div className="grid grid-cols-1 gap-px border border-gray-200 bg-gray-200 sm:grid-cols-3 dark:border-gray-700 dark:bg-gray-700">
                <MetricCell label={t('tanksV2.popup.fish')} value={fmt(tank.pieces, 0)} />
                <MetricCell
                  label={t('tanksV2.popup.avgWeight')}
                  value={`${fmt(tank.avgWeight, tank.avgWeight !== undefined && tank.avgWeight < 1 ? 2 : 0)} g`}
                />
                <MetricCell label={t('tanksV2.popup.biomass')} value={`${fmt(tank.biomass)} kg`} />
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
                    className={`h-full ${over ? 'bg-warning-500' : 'bg-accent-600'}`}
                    style={{ width: `${capPercent ?? 0}%` }}
                  />
                </div>
                {over && (
                  <span className="text-[15px] font-bold text-warning-600">
                    {t('tanksV2.popup.overCap')}
                  </span>
                )}
              </div>
            )}

            {/* Live environment */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                    doCritical ? 'text-error-600' : 'text-gray-900'
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
                <div className="flex flex-col divide-y divide-gray-200 rounded border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
                  {(tank.cleanerFishDetails ?? []).map((cf) => (
                    <div
                      key={cf.batchId}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm"
                    >
                      <span className="font-mono text-xs">{cf.batchNumber}</span>
                      <span className="text-gray-600 dark:text-gray-300">{cf.speciesName}</span>
                      <span>{fmt(cf.quantity, 0)}</span>
                      <span>{fmt(cf.avgWeightG, 1)} g</span>
                      <span>{fmt(cf.biomassKg, 1)} kg</span>
                      {variant === 'cleanerFish' && onRemoveCleanerBatch && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onRemoveCleanerBatch(cf.batchId)}
                          className="text-xs font-medium text-error-600 hover:underline"
                        >
                          {t('tanksV2.popup.removeBatch')}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Operations */}
            <section className="flex flex-col gap-3">
              <h3 className="m-0 text-xl font-semibold text-gray-900">
                {t('tanksV2.popup.operations')}
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button
                  variant="primary"
                  onClick={onMortality}
                  disabled={!hasAnyStock}
                  className="min-h-12"
                >
                  {t('tanksV2.popup.recordMortality')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={onSampling}
                  disabled={!hasProductionBatch}
                  className={secondaryOp}
                >
                  {t('tanksV2.popup.sampling')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={onTransfer}
                  disabled={!hasAnyStock}
                  className={secondaryOp}
                >
                  {t('tanksV2.popup.transfer')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={onGrading}
                  disabled={!hasProductionBatch}
                  className={secondaryOp}
                >
                  {t('tanksV2.popup.grading')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={onCull}
                  disabled={!hasProductionBatch}
                  className={secondaryOp}
                >
                  {t('tanksV2.popup.cull')}
                </Button>
                <Button variant="secondary" onClick={onWaterTemp} className={secondaryOp}>
                  {t('tanksV2.popup.waterTemp')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={onOpenFeedingPlan}
                  className="col-span-2 min-h-12"
                >
                  {t('tanksV2.popup.openFeedingPlan')}
                </Button>
              </div>
            </section>
          </>
        ) : (
          <>
            <p className="m-0 text-gray-600">{t('tanksV2.unit.emptyReady')}</p>
            <Button variant="primary" onClick={onStockUnit} className="self-start px-5 py-3">
              {t('tanksV2.popup.stockUnit')}
            </Button>
          </>
        )}
      </div>
    </Drawer>
  );
};
