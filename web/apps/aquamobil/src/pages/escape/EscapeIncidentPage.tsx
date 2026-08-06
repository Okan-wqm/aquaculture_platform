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

/**
 * v4: the orange→amber gradient becomes the `warn` token — this screen is a
 * watch state and amber is what the token layer spends on one. The alarm colour
 * (`crit`) is deliberately NOT used for page chrome: it belongs to the varsling
 * banner below, and it only stays loud there if nothing else on the screen
 * shouts in the same voice. The CTA takes the accent, because in v4 teal carries
 * every action.
 *
 * `selectionGlow` was `shadow-glow-amber`, a class the Tailwind config never
 * declared — the selected cause has had no glow at all. `shadow-token` is the
 * theme-aware elevation, so the selected tile is now actually raised.
 */
const ESCAPE_THEME: RecordEntityTheme = {
  headerGradient: 'bg-surface-1 text-ink-1 border-b border-line',
  accentText: 'text-warn',
  summaryHeaderBg: 'bg-warn-dim border-line',
  summaryHeaderText: 'text-warn',
  iconBubbleBg: 'bg-warn-dim',
  surfaceSoftBg: 'bg-warn-dim',
  surfaceBorder: 'border-warn',
  ctaGradient: 'bg-acc text-acc-on',
  ctaShadow: 'shadow-acc',
  selectionBorder: 'border-warn',
  selectionGlow: 'shadow-token',
};

/**
 * The legally-loaded banner: recording here does NOT submit the varsling.
 * Mattilsynet must be notified immediately — the manager owns that call.
 *
 * v4 conversion note: the wording is untouched and the treatment is LOUDER, not
 * quieter. It wears `crit` — the token layer's one alarm colour, which nothing
 * else on this screen is allowed to use — at the full border weight rather than
 * the old red-300 hairline, and the headline moves up a step (14px → text-title
 * 15px). This is the only place on the page where the alarm colour appears, and
 * that exclusivity is what keeps it readable as an alarm.
 */
function VarslingImmediateBanner(): JSX.Element {
  return (
    <div className="mx-4 mt-4 bg-crit-dim rounded-2xl p-4 border-2 border-crit">
      <div className="flex items-start gap-3">
        <ShieldAlert size={24} className="text-crit flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-crit font-bold text-title">
            Escape reporting to Mattilsynet is legally IMMEDIATE
          </p>
          <p className="text-crit text-meta mt-1 flex items-center gap-1">
            <PhoneCall size={12} className="inline flex-shrink-0" />
            Notify your site manager NOW — do not wait for this record to sync.
            The official varsling is submitted from the Reports desk.
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
      reviewLabel={
        <>
          Review ~{estimatedCount.toLocaleString()} Escaped Fish
        </>
      }
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
            valueClass="text-display font-mono font-bold text-warn tabular-nums"
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
