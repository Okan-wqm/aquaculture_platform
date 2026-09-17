/**
 * RecordMortalityPage — a thin consumer of the shared record scaffold.
 *
 * ORPHAN-MEDIUM-578: this path is superseded by the log sheet and scheduled for
 * retirement, but it is still routed and still writes real records, so it is
 * converted rather than left looking broken. Deleting a live record path means
 * exercising the sheet against a running backend first — a separate, deliberate
 * step, not a side effect of a restyle.
 */
import { ChevronRight, Skull } from 'lucide-react';
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
import type { MortalityReason, MortalityInput } from '@/types';

// WHY: All 13 MortalityReason enum values from the backend schema are present
// (BUG-14 regression guard — AMMONIA/PREDATION/CANNIBALISM/STARVATION/GENETIC
// were missing from an earlier revision).
const MORTALITY_REASONS: ReadonlyArray<{ value: MortalityReason; label: string; emoji: string }> = [
  { value: 'DISEASE', label: 'Disease', emoji: '🦠' },
  { value: 'WATER_QUALITY', label: 'Water Quality', emoji: '💧' },
  { value: 'STRESS', label: 'Stress', emoji: '😰' },
  { value: 'HANDLING', label: 'Handling', emoji: '🤲' },
  { value: 'TEMPERATURE', label: 'Temperature', emoji: '🌡️' },
  { value: 'OXYGEN', label: 'Low Oxygen', emoji: '💨' },
  { value: 'AMMONIA', label: 'Ammonia', emoji: '⚗️' },
  { value: 'PREDATION', label: 'Predation', emoji: '🦅' },
  { value: 'CANNIBALISM', label: 'Cannibalism', emoji: '🐟' },
  { value: 'STARVATION', label: 'Starvation', emoji: '🍽️' },
  { value: 'GENETIC', label: 'Genetic', emoji: '🧬' },
  { value: 'UNKNOWN', label: 'Unknown', emoji: '❓' },
  { value: 'OTHER', label: 'Other', emoji: '📝' },
];

/**
 * v4: the red→red gradient chrome is gone. Red on this screen was page
 * IDENTITY, not an alarm — a mortality entry is a routine daily log — and
 * spending the alarm colour on a whole header leaves the token layer nothing
 * louder for an actual alarm to say. The identity the screen keeps is the
 * mortality hue from the per-log-type token set (icon bubble, summary heading,
 * the headline count), which is the one place v4 lets colour be decorative,
 * because a worker reads an entry's type from its hue before reading a word.
 * The CTA and the selected reason take the accent: in v4 teal carries every
 * action and every active state, on every screen.
 */
const MORTALITY_THEME: RecordEntityTheme = {
  headerGradient: 'bg-surface-1 text-ink-1 border-b border-line',
  accentText: 'text-type-mortality',
  summaryHeaderBg: 'bg-type-mortality-dim border-line',
  summaryHeaderText: 'text-type-mortality',
  iconBubbleBg: 'bg-type-mortality-dim',
  surfaceSoftBg: 'bg-type-mortality-dim',
  surfaceBorder: 'border-line',
  ctaGradient: 'bg-acc text-acc-on',
  ctaShadow: 'shadow-acc',
  selectionBorder: 'border-acc',
  selectionGlow: 'shadow-acc',
};

export function RecordMortalityPage(): JSX.Element {
  const { tankId } = useParams<{ tankId?: string }>();
  const { data: tanks } = useTanks();

  const [selectedTankId, setSelectedTankId] = useState(tankId || '');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState<MortalityReason>('UNKNOWN');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<BaseFormErrors>({});

  const selectedTank = tanks?.find((t) => t.id === selectedTankId);
  const metrics = selectedTank?.batchMetrics;
  const maxQuantity = metrics?.pieces || 1000;
  const selectedReason = MORTALITY_REASONS.find((r) => r.value === reason);

  const validate = useCallback((): boolean => {
    const next: BaseFormErrors = {};
    if (!selectedTankId) next.tank = 'Please select a tank';
    if (!metrics) next.tank = 'Selected tank has no active batch';
    if (quantity < 1) next.quantity = 'Quantity must be at least 1';
    if (quantity > maxQuantity) next.quantity = `Quantity cannot exceed ${maxQuantity}`;
    if (!Number.isInteger(quantity)) next.quantity = 'Quantity must be a whole number';
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [selectedTankId, metrics, quantity, maxQuantity]);

  const buildPayload = (): MortalityInput => {
    // Contract: the shell only invokes buildPayload after validate() passes AND
    // it has re-checked `metrics?.batchId` (RecordEntityPage.handleSubmit guard),
    // so batchId is present here. The guard narrows BatchMetrics['batchId']
    // (string | null) to string without a non-null assertion.
    const batchId = metrics?.batchId;
    if (!batchId) {
      throw new Error('Cannot record mortality: selected tank has no active batch');
    }
    return {
      batchId,
      tankId: selectedTankId,
      quantity,
      reason,
      notes: notes.trim() || undefined,
      observedAt: new Date().toISOString(),
    };
  };

  return (
    <RecordEntityPage<MortalityInput>
      theme={MORTALITY_THEME}
      entryTitle="Record Mortality"
      confirmTitle="Confirm Record"
      icon={Skull}
      summaryHeading="Mortality Summary"
      operationName="recordMortality"
      tankEmptyActionWord="mortality"
      selectedTankId={selectedTankId}
      onTankChange={setSelectedTankId}
      errors={errors}
      setErrors={setErrors}
      validate={validate}
      buildPayload={buildPayload}
      canReview={!!selectedTankId && !!metrics?.batchId && quantity >= 1}
      reviewLabel={
        <>
          Review {quantity} Dead Fish
          <ChevronRight size={18} className="ml-1" />
        </>
      }
      submitLabel="Confirm & Record"
      confirmSummary={
        <>
          <SummaryRow label="Tank" value={selectedTank?.name} />
          <SummaryRow label="Batch" value={metrics?.batchNumber ?? '--'} />
          <SummaryDivider />
          {/* The count is the record's headline figure and a machine value, so
              it is set in mono and carries the mortality hue — the same hue the
              icon bubble and the summary heading wear. */}
          <SummaryRow
            label="Dead Fish"
            value={quantity}
            valueClass="text-head font-mono font-bold tabular-nums text-type-mortality"
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
        label="Dead Fish Count"
        value={quantity}
        onChange={(next) => {
          setQuantity(next);
          setErrors((prev) => ({ ...prev, quantity: undefined }));
        }}
        max={maxQuantity}
        error={errors.quantity}
        theme={MORTALITY_THEME}
      />
      <ReasonGrid
        label="Cause of Death"
        value={reason}
        onChange={setReason}
        options={MORTALITY_REASONS}
        theme={MORTALITY_THEME}
      />
      <NotesInput value={notes} onChange={setNotes} />
    </RecordEntityPage>
  );
}
