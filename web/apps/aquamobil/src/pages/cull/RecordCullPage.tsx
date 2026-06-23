import { ChevronRight, Scissors } from 'lucide-react';
import { type JSX, useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  NotesInput,
  QuantityStepper,
  ReasonGrid,
  RecordEntityPage,
  type RecordEntityTheme,
  SummaryDivider,
  SummaryNotesBlock,
  SummaryRow,
  type BaseFormErrors,
} from '../_shared/RecordEntityPage';

import { useTanks } from '@/hooks/useTanks';
import type { CullReason, CullInput } from '@/types';

const CULL_REASONS: ReadonlyArray<{ value: CullReason; label: string; emoji: string }> = [
  { value: 'SMALL_SIZE', label: 'Small Size', emoji: '📏' },
  { value: 'DEFORMED', label: 'Deformed', emoji: '🔄' },
  { value: 'SICK', label: 'Sick', emoji: '🤒' },
  { value: 'POOR_GROWTH', label: 'Poor Growth', emoji: '📉' },
  { value: 'GRADING', label: 'Grading', emoji: '⚖️' },
  { value: 'QUALITY', label: 'Quality', emoji: '🏅' },
  { value: 'OTHER', label: 'Other', emoji: '📝' },
];

const CULL_THEME: RecordEntityTheme = {
  headerGradient: 'bg-gradient-to-r from-orange-600 to-cull',
  accentText: 'text-cull',
  summaryHeaderBg: 'bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-800/50',
  summaryHeaderText: 'text-orange-700 dark:text-orange-300',
  iconBubbleBg: 'bg-orange-50 dark:bg-orange-900/20',
  surfaceSoftBg: 'bg-orange-50 dark:bg-orange-900/20',
  surfaceBorder: 'border-orange-100 dark:border-orange-800',
  ctaGradient: 'bg-gradient-to-r from-orange-600 to-cull',
  ctaShadow: 'shadow-orange-500/25',
  selectionBorder: 'border-cull',
  selectionGlow: 'shadow-glow-orange',
};

export function RecordCullPage(): JSX.Element {
  const { tankId } = useParams<{ tankId?: string }>();
  const { data: tanks } = useTanks();

  const [selectedTankId, setSelectedTankId] = useState(tankId || '');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState<CullReason>('GRADING');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<BaseFormErrors>({});

  const selectedTank = tanks?.find((t) => t.id === selectedTankId);
  const metrics = selectedTank?.batchMetrics;
  const maxQuantity = metrics?.pieces || 1000;
  const selectedReason = CULL_REASONS.find((r) => r.value === reason);

  const validate = useCallback((): boolean => {
    const next: BaseFormErrors = {};
    if (!selectedTankId) next.tank = 'Please select a tank';
    if (!metrics) next.tank = 'Selected tank has no active batch';
    if (quantity < 1) next.quantity = 'Quantity must be at least 1';
    if (quantity > maxQuantity) next.quantity = `Cannot exceed ${maxQuantity}`;
    if (!Number.isInteger(quantity)) next.quantity = 'Must be a whole number';
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [selectedTankId, metrics, quantity, maxQuantity]);

  const buildPayload = (): CullInput => {
    // Contract: the shell only invokes buildPayload after validate() passes AND
    // it has re-checked `metrics?.batchId` (RecordEntityPage.handleSubmit guard),
    // so batchId is present here. The guard narrows BatchMetrics['batchId']
    // (string | null) to string without a non-null assertion; it is unreachable
    // under the shell contract but documents the precondition.
    const batchId = metrics?.batchId;
    if (!batchId) {
      throw new Error('Cannot record cull: selected tank has no active batch');
    }
    return {
      batchId,
      tankId: selectedTankId,
      quantity,
      reason,
      notes: notes.trim() || undefined,
      culledAt: new Date().toISOString(),
    };
  };

  return (
    <RecordEntityPage<CullInput>
      theme={CULL_THEME}
      entryTitle="Record Cull"
      confirmTitle="Confirm Cull"
      icon={Scissors}
      summaryHeading="Cull Summary"
      operationName="recordCull"
      tankEmptyActionWord="culling"
      selectedTankId={selectedTankId}
      onTankChange={setSelectedTankId}
      errors={errors}
      setErrors={setErrors}
      validate={validate}
      buildPayload={buildPayload}
      canReview={!!selectedTankId && !!metrics?.batchId && quantity >= 1}
      reviewLabel={
        <>
          Review {quantity} Culled Fish
          <ChevronRight size={18} className="ml-1" />
        </>
      }
      submitLabel="Confirm & Record"
      confirmSummary={
        <>
          <SummaryRow label="Tank" value={selectedTank?.name} />
          <SummaryRow label="Batch" value={metrics?.batchNumber ?? '--'} />
          <SummaryDivider />
          <SummaryRow
            label="Culled Fish"
            value={quantity}
            valueClass="text-2xl font-bold text-cull"
          />
          <SummaryRow
            label="Reason"
            value={`${selectedReason?.emoji ?? ''} ${selectedReason?.label ?? ''}`}
          />
          {notes.trim() && (
            <>
              <SummaryDivider />
              <SummaryNotesBlock notes={notes} />
            </>
          )}
        </>
      }
    >
      <QuantityStepper
        label="Culled Fish Count"
        value={quantity}
        onChange={(next) => {
          setQuantity(next);
          setErrors((prev) => ({ ...prev, quantity: undefined }));
        }}
        max={maxQuantity}
        error={errors.quantity}
        theme={CULL_THEME}
      />
      <ReasonGrid
        label="Cull Reason"
        value={reason}
        onChange={setReason}
        options={CULL_REASONS}
        theme={CULL_THEME}
      />
      <NotesInput value={notes} onChange={setNotes} />
    </RecordEntityPage>
  );
}
