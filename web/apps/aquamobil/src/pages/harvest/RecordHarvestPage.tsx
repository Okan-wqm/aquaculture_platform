import { clsx } from 'clsx';
import { ChevronRight, Package } from 'lucide-react';
import { type JSX, type ChangeEvent, useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  FIELD_CONTROL_CLASS,
  FIELD_LABEL_CLASS,
  RecordEntityPage,
  type RecordEntityTheme,
  SummaryDivider,
  SummaryRow,
  type BaseFormErrors,
} from '../_shared/RecordEntityPage';

import { Card } from '@/components/ui';
import { useTanks } from '@/hooks/useTanks';
import type { HarvestInput, QualityClass } from '@/types';

interface HarvestFormErrors extends BaseFormErrors {
  avgWeight?: string;
}

/**
 * Norwegian official kvalitetsklasser (RPT-007) — the stored SSoT, best → reject.
 *
 * v4 colour: the dot is a LADDER, so each step takes the token whose meaning
 * matches its place on it — Superior confirms (`ok`), Ordinær is the standard
 * grade (`acc`), Produksjonsfisk is a downgrade the operator should notice
 * (`warn`) and Utkast is a loss (`crit`). The pre-v4 dots were gold / sea /
 * grey / red, which read as decoration; gold in particular would now translate
 * to `warn` and make the BEST grade look like a warning, so the mapping is by
 * meaning rather than by hue.
 */
const QUALITY_CLASSES: ReadonlyArray<{ value: QualityClass; label: string; color: string }> = [
  { value: 'SUPERIOR', label: 'Superior', color: 'bg-ok' },
  { value: 'ORDINAER', label: 'Ordinær', color: 'bg-acc' },
  { value: 'PRODUKSJONSFISK', label: 'Produksjonsfisk', color: 'bg-warn' },
  { value: 'UTKAST', label: 'Utkast', color: 'bg-crit' },
];

/**
 * v4: the violet→purple gradient is gone. It was page identity, not meaning,
 * and a gradient header costs contrast on a deck in daylight. What identity the
 * screen keeps is the harvest hue from the per-log-type token set (the icon
 * bubble and the summary heading), while the accent carries the action — teal
 * is the app's one action colour, so the CTA is teal here as everywhere.
 */
const HARVEST_THEME: RecordEntityTheme = {
  headerGradient: 'bg-surface-1 text-ink-1 border-b border-line',
  accentText: 'text-type-harvest',
  summaryHeaderBg: 'bg-type-harvest-dim border-line',
  summaryHeaderText: 'text-type-harvest',
  iconBubbleBg: 'bg-type-harvest-dim',
  surfaceSoftBg: 'bg-type-harvest-dim',
  surfaceBorder: 'border-line',
  ctaGradient: 'bg-acc text-acc-on',
  ctaShadow: 'shadow-acc',
  selectionBorder: 'border-acc',
  selectionGlow: 'shadow-acc',
};

export function RecordHarvestPage(): JSX.Element {
  const { tankId } = useParams<{ tankId?: string }>();
  const { data: tanks } = useTanks();

  const [selectedTankId, setSelectedTankId] = useState(tankId || '');
  const [quantity, setQuantity] = useState('');
  const [avgWeight, setAvgWeight] = useState('');
  const [qualityClass, setQualityClass] = useState<QualityClass>('SUPERIOR');
  const [pricePerKg, setPricePerKg] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<HarvestFormErrors>({});

  const selectedTank = tanks?.find((t) => t.id === selectedTankId);
  const metrics = selectedTank?.batchMetrics;
  const maxQuantity = metrics?.pieces || 1000;

  const quantityNum = parseInt(quantity, 10) || 0;
  const avgWeightNum = parseFloat(avgWeight) || 0;
  const totalBiomass = (quantityNum * avgWeightNum) / 1000;
  const priceNum = parseFloat(pricePerKg) || 0;
  const estimatedValue = priceNum > 0 ? totalBiomass * priceNum : 0;

  useEffect(() => {
    if (metrics?.avgWeight != null && !avgWeight) {
      setAvgWeight(metrics.avgWeight.toFixed(0));
    }
  }, [metrics, avgWeight]);

  const validate = useCallback((): boolean => {
    const next: HarvestFormErrors = {};
    if (!selectedTankId) next.tank = 'Please select a tank';
    if (!metrics) next.tank = 'Selected tank has no active batch';
    if (quantityNum < 1) next.quantity = 'Quantity must be at least 1';
    if (quantityNum > maxQuantity) next.quantity = `Cannot exceed ${maxQuantity}`;
    if (!Number.isInteger(quantityNum)) next.quantity = 'Must be a whole number';
    if (avgWeightNum <= 0) next.avgWeight = 'Average weight must be greater than 0';
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [selectedTankId, metrics, quantityNum, avgWeightNum, maxQuantity]);

  const buildPayload = (): HarvestInput => {
    // Contract: the shell only invokes buildPayload after validate() passes AND
    // it has re-checked `metrics?.batchId` (RecordEntityPage.handleSubmit guard),
    // so batchId is present here. The guard narrows BatchMetrics['batchId']
    // (string | null) to string without a non-null assertion.
    const batchId = metrics?.batchId;
    if (!batchId) {
      throw new Error('Cannot record harvest: selected tank has no active batch');
    }
    return {
      batchId,
      tankId: selectedTankId,
      quantityHarvested: quantityNum,
      averageWeight: avgWeightNum,
      totalBiomass,
      qualityClass,
      harvestDate: new Date().toISOString().split('T')[0],
      pricePerKg: priceNum > 0 ? priceNum : undefined,
      buyerName: buyerName.trim() || undefined,
      notes: notes.trim() || undefined,
    };
  };

  const classLabel = QUALITY_CLASSES.find((g) => g.value === qualityClass)?.label ?? qualityClass;

  return (
    <RecordEntityPage<HarvestInput, HarvestFormErrors>
      theme={HARVEST_THEME}
      entryTitle="Record Harvest"
      confirmTitle="Confirm Harvest"
      icon={Package}
      summaryHeading="Harvest Summary"
      operationName="createHarvestRecord"
      tankEmptyActionWord="harvest"
      selectedTankId={selectedTankId}
      onTankChange={setSelectedTankId}
      errors={errors}
      setErrors={setErrors}
      validate={validate}
      buildPayload={buildPayload}
      canReview={!!selectedTankId && !!metrics?.batchId && quantityNum >= 1 && avgWeightNum >= 1}
      reviewLabel={
        <>
          Review Harvest
          <ChevronRight size={18} className="ml-1" />
        </>
      }
      submitLabel="Confirm & Record Harvest"
      confirmSummary={
        <>
          <SummaryRow label="Tank" value={selectedTank?.name} />
          <SummaryRow label="Batch" value={metrics?.batchNumber ?? '--'} />
          <SummaryDivider />
          <SummaryRow
            label="Quantity"
            value={`${quantityNum.toLocaleString()} fish`}
            valueClass="text-head font-mono font-bold tabular-nums text-type-harvest"
          />
          <SummaryRow label="Avg Weight" value={`${avgWeightNum}g`} />
          <SummaryRow label="Total Biomass" value={`${totalBiomass.toFixed(1)} kg`} />
          {/* The slaughter class is a machine value on the record, so it is set
              in mono and uppercased — the app's rule for anything a system, not
              a person, is speaking. */}
          <SummaryRow
            label="Quality"
            value={classLabel}
            valueClass="font-mono font-semibold uppercase tracking-wide text-ink-1"
          />
          {estimatedValue > 0 && (
            <>
              <SummaryDivider />
              <SummaryRow
                label="Est. Value"
                value={`${estimatedValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`}
                valueClass="text-head font-mono font-bold tabular-nums text-ink-1"
              />
            </>
          )}
        </>
      }
    >
      {/* Harvest Details — the five required fields. Konsta's <List>/<ListInput>
          is replaced by native controls on the token surface; each caption
          WRAPS its control, so every field is named without a heading having to
          be kept in step with the input beneath it. */}
      <div className="px-4 mt-5">
        <h2 className="text-body font-semibold text-ink-3 px-1 mb-2">Harvest Details</h2>

        <label className="block">
          <span className={FIELD_LABEL_CLASS}>Quantity (fish)</span>
          <input
            type="number"
            placeholder="Enter fish count"
            value={quantity}
            aria-invalid={errors.quantity ? true : undefined}
            aria-describedby={errors.quantity ? 'harvest-quantity-error' : undefined}
            className={FIELD_CONTROL_CLASS}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const val = e.target.value.replace(/[^0-9]/g, '');
              const num = parseInt(val, 10) || 0;
              setQuantity(Math.min(num, maxQuantity).toString());
              setErrors((prev) => ({ ...prev, quantity: undefined }));
            }}
          />
        </label>
        {/* Konsta's <ListInput error> used to draw this; rendering it here is
            what stops the validation message disappearing with the library. */}
        {errors.quantity && (
          <p id="harvest-quantity-error" className="text-crit text-body mt-2">
            {errors.quantity}
          </p>
        )}

        <label className="block mt-4">
          <span className={FIELD_LABEL_CLASS}>Avg Weight (g)</span>
          <input
            type="number"
            placeholder="Average weight in grams"
            value={avgWeight}
            aria-invalid={errors.avgWeight ? true : undefined}
            aria-describedby={errors.avgWeight ? 'harvest-avg-weight-error' : undefined}
            className={FIELD_CONTROL_CLASS}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const val = e.target.value.replace(/[^0-9.]/g, '');
              setAvgWeight(val);
              setErrors((prev) => ({ ...prev, avgWeight: undefined }));
            }}
          />
        </label>
        {errors.avgWeight && (
          <p id="harvest-avg-weight-error" className="text-crit text-body mt-2">
            {errors.avgWeight}
          </p>
        )}
      </div>

      {/* Biomass readout — a computed figure, so mono and tabular: the digits
          line up while the operator watches them change. */}
      {quantityNum > 0 && avgWeightNum > 0 && (
        <div className="px-4 mt-3">
          <Card className="p-4 text-center border-type-harvest">
            <div className="text-display font-mono font-bold tabular-nums text-type-harvest">
              {totalBiomass.toFixed(1)} kg
            </div>
            <div className="text-body text-ink-3 font-medium">Total Biomass</div>
          </Card>
        </div>
      )}

      {/* Quality class — horizontal scroll + colour dots, distinct from the
          cull/mortality 4-col emoji grid. The class is the Norwegian official
          slaughter grade written onto the record, so the caption is set in mono
          and uppercased like every other machine value in the app. */}
      <div className="px-4 mt-5">
        <h3
          id="harvest-quality-class-label"
          className="text-meta font-bold text-ink-3 uppercase tracking-wider mb-3"
        >
          Quality Class
        </h3>
        <div
          role="group"
          aria-labelledby="harvest-quality-class-label"
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {QUALITY_CLASSES.map((g) => {
            const selected = qualityClass === g.value;
            return (
              <button
                key={g.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setQualityClass(g.value)}
                className={clsx(
                  'flex-shrink-0 px-4 py-3 min-h-touch rounded-2xl border-2 transition-all touch-feedback bg-surface-1',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                  selected ? 'border-acc bg-acc-dim shadow-acc' : 'border-line',
                )}
              >
                <span className={clsx('w-4 h-4 rounded-full mx-auto mb-1.5 block', g.color)} />
                <span
                  className={clsx(
                    'text-meta font-mono font-semibold uppercase tracking-wide',
                    selected ? 'text-acc' : 'text-ink-2',
                  )}
                >
                  {g.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Optional Fields */}
      <div className="px-4 mt-5">
        <h2 className="text-body font-semibold text-ink-3 px-1 mb-2">Additional Info (Optional)</h2>

        <label className="block">
          <span className={FIELD_LABEL_CLASS}>Price per kg</span>
          <input
            type="number"
            placeholder="0.00"
            value={pricePerKg}
            className={FIELD_CONTROL_CLASS}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const val = e.target.value.replace(/[^0-9.]/g, '');
              setPricePerKg(val);
            }}
          />
        </label>

        <label className="block mt-4">
          <span className={FIELD_LABEL_CLASS}>Buyer Name</span>
          <input
            type="text"
            placeholder="Enter buyer name"
            value={buyerName}
            className={FIELD_CONTROL_CLASS}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setBuyerName(e.target.value)}
          />
        </label>

        <label className="block mt-4">
          <span className={FIELD_LABEL_CLASS}>Notes</span>
          <textarea
            placeholder="Additional notes..."
            value={notes}
            className={clsx(FIELD_CONTROL_CLASS, 'h-24 resize-none')}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
          />
        </label>
      </div>

      {/* Estimated value readout — second display (the summary has its own). */}
      {estimatedValue > 0 && (
        <div className="px-4 mt-3">
          <Card className="p-4 text-center">
            <div className="text-head font-mono font-bold tabular-nums text-ink-1">
              {estimatedValue.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              USD
            </div>
            <div className="text-body text-ink-3 font-medium">Estimated Value</div>
          </Card>
        </div>
      )}
    </RecordEntityPage>
  );
}
