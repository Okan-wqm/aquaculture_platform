/**
 * WelfareScorePage — structured welfare scoring (FARM-HIGH-214 / RPT-019).
 *
 * Captures the four official welfare indicators (gill / fin / wound /
 * deformity) as 0–3 scores over a physical fish sample, offline-first through
 * the durable queue. Replays dedup via the farm_mobile_command_receipts
 * ledger (a welfare assessment is a plain insert — several per tank/day are
 * legitimate, so there is no natural upsert key).
 */
import { clsx } from 'clsx';
import { ChevronRight, HeartPulse } from 'lucide-react';
import { type JSX, useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  NotesInput,
  QuantityStepper,
  RecordEntityPage,
  type RecordEntityTheme,
  SummaryDivider,
  SummaryNotesBlock,
  SummaryRow,
  type BaseFormErrors,
} from '../_shared/RecordEntityPage';

import { useTanks } from '@/hooks/useTanks';
import type { WelfareAssessmentInput } from '@/types';

const WELFARE_THEME: RecordEntityTheme = {
  headerGradient: 'bg-gradient-to-r from-emerald-600 to-emerald-500',
  accentText: 'text-emerald-600',
  summaryHeaderBg:
    'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-800/50',
  summaryHeaderText: 'text-emerald-700 dark:text-emerald-300',
  iconBubbleBg: 'bg-emerald-50 dark:bg-emerald-900/20',
  surfaceSoftBg: 'bg-emerald-50 dark:bg-emerald-900/20',
  surfaceBorder: 'border-emerald-100 dark:border-emerald-800',
  ctaGradient: 'bg-gradient-to-r from-emerald-600 to-emerald-500',
  ctaShadow: 'shadow-emerald-500/25',
  selectionBorder: 'border-emerald-500',
  selectionGlow: 'shadow-glow-green',
};

const SCORE_LABELS = ['0 · Healthy', '1 · Mild', '2 · Moderate', '3 · Severe'] as const;

/**
 * 0–3 segmented score selector. 56px-tall targets like the shared stepper —
 * field workers tap with wet or gloved hands.
 */
function ScoreDial(props: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}): JSX.Element {
  const { label, value, onChange } = props;
  return (
    <div className="px-4 mt-4">
      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">{label}</h3>
      <div className="grid grid-cols-4 gap-2">
        {SCORE_LABELS.map((scoreLabel, score) => {
          const selected = value === score;
          return (
            <button
              key={scoreLabel}
              type="button"
              onClick={() => onChange(score)}
              className={clsx(
                'py-3 rounded-2xl border-2 text-sm font-bold transition-all touch-feedback bg-white dark:bg-gray-900',
                selected
                  ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 scale-[1.02]'
                  : 'border-gray-100 dark:border-gray-800 text-gray-500',
              )}
            >
              {scoreLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function WelfareScorePage(): JSX.Element {
  const { tankId } = useParams<{ tankId?: string }>();
  const { data: tanks } = useTanks();

  const [selectedTankId, setSelectedTankId] = useState(tankId || '');
  const [gillScore, setGillScore] = useState(0);
  const [finScore, setFinScore] = useState(0);
  const [woundScore, setWoundScore] = useState(0);
  const [deformityScore, setDeformityScore] = useState(0);
  const [fishSampled, setFishSampled] = useState(10);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<BaseFormErrors>({});

  const selectedTank = tanks?.find((t) => t.id === selectedTankId);
  const metrics = selectedTank?.batchMetrics;

  const validate = useCallback((): boolean => {
    const next: BaseFormErrors = {};
    if (!selectedTankId) next.tank = 'Please select a tank';
    if (!metrics) next.tank = 'Selected tank has no active batch';
    if (selectedTank && !selectedTank.siteId) {
      next.tank = 'Selected tank has no site — contact your administrator';
    }
    if (fishSampled < 1) next.quantity = 'At least 1 fish must be sampled';
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [selectedTankId, selectedTank, metrics, fishSampled]);

  const buildPayload = (): WelfareAssessmentInput => {
    const siteId = selectedTank?.siteId;
    if (!siteId) {
      throw new Error('Cannot record welfare assessment: selected tank has no site');
    }
    return {
      siteId,
      tankId: selectedTankId,
      batchId: metrics?.batchId ?? undefined,
      assessedAt: new Date().toISOString().slice(0, 10),
      fishSampled,
      gillScore,
      finScore,
      woundScore,
      deformityScore,
      notes: notes.trim() || undefined,
    };
  };

  return (
    <RecordEntityPage<WelfareAssessmentInput>
      theme={WELFARE_THEME}
      entryTitle="Welfare Scores"
      confirmTitle="Confirm Welfare Scores"
      icon={HeartPulse}
      summaryHeading="Welfare Summary"
      operationName="recordWelfareAssessment"
      tankEmptyActionWord="a welfare assessment"
      selectedTankId={selectedTankId}
      onTankChange={setSelectedTankId}
      errors={errors}
      setErrors={setErrors}
      validate={validate}
      buildPayload={buildPayload}
      canReview={!!selectedTankId && !!metrics?.batchId && fishSampled >= 1}
      reviewLabel={
        <>
          Review Welfare Scores
          <ChevronRight size={18} className="ml-1" />
        </>
      }
      submitLabel="Confirm & Record"
      confirmSummary={
        <>
          <SummaryRow label="Tank" value={selectedTank?.name} />
          <SummaryRow label="Batch" value={metrics?.batchNumber ?? '--'} />
          <SummaryDivider />
          <SummaryRow label="Gill score" value={SCORE_LABELS[gillScore]} />
          <SummaryRow label="Fin score" value={SCORE_LABELS[finScore]} />
          <SummaryRow label="Wound score" value={SCORE_LABELS[woundScore]} />
          <SummaryRow label="Deformity score" value={SCORE_LABELS[deformityScore]} />
          <SummaryRow label="Fish sampled" value={fishSampled} />
          {notes.trim() && (
            <>
              <SummaryDivider />
              <SummaryNotesBlock notes={notes} />
            </>
          )}
        </>
      }
    >
      <ScoreDial label="Gill condition" value={gillScore} onChange={setGillScore} />
      <ScoreDial label="Fin condition" value={finScore} onChange={setFinScore} />
      <ScoreDial label="Wounds" value={woundScore} onChange={setWoundScore} />
      <ScoreDial label="Deformities" value={deformityScore} onChange={setDeformityScore} />
      <QuantityStepper
        label="Fish Sampled"
        value={fishSampled}
        onChange={(next) => {
          setFishSampled(next);
          setErrors((prev) => ({ ...prev, quantity: undefined }));
        }}
        max={100}
        error={errors.quantity}
        theme={WELFARE_THEME}
      />
      <NotesInput value={notes} onChange={setNotes} />
    </RecordEntityPage>
  );
}
