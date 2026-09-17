/**
 * RecordCullPage — a thin consumer of the shared record scaffold.
 *
 * ORPHAN-MEDIUM-578: this path is superseded by the log sheet and scheduled for
 * retirement, but it is still routed and still writes real records, so it is
 * converted rather than left looking broken. Deleting a live record path means
 * exercising the sheet against a running backend first — a separate, deliberate
 * step, not a side effect of a restyle.
 */
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

/**
 * v4: the orange gradient chrome is gone. Culling is a planned grading
 * decision, not an incident, so the amber `warn` token would misreport it — the
 * screen takes the cull hue from the per-log-type token set instead (icon
 * bubble, summary heading, the headline count). That set is the one place v4
 * lets colour be decorative, because a worker reads an entry's type from its
 * hue before reading a word. The CTA and the selected reason take the accent:
 * in v4 teal carries every action and every active state, on every screen.
 */
const CULL_THEME: RecordEntityTheme = {
  headerGradient: 'bg-surface-1 text-ink-1 border-b border-line',
  accentText: 'text-type-cull',
  summaryHeaderBg: 'bg-type-cull-dim border-line',
  summaryHeaderText: 'text-type-cull',
  iconBubbleBg: 'bg-type-cull-dim',
  surfaceSoftBg: 'bg-type-cull-dim',
  surfaceBorder: 'border-line',
  ctaGradient: 'bg-acc text-acc-on',
  ctaShadow: 'shadow-acc',
  selectionBorder: 'border-acc',
  selectionGlow: 'shadow-acc',
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
          {/* The count is the record's headline figure and a machine value, so
              it is set in mono and carries the cull hue — the same hue the icon
              bubble and the summary heading wear. */}
          <SummaryRow
            label="Culled Fish"
            value={quantity}
            valueClass="text-head font-mono font-bold tabular-nums text-type-cull"
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
