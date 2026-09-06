import { clsx } from 'clsx';
import { BlockTitle, List, ListInput } from 'konsta/react';
import { ChevronRight, Package } from 'lucide-react';
import { type JSX, type ChangeEvent, useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  RecordEntityPage,
  type RecordEntityTheme,
  SummaryDivider,
  SummaryRow,
  type BaseFormErrors,
} from '../_shared/RecordEntityPage';

import { useTanks } from '@/hooks/useTanks';
import type { QualityClass, QueuedPayload } from '@/types';

interface HarvestFormErrors extends BaseFormErrors {
  avgWeight?: string;
}

// Norwegian official kvalitetsklasser (RPT-007) — the stored SSoT, best → reject.
const QUALITY_CLASSES: ReadonlyArray<{ value: QualityClass; label: string; color: string }> = [
  { value: 'SUPERIOR', label: 'Superior', color: 'bg-amber-400' },
  { value: 'ORDINAER', label: 'Ordinær', color: 'bg-sea-500' },
  { value: 'PRODUKSJONSFISK', label: 'Produksjonsfisk', color: 'bg-gray-400' },
  { value: 'UTKAST', label: 'Utkast', color: 'bg-mortality' },
];

const HARVEST_THEME: RecordEntityTheme = {
  headerGradient: 'bg-gradient-to-r from-violet-700 to-harvest',
  accentText: 'text-harvest',
  summaryHeaderBg: 'bg-purple-50 dark:bg-purple-900/20 border-purple-100 dark:border-purple-800/50',
  summaryHeaderText: 'text-purple-700 dark:text-purple-300',
  iconBubbleBg: 'bg-purple-50 dark:bg-purple-900/20',
  surfaceSoftBg: 'bg-purple-50 dark:bg-purple-900/20',
  surfaceBorder: 'border-purple-100 dark:border-purple-800',
  ctaGradient: 'bg-gradient-to-r from-violet-700 to-harvest',
  ctaShadow: 'shadow-purple-500/25',
  selectionBorder: 'border-harvest',
  selectionGlow: 'shadow-glow-purple',
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

  const buildPayload = (): QueuedPayload<'createHarvestRecord'> => {
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
    <RecordEntityPage<'createHarvestRecord', HarvestFormErrors>
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
            valueClass="text-xl font-bold text-harvest"
          />
          <SummaryRow label="Avg Weight" value={`${avgWeightNum}g`} />
          <SummaryRow label="Total Biomass" value={`${totalBiomass.toFixed(1)} kg`} />
          <SummaryRow label="Quality" value={classLabel} />
          {estimatedValue > 0 && (
            <>
              <SummaryDivider />
              <SummaryRow
                label="Est. Value"
                value={`${estimatedValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`}
                valueClass="text-xl font-bold text-sea-600"
              />
            </>
          )}
        </>
      }
    >
      {/* Harvest Details */}
      <BlockTitle>Harvest Details</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          label="Quantity (fish)"
          type="number"
          placeholder="Enter fish count"
          value={quantity}
          onInput={(e: ChangeEvent<HTMLInputElement>) => {
            const val = e.target.value.replace(/[^0-9]/g, '');
            const num = parseInt(val, 10) || 0;
            setQuantity(Math.min(num, maxQuantity).toString());
            setErrors((prev) => ({ ...prev, quantity: undefined }));
          }}
          error={errors.quantity}
        />
        <ListInput
          label="Avg Weight (g)"
          type="number"
          placeholder="Average weight in grams"
          value={avgWeight}
          onInput={(e: ChangeEvent<HTMLInputElement>) => {
            const val = e.target.value.replace(/[^0-9.]/g, '');
            setAvgWeight(val);
            setErrors((prev) => ({ ...prev, avgWeight: undefined }));
          }}
          error={errors.avgWeight}
        />
      </List>

      {/* Biomass readout */}
      {quantityNum > 0 && avgWeightNum > 0 && (
        <div className="px-4 mt-3">
          <div className="bg-gradient-to-r from-harvest/10 to-violet-600/10 dark:from-harvest/20 dark:to-violet-600/20 rounded-2xl p-4 text-center border border-harvest/20">
            <div className="text-3xl font-bold text-harvest dark:text-violet-300">
              {totalBiomass.toFixed(1)} kg
            </div>
            <div className="text-sm text-harvest/70 dark:text-violet-400 font-medium">
              Total Biomass
            </div>
          </div>
        </div>
      )}

      {/* Quality class — uses horizontal scroll + color dots, distinct from cull/mortality 4-col emoji grid */}
      <div className="px-4 mt-5">
        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Quality Class</h3>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {QUALITY_CLASSES.map((g) => {
            const selected = qualityClass === g.value;
            return (
              <button
                key={g.value}
                onClick={() => setQualityClass(g.value)}
                className={clsx(
                  'flex-shrink-0 px-4 py-3 rounded-2xl border-2 transition-all touch-feedback bg-white dark:bg-gray-900',
                  selected
                    ? 'border-harvest bg-purple-50 dark:bg-purple-900/20 shadow-glow-purple'
                    : 'border-gray-100 dark:border-gray-800',
                )}
              >
                <div className={clsx('w-4 h-4 rounded-full mx-auto mb-1.5', g.color)} />
                <span className="text-xs font-semibold">{g.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Optional Fields */}
      <BlockTitle>Additional Info (Optional)</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          label="Price per kg"
          type="number"
          placeholder="0.00"
          value={pricePerKg}
          onInput={(e: ChangeEvent<HTMLInputElement>) => {
            const val = e.target.value.replace(/[^0-9.]/g, '');
            setPricePerKg(val);
          }}
        />
        <ListInput
          label="Buyer Name"
          type="text"
          placeholder="Enter buyer name"
          value={buyerName}
          onInput={(e: ChangeEvent<HTMLInputElement>) => setBuyerName(e.target.value)}
        />
        <ListInput
          label="Notes"
          type="textarea"
          placeholder="Additional notes..."
          value={notes}
          onInput={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
        />
      </List>

      {/* Estimated value readout — second display (summary has its own) */}
      {estimatedValue > 0 && (
        <div className="px-4 mt-1">
          <div className="bg-gradient-to-r from-sea-500/10 to-sea-600/10 dark:from-sea-500/20 dark:to-sea-600/20 rounded-2xl p-4 text-center border border-sea-500/20">
            <div className="text-2xl font-bold text-sea-700 dark:text-sea-300">
              {estimatedValue.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              USD
            </div>
            <div className="text-sm text-sea-600/70 dark:text-sea-400 font-medium">Estimated Value</div>
          </div>
        </div>
      )}
    </RecordEntityPage>
  );
}
