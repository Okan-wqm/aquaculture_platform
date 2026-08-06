/**
 * LiceCountPage — weekly lakselus field capture (FARM-HIGH-214 / RPT-019).
 *
 * Records the three official lice stages as per-fish averages over a counted
 * sample, offline-first through the durable queue. The backend upserts on
 * (tenant, tank, countDate), so a re-count of the same pen on the same day
 * corrects the earlier row — the natural idempotency the weekly lakselus
 * assembler relies on.
 */
import { Bug, ChevronRight } from 'lucide-react';
import { type JSX, useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  NotesInput,
  NumberField,
  QuantityStepper,
  RecordEntityPage,
  type RecordEntityTheme,
  SummaryDivider,
  SummaryNotesBlock,
  SummaryRow,
  type BaseFormErrors,
} from '../_shared/RecordEntityPage';

import { PhotoCaptureField } from '@/components/PhotoCaptureField';
import { useTanks } from '@/hooks/useTanks';
import type { LiceCountInput } from '@/types';

/**
 * v4: the violet gradient is gone. It was page identity, not meaning — and a
 * gradient header costs contrast in the sunlight this screen is filled in. The
 * accent carries the action and the active state, which is the whole of what
 * the violet was doing; the screen is identified by its title and its Bug icon.
 */
const LICE_THEME: RecordEntityTheme = {
  headerGradient: 'bg-surface-1 text-ink-1 border-b border-line',
  accentText: 'text-acc',
  summaryHeaderBg: 'bg-acc-dim border-line',
  summaryHeaderText: 'text-acc',
  iconBubbleBg: 'bg-acc-dim',
  surfaceSoftBg: 'bg-acc-dim',
  surfaceBorder: 'border-line',
  ctaGradient: 'bg-acc text-acc-on',
  ctaShadow: 'shadow-acc',
  selectionBorder: 'border-acc',
  selectionGlow: 'shadow-acc',
};

interface LiceFormErrors extends BaseFormErrors {
  stages?: string;
  fishSampled?: string;
}

export function LiceCountPage(): JSX.Element {
  const { tankId } = useParams<{ tankId?: string }>();
  const { data: tanks } = useTanks();

  const [selectedTankId, setSelectedTankId] = useState(tankId || '');
  const [adultFemaleLice, setAdultFemaleLice] = useState<number | null>(null);
  const [mobileLice, setMobileLice] = useState<number | null>(null);
  const [attachedLice, setAttachedLice] = useState<number | null>(null);
  // Regulation counts 10 or 20 fish per pen depending on season — 20 is the
  // common default; the operator adjusts with the stepper.
  const [fishSampled, setFishSampled] = useState(20);
  const [seaTemperatureC, setSeaTemperatureC] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [mediaKeys, setMediaKeys] = useState<string[]>([]);
  const [errors, setErrors] = useState<LiceFormErrors>({});

  const selectedTank = tanks?.find((t) => t.id === selectedTankId);
  const metrics = selectedTank?.batchMetrics;

  const validate = useCallback((): boolean => {
    const next: LiceFormErrors = {};
    if (!selectedTankId) next.tank = 'Please select a tank';
    if (!metrics) next.tank = 'Selected tank has no active batch';
    if (selectedTank && !selectedTank.siteId) {
      next.tank = 'Selected tank has no site — contact your administrator';
    }
    if (adultFemaleLice === null || mobileLice === null || attachedLice === null) {
      next.stages = 'Enter all three lice stages (0 is a valid count)';
    } else if (adultFemaleLice < 0 || mobileLice < 0 || attachedLice < 0) {
      next.stages = 'Lice averages cannot be negative';
    }
    if (fishSampled < 1) next.fishSampled = 'At least 1 fish must be sampled';
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [selectedTankId, selectedTank, metrics, adultFemaleLice, mobileLice, attachedLice, fishSampled]);

  const buildPayload = (): LiceCountInput => {
    const siteId = selectedTank?.siteId;
    if (!siteId) {
      throw new Error('Cannot record lice count: selected tank has no site');
    }
    if (adultFemaleLice === null || mobileLice === null || attachedLice === null) {
      throw new Error('Cannot record lice count: all three stages are required');
    }
    return {
      siteId,
      tankId: selectedTankId,
      batchId: metrics?.batchId ?? undefined,
      countDate: new Date().toISOString().slice(0, 10),
      adultFemaleLice,
      mobileLice,
      attachedLice,
      fishSampled,
      seaTemperatureC: seaTemperatureC ?? undefined,
      notes: notes.trim() || undefined,
      mediaKeys: mediaKeys.length > 0 ? mediaKeys : undefined,
    };
  };

  return (
    <RecordEntityPage<LiceCountInput, LiceFormErrors>
      theme={LICE_THEME}
      entryTitle="Lice Count"
      confirmTitle="Confirm Lice Count"
      icon={Bug}
      summaryHeading="Lice Count Summary"
      operationName="recordLiceCount"
      tankEmptyActionWord="a lice count"
      selectedTankId={selectedTankId}
      onTankChange={setSelectedTankId}
      errors={errors}
      setErrors={setErrors}
      validate={validate}
      buildPayload={buildPayload}
      canReview={
        !!selectedTankId &&
        !!metrics?.batchId &&
        adultFemaleLice !== null &&
        mobileLice !== null &&
        attachedLice !== null &&
        fishSampled >= 1
      }
      reviewLabel={
        <>
          Review Lice Count
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
            label="Adult female (voksne hunnlus)"
            value={adultFemaleLice ?? '--'}
            valueClass="text-head font-bold text-acc"
          />
          <SummaryRow label="Mobile (bevegelige)" value={mobileLice ?? '--'} />
          <SummaryRow label="Attached (fastsittende)" value={attachedLice ?? '--'} />
          <SummaryRow label="Fish sampled" value={fishSampled} />
          {seaTemperatureC !== null && (
            <SummaryRow label="Sea temperature" value={`${seaTemperatureC} °C`} />
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
      <div className="px-0 mt-2">
        <NumberField
          label="Adult female lice (avg per fish)"
          value={adultFemaleLice}
          onChange={(v) => {
            setAdultFemaleLice(v);
            setErrors((prev) => ({ ...prev, stages: undefined }));
          }}
          placeholder="0.00"
        />
        <NumberField
          label="Mobile lice (avg per fish)"
          value={mobileLice}
          onChange={(v) => {
            setMobileLice(v);
            setErrors((prev) => ({ ...prev, stages: undefined }));
          }}
          placeholder="0.00"
        />
        <NumberField
          label="Attached lice (avg per fish)"
          value={attachedLice}
          onChange={(v) => {
            setAttachedLice(v);
            setErrors((prev) => ({ ...prev, stages: undefined }));
          }}
          placeholder="0.00"
        />
        {errors.stages && <p className="text-crit text-body px-4 mt-1">{errors.stages}</p>}
      </div>
      <QuantityStepper
        label="Fish Sampled"
        value={fishSampled}
        onChange={(next) => {
          setFishSampled(next);
          setErrors((prev) => ({ ...prev, fishSampled: undefined }));
        }}
        max={100}
        error={errors.fishSampled}
        theme={LICE_THEME}
      />
      <NumberField
        label="Sea temperature °C (optional — sensor fills when omitted)"
        value={seaTemperatureC}
        onChange={setSeaTemperatureC}
        placeholder="e.g. 8.5"
        step="0.1"
        min={-2}
      />
      <NotesInput value={notes} onChange={setNotes} />
      <PhotoCaptureField incidentType="LICE" value={mediaKeys} onChange={setMediaKeys} />
    </RecordEntityPage>
  );
}
