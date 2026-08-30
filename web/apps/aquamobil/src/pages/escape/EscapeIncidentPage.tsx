/**
 * EscapeIncidentPage — operational escape capture (FARM-HIGH-214 / RPT-019).
 *
 * Records that fish escaped (or may have escaped) from a pen, offline-first
 * through the durable queue with PRIORITY drain — on reconnect, escape
 * incidents flush before the rest of the backlog because the rømming
 * varsling to Mattilsynet is legally IMMEDIATE. The varsling submission
 * itself stays on the desktop regulatory path (one submission path); this
 * page's job is to make the operational fact durable the moment it is seen,
 * and to tell the operator to notify the manager NOW.
 *
 * Replays dedup via the farm_mobile_command_receipts ledger — a replayed
 * clientCommandId returns the original incident instead of double-filing.
 */
import { PhoneCall, ShieldAlert, TriangleAlert } from 'lucide-react';
import { type JSX, useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  NotesInput,
  NumberField,
  QuantityStepper,
  ReasonGrid,
  RecordEntityPage,
  type RecordEntityTheme,
  SummaryDivider,
  SummaryNotesBlock,
  SummaryRow,
  type BaseFormErrors,
} from '../_shared/RecordEntityPage';

import { PhotoCaptureField } from '@/components/PhotoCaptureField';
import { useTanks } from '@/hooks/useTanks';
import type { EscapeIncidentCause, EscapeIncidentInput } from '@/types';

const ESCAPE_CAUSES: ReadonlyArray<{ value: EscapeIncidentCause; label: string; emoji: string }> = [
  { value: 'HOLE_IN_NET', label: 'Hole in Net', emoji: '🕳️' },
  { value: 'HANDLING', label: 'Handling', emoji: '🤲' },
  { value: 'PREDATOR', label: 'Predator', emoji: '🦭' },
  { value: 'STRUCTURAL_FAILURE', label: 'Structural', emoji: '🏗️' },
  { value: 'OPERATIONAL', label: 'Operational', emoji: '⚙️' },
  { value: 'UNKNOWN', label: 'Unknown', emoji: '❓' },
  { value: 'OTHER', label: 'Other', emoji: '📝' },
];

const ESCAPE_THEME: RecordEntityTheme = {
  headerGradient: 'bg-gradient-to-r from-orange-600 to-amber-500',
  accentText: 'text-orange-600',
  summaryHeaderBg: 'bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-800/50',
  summaryHeaderText: 'text-orange-700 dark:text-orange-300',
  iconBubbleBg: 'bg-orange-50 dark:bg-orange-900/20',
  surfaceSoftBg: 'bg-orange-50 dark:bg-orange-900/20',
  surfaceBorder: 'border-orange-100 dark:border-orange-800',
  ctaGradient: 'bg-gradient-to-r from-orange-600 to-amber-500',
  ctaShadow: 'shadow-orange-500/25',
  selectionBorder: 'border-orange-500',
  selectionGlow: 'shadow-glow-amber',
};

/**
 * The legally-loaded banner: recording here does NOT submit the varsling.
 * Mattilsynet must be notified immediately — the manager owns that call.
 */
function VarslingImmediateBanner(): JSX.Element {
  return (
    <div className="mx-4 mt-4 bg-red-50 dark:bg-red-900/20 rounded-2xl p-4 border-2 border-red-300 dark:border-red-800">
      <div className="flex items-start gap-3">
        <ShieldAlert size={24} className="text-red-600 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-red-700 dark:text-red-300 font-bold text-sm">
            Escape reporting to Mattilsynet is legally IMMEDIATE
          </p>
          <p className="text-red-600 dark:text-red-400 text-xs mt-1 flex items-center gap-1">
            <PhoneCall size={12} className="inline flex-shrink-0" />
            Notify your site manager NOW — do not wait for this record to sync. The official
            varsling is submitted from the Reports desk.
          </p>
        </div>
      </div>
    </div>
  );
}

export function EscapeIncidentPage(): JSX.Element {
  const { tankId } = useParams<{ tankId?: string }>();
  const { data: tanks } = useTanks();

  const [selectedTankId, setSelectedTankId] = useState(tankId || '');
  const [estimatedCount, setEstimatedCount] = useState(1);
  const [cause, setCause] = useState<EscapeIncidentCause>('UNKNOWN');
  const [avgWeightG, setAvgWeightG] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [mediaKeys, setMediaKeys] = useState<string[]>([]);
  const [errors, setErrors] = useState<BaseFormErrors>({});

  const selectedTank = tanks?.find((t) => t.id === selectedTankId);
  const metrics = selectedTank?.batchMetrics;
  const selectedCause = ESCAPE_CAUSES.find((c) => c.value === cause);

  const validate = useCallback((): boolean => {
    const next: BaseFormErrors = {};
    if (!selectedTankId) next.tank = 'Please select a tank';
    if (!metrics) next.tank = 'Selected tank has no active batch';
    if (selectedTank && !selectedTank.siteId) {
      next.tank = 'Selected tank has no site — contact your administrator';
    }
    if (metrics && !metrics.speciesId) {
      next.tank = 'Batch species is unknown — refresh tank data while online';
    }
    if (estimatedCount < 1) next.quantity = 'Estimated count must be at least 1';
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [selectedTankId, selectedTank, metrics, estimatedCount]);

  const buildPayload = (): EscapeIncidentInput => {
    const siteId = selectedTank?.siteId;
    const speciesId = metrics?.speciesId;
    if (!siteId) {
      throw new Error('Cannot record escape incident: selected tank has no site');
    }
    if (!speciesId) {
      throw new Error('Cannot record escape incident: batch species is unknown');
    }
    return {
      siteId,
      tankId: selectedTankId,
      batchId: metrics?.batchId ?? undefined,
      detectedAt: new Date().toISOString(),
      speciesId,
      estimatedCount,
      avgWeightG: avgWeightG ?? metrics?.avgWeight ?? undefined,
      cause,
      recoveryOngoing: false,
      notes: notes.trim() || undefined,
      mediaKeys: mediaKeys.length > 0 ? mediaKeys : undefined,
    };
  };

  return (
    <RecordEntityPage<EscapeIncidentInput>
      theme={ESCAPE_THEME}
      entryTitle="Escape Incident"
      confirmTitle="Confirm Escape Incident"
      icon={TriangleAlert}
      summaryHeading="Escape Summary"
      operationName="recordEscapeIncident"
      tankEmptyActionWord="an escape incident"
      selectedTankId={selectedTankId}
      onTankChange={setSelectedTankId}
      errors={errors}
      setErrors={setErrors}
      validate={validate}
      buildPayload={buildPayload}
      canReview={
        !!selectedTankId && !!metrics?.batchId && !!metrics?.speciesId && estimatedCount >= 1
      }
      reviewLabel={<>Review ~{estimatedCount.toLocaleString()} Escaped Fish</>}
      submitLabel="Confirm & Record"
      confirmSummary={
        <>
          <SummaryRow label="Tank" value={selectedTank?.name} />
          <SummaryRow label="Batch" value={metrics?.batchNumber ?? '--'} />
          <SummaryRow label="Species" value={metrics?.speciesName ?? '--'} />
          <SummaryDivider />
          <SummaryRow
            label="Estimated escaped"
            value={`~${estimatedCount.toLocaleString()}`}
            valueClass="text-2xl font-bold text-orange-600"
          />
          <SummaryRow
            label="Cause"
            value={`${selectedCause?.emoji ?? ''} ${selectedCause?.label ?? ''}`}
          />
          {(avgWeightG ?? metrics?.avgWeight) != null && (
            <SummaryRow label="Avg weight" value={`${avgWeightG ?? metrics?.avgWeight} g`} />
          )}
          {notes.trim() && (
            <>
              <SummaryDivider />
              <SummaryNotesBlock notes={notes} />
            </>
          )}
        </>
      }
    >
      <VarslingImmediateBanner />
      <QuantityStepper
        label="Estimated Escaped Fish"
        value={estimatedCount}
        onChange={(next) => {
          setEstimatedCount(next);
          setErrors((prev) => ({ ...prev, quantity: undefined }));
        }}
        max={metrics?.pieces ?? 1_000_000}
        error={errors.quantity}
        theme={ESCAPE_THEME}
      />
      <ReasonGrid
        label="Suspected Cause"
        value={cause}
        onChange={setCause}
        options={ESCAPE_CAUSES}
        theme={ESCAPE_THEME}
      />
      <NumberField
        label={`Avg weight g (optional — defaults to batch avg${metrics?.avgWeight ? ` ${metrics.avgWeight}g` : ''})`}
        value={avgWeightG}
        onChange={setAvgWeightG}
        placeholder="e.g. 3500"
        step="1"
      />
      <NotesInput
        value={notes}
        onChange={setNotes}
        placeholder="What happened? Net damage location, weather, recovery started..."
      />
      <PhotoCaptureField incidentType="ESCAPE" value={mediaKeys} onChange={setMediaKeys} />
    </RecordEntityPage>
  );
}
