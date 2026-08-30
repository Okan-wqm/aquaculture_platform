/**
 * Slaughter Report Tab
 * Planned and completed slaughter (slakt) reports
 * Aligned with Norwegian Mattilsynet "slakt" API requirements
 * - Weekly report structure (uke/aar)
 * - Batch auto-populate from tanks
 * - Quality grade distribution (Superior, Ordinary, Production, Discard)
 * - Slaughter facility with approval number
 * - Regulatory metadata from settings
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  useRegulatorySettings,
  useSubmitPlannedSlaughterReport,
} from '../../../hooks/useRegulatory';
import type {
  SubmitPlannedSlaughterInput,
  ReportSubmissionResult,
} from '../../../hooks/useRegulatory';
import { PlannedSlaughter, CompletedSlaughter, SlaughterReportType } from '../types/reports.types';
import { ReportWizard, ReportWizardStep } from '../components/wizard/ReportWizard';
import { SubmissionHistorySection } from '../components/SubmissionHistorySection';
import { useStableClientReference } from '../../../hooks/useStableClientReference';
import { useTanksList, Tank } from '../../../hooks/useTanks';
import { useSlaughterFacilities } from '../../../hooks/useSlaughterFacilities';

// ============================================================================
// Types
// ============================================================================

interface SlaughterReportTabProps {
  siteId?: string;
}

/** Quality grade with Norwegian translation */
interface QualityGradeDistribution {
  superior: number; // Superioer
  ordinary: number; // Ordinaer
  production: number; // Produksjonsfisk
  discard: number; // Kassert
}

/** Slaughter facility info */
interface SlaughterFacility {
  facilityName: string; // godkjenningsnavn
  approvalNumber: string; // godkjenningsnummer
}

/** Regulatory metadata from settings */
interface RegulatoryMetadata {
  organisasjonsnummer: string;
  lokalitetsnummer: number | '';
  kontaktperson: {
    navn: string;
    epost: string;
    telefonnummer: string;
  };
}

/** Day plan entry for planned slaughter (Mon-Sun structure) */
interface DayPlanEntry {
  dayOfWeek: number; // 0=Mon, 6=Sun
  dayLabel: string;
  dateStr: string;
  species: string;
  artskode: string;
  quantity: number;
  biomassKg: number;
  batchId: string;
  batchNumber: string;
}

export interface SlaughterFormData {
  reportType: SlaughterReportType;
  // Week/year selection
  weekNumber: number;
  year: number;
  // Slaughter facility
  facility: SlaughterFacility;
  // Regulatory metadata
  regulatory: RegulatoryMetadata;
  // Planned slaughter: day-by-day schedule
  dayPlans: DayPlanEntry[];
  // Completed slaughters (legacy)
  plannedSlaughters: PlannedSlaughter[];
  completedSlaughters: CompletedSlaughter[];
  // Quality grade distribution for completed
  gradeDistribution: QualityGradeDistribution;
  summary: {
    totalPlanned: number;
    totalCompleted: number;
    plannedBiomassKg: number;
    completedBiomassKg: number;
  };
}

/** Batch option derived from tank data */
interface BatchOption {
  batchId: string;
  batchNumber: string;
  species: string;
  speciesCode: string;
  quantity: number;
  biomassKg: number;
  avgWeight: number;
  tankName: string;
  status: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatNumber(num: number): string {
  return num.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

function formatWeight(kg: number): string {
  if (kg >= 1000) {
    return `${(kg / 1000).toFixed(1)}t`;
  }
  return `${formatNumber(kg)}kg`;
}

/** Get ISO week number for a date */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Get start date (Monday) of a given ISO week */
function getWeekStartDate(week: number, year: number): Date {
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  return monday;
}

/** Get end date (Sunday) of a given ISO week */
function getWeekEndDate(week: number, year: number): Date {
  const start = getWeekStartDate(week, year);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return end;
}

/** Format week range label */
function getWeekLabel(week: number, year: number): string {
  const start = getWeekStartDate(week, year);
  const end = getWeekEndDate(week, year);
  const fmtStart = start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const fmtEnd = end.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `Week ${week}: ${fmtStart} - ${fmtEnd}`;
}

/** Day labels for Mon-Sun */
const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Get day dates for a week */
function getDayDatesForWeek(week: number, year: number): string[] {
  const start = getWeekStartDate(week, year);
  return DAY_LABELS.map((_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d.toISOString().split('T')[0];
  });
}

/** Extract batches from tanks data */
function extractBatchOptions(tanks: Tank[] | undefined): BatchOption[] {
  if (!tanks) return [];
  const options: BatchOption[] = [];
  for (const tank of tanks) {
    if (!tank.batchMetrics?.batchId || !tank.batchMetrics?.batchNumber) continue;
    const m = tank.batchMetrics;
    // Only show ACTIVE or PRE_HARVEST status tanks
    const tankStatus = (tank.status || '').toUpperCase();
    if (
      tankStatus !== 'ACTIVE' &&
      tankStatus !== 'OPERATIONAL' &&
      tankStatus !== 'HARVESTING' &&
      tankStatus !== 'PRE_HARVEST'
    )
      continue;
    options.push({
      batchId: m.batchId!,
      batchNumber: m.batchNumber!,
      species: m.speciesCode || 'Atlantic Salmon',
      speciesCode: m.speciesCode || '',
      quantity: m.pieces || 0,
      biomassKg: m.biomass || 0,
      avgWeight: m.avgWeight || 0,
      tankName: tank.name,
      status: tank.status,
    });
  }
  return options;
}

export function getInitialFormData(): SlaughterFormData {
  const now = new Date();
  return {
    reportType: 'planned',
    weekNumber: getWeekNumber(now),
    year: now.getFullYear(),
    facility: {
      facilityName: '',
      approvalNumber: '',
    },
    regulatory: {
      organisasjonsnummer: '',
      lokalitetsnummer: '',
      kontaktperson: {
        navn: '',
        epost: '',
        telefonnummer: '',
      },
    },
    dayPlans: [],
    plannedSlaughters: [],
    completedSlaughters: [],
    gradeDistribution: {
      superior: 0,
      ordinary: 0,
      production: 0,
      discard: 0,
    },
    summary: {
      totalPlanned: 0,
      totalCompleted: 0,
      plannedBiomassKg: 0,
      completedBiomassKg: 0,
    },
  };
}

function calculateSummary(
  planned: PlannedSlaughter[],
  completed: CompletedSlaughter[],
  dayPlans?: DayPlanEntry[],
) {
  const dayPlanQuantity = dayPlans?.reduce((sum, d) => sum + d.quantity, 0) || 0;
  const dayPlanBiomass = dayPlans?.reduce((sum, d) => sum + d.biomassKg, 0) || 0;

  return {
    totalPlanned: planned.reduce((sum, p) => sum + p.estimatedQuantity, 0) + dayPlanQuantity,
    totalCompleted: completed.reduce((sum, c) => sum + c.actualQuantity, 0),
    plannedBiomassKg: planned.reduce((sum, p) => sum + p.estimatedBiomassKg, 0) + dayPlanBiomass,
    completedBiomassKg: completed.reduce((sum, c) => sum + c.actualBiomassKg, 0),
  };
}

// ============================================================================
// Wizard Step Components
// ============================================================================

interface ReportTypeStepProps {
  formData: SlaughterFormData;
  onChange: (data: Partial<SlaughterFormData>) => void;
  siteName: string;
}

const ReportTypeStep: React.FC<ReportTypeStepProps> = ({ formData, onChange, siteName }) => {
  const weekLabel = getWeekLabel(formData.weekNumber, formData.year);

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Site</label>
        <input
          type="text"
          value={siteName}
          disabled
          className="w-full px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-gray-700"
        />
      </div>

      {/* Week / Year Selection */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Week Number</label>
          <input
            type="number"
            min={1}
            max={52}
            value={formData.weekNumber}
            onChange={(e) =>
              onChange({ weekNumber: Math.min(52, Math.max(1, parseInt(e.target.value) || 1)) })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-700"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Year</label>
          <input
            type="number"
            min={2020}
            max={2030}
            value={formData.year}
            onChange={(e) =>
              onChange({ year: parseInt(e.target.value) || new Date().getFullYear() })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-700"
          />
        </div>
      </div>
      <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-md">
        <span className="text-sm text-blue-700 font-medium">{weekLabel}</span>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Report Type</label>
        <div className="grid grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => onChange({ reportType: 'planned' })}
            className={`p-4 border-2 rounded-lg text-center ${
              formData.reportType === 'planned'
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <div className="p-3 bg-blue-100 rounded-lg inline-block mb-2">
              <svg
                className="w-6 h-6 text-blue-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div className="font-medium text-gray-900">Planned Slaughter</div>
            <div className="text-xs text-gray-500">Planlagt Slakt</div>
            <div className="text-xs text-gray-400 mt-1">Weekly schedule by day</div>
          </button>
          {/* Executed (utført) slaughter is filed from harvest records via the
              records-based "Scheduled reports due" review-and-approve draft — the
              manual grade-percentage form cannot compute per-species gutted kg, so
              it is disabled here to prevent a fabricated filing. */}
          <div
            className="p-4 border-2 border-gray-200 rounded-lg text-center opacity-60 cursor-not-allowed"
            aria-disabled="true"
            title="Executed slaughter is filed from harvest records — see “Scheduled reports due”."
          >
            <div className="p-3 bg-gray-100 rounded-lg inline-block mb-2">
              <svg
                className="w-6 h-6 text-gray-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <div className="font-medium text-gray-900">Executed Slaughter</div>
            <div className="text-xs text-gray-500">Utført Slakt</div>
            <div className="text-xs text-gray-400 mt-1">
              Filed from records — see “Scheduled reports due”
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Slaughter Facility Step
// ============================================================================

interface FacilityStepProps {
  formData: SlaughterFormData;
  onChange: (data: Partial<SlaughterFormData>) => void;
}

export const FacilityStep: React.FC<FacilityStepProps> = ({ formData, onChange }) => {
  // The slaughter-facility catalog is the SSoT for godkjenningsnummer (Phase 2 /
  // RPT-007): the report binds an approved facility from Setup rather than
  // accepting free text, so the approval number cannot drift from the catalog
  // the server-side slakt assembler reads.
  const { data: facilities = [], isLoading: facilitiesLoading } = useSlaughterFacilities();

  const updateFacility = (updates: Partial<SlaughterFacility>) => {
    onChange({ facility: { ...formData.facility, ...updates } });
  };

  // Seed the default facility once the catalog resolves and none is chosen yet.
  // The empty-approvalNumber guard makes this idempotent: after onChange sets the
  // facility, formData.facility changes and the effect re-runs into a no-op, so
  // declaring the real deps (no exhaustive-deps suppression) cannot loop.
  useEffect(() => {
    if (!formData.facility.approvalNumber && facilities.length > 0) {
      const preferred = facilities.find((f) => f.isDefault) ?? facilities[0];
      if (preferred) {
        onChange({
          facility: {
            ...formData.facility,
            facilityName: preferred.name,
            approvalNumber: preferred.godkjenningsnummer,
          },
        });
      }
    }
  }, [facilities, formData.facility, onChange]);

  const selectedFacilityId =
    facilities.find((f) => f.godkjenningsnummer === formData.facility.approvalNumber)?.id ?? '';

  const updateRegulatory = (updates: Partial<RegulatoryMetadata>) => {
    onChange({ regulatory: { ...formData.regulatory, ...updates } });
  };

  const updateKontakt = (updates: Partial<RegulatoryMetadata['kontaktperson']>) => {
    onChange({
      regulatory: {
        ...formData.regulatory,
        kontaktperson: { ...formData.regulatory.kontaktperson, ...updates },
      },
    });
  };

  return (
    <div className="space-y-6">
      {/* Regulatory Metadata */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h4 className="text-sm font-medium text-gray-700">Regulatory Metadata</h4>
          <span className="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-700 rounded">
            Mattilsynet
          </span>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          These will be populated from Setup &gt; Regulatory Settings
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Organization Number (organisasjonsnummer)
            </label>
            <input
              type="text"
              value={formData.regulatory.organisasjonsnummer}
              onChange={(e) => updateRegulatory({ organisasjonsnummer: e.target.value })}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              placeholder="123456789"
              maxLength={9}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Site Number (lokalitetsnummer)
            </label>
            <input
              type="number"
              value={formData.regulatory.lokalitetsnummer}
              onChange={(e) =>
                updateRegulatory({ lokalitetsnummer: parseInt(e.target.value, 10) || '' })
              }
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              placeholder="31234"
            />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Contact Person (navn)</label>
            <input
              type="text"
              value={formData.regulatory.kontaktperson.navn}
              onChange={(e) => updateKontakt({ navn: e.target.value })}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              placeholder="Erik Hansen"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Email (epost)</label>
            <input
              type="email"
              value={formData.regulatory.kontaktperson.epost}
              onChange={(e) => updateKontakt({ epost: e.target.value })}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              placeholder="erik@example.no"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Phone (telefonnummer)</label>
            <input
              type="text"
              value={formData.regulatory.kontaktperson.telefonnummer}
              onChange={(e) => updateKontakt({ telefonnummer: e.target.value })}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              placeholder="+47 123 45 678"
            />
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-gray-200" />

      {/* Slaughter Facility */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h4 className="text-sm font-medium text-gray-700">Slaughter Facility</h4>
          <span className="px-2 py-0.5 text-xs bg-purple-100 text-purple-700 rounded">
            Required
          </span>
        </div>
        {facilitiesLoading ? (
          <p className="text-xs text-gray-400">Loading facilities…</p>
        ) : facilities.length === 0 ? (
          <p className="text-xs text-amber-600">
            No slaughter facilities registered. Add one under Setup → Slaughter Facilities — the
            catalog is the source of the approval number (godkjenningsnummer) the report submits.
          </p>
        ) : (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Facility (slakteri) *</label>
            <select
              value={selectedFacilityId}
              onChange={(e) => {
                const picked = facilities.find((f) => f.id === e.target.value);
                if (picked) {
                  updateFacility({
                    facilityName: picked.name,
                    approvalNumber: picked.godkjenningsnummer,
                  });
                }
              }}
              aria-label="Slaughter facility"
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
            >
              <option value="" disabled>
                Select a facility…
              </option>
              {facilities.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} — {f.godkjenningsnummer}
                  {f.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
            {formData.facility.approvalNumber && (
              <p className="text-xs text-gray-500 mt-1">
                Approval number (godkjenningsnummer):{' '}
                <span className="font-medium text-gray-700">
                  {formData.facility.approvalNumber}
                </span>{' '}
                — from the facility catalog; corrections go to Setup.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Planned Slaughter Step (Day-by-Day for the Week)
// ============================================================================

interface PlannedSlaughterStepProps {
  formData: SlaughterFormData;
  onChange: (data: Partial<SlaughterFormData>) => void;
  batchOptions: BatchOption[];
}

const PlannedSlaughterStep: React.FC<PlannedSlaughterStepProps> = ({
  formData,
  onChange,
  batchOptions,
}) => {
  const dayDates = useMemo(
    () => getDayDatesForWeek(formData.weekNumber, formData.year),
    [formData.weekNumber, formData.year],
  );

  const addDayPlan = (dayIndex: number) => {
    const newPlan: DayPlanEntry = {
      dayOfWeek: dayIndex,
      dayLabel: DAY_LABELS[dayIndex],
      dateStr: dayDates[dayIndex],
      species: '',
      artskode: '',
      quantity: 0,
      biomassKg: 0,
      batchId: '',
      batchNumber: '',
    };
    const dayPlans = [...formData.dayPlans, newPlan];
    onChange({
      dayPlans,
      summary: calculateSummary(formData.plannedSlaughters, formData.completedSlaughters, dayPlans),
    });
  };

  const updateDayPlan = (index: number, updates: Partial<DayPlanEntry>) => {
    const dayPlans = formData.dayPlans.map((p, i) => (i === index ? { ...p, ...updates } : p));
    onChange({
      dayPlans,
      summary: calculateSummary(formData.plannedSlaughters, formData.completedSlaughters, dayPlans),
    });
  };

  const removeDayPlan = (index: number) => {
    const dayPlans = formData.dayPlans.filter((_, i) => i !== index);
    onChange({
      dayPlans,
      summary: calculateSummary(formData.plannedSlaughters, formData.completedSlaughters, dayPlans),
    });
  };

  const handleBatchSelect = (planIndex: number, batchId: string) => {
    const batch = batchOptions.find((b) => b.batchId === batchId);
    if (batch) {
      updateDayPlan(planIndex, {
        batchId: batch.batchId,
        batchNumber: batch.batchNumber,
        species: batch.species,
        artskode: batch.speciesCode,
        quantity: batch.quantity,
        biomassKg: batch.biomassKg,
      });
    } else {
      updateDayPlan(planIndex, { batchId: '', batchNumber: '' });
    }
  };

  // Group day plans by day of week
  const dayPlansGrouped = useMemo(() => {
    const grouped: Record<number, { plans: Array<DayPlanEntry & { originalIndex: number }> }> = {};
    formData.dayPlans.forEach((plan, idx) => {
      if (!grouped[plan.dayOfWeek]) {
        grouped[plan.dayOfWeek] = { plans: [] };
      }
      grouped[plan.dayOfWeek].plans.push({ ...plan, originalIndex: idx });
    });
    return grouped;
  }, [formData.dayPlans]);

  // Total planned summary
  const totalQuantity = formData.dayPlans.reduce((s, p) => s + p.quantity, 0);
  const totalBiomass = formData.dayPlans.reduce((s, p) => s + p.biomassKg, 0);

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-700">
          Planned Slaughters - {getWeekLabel(formData.weekNumber, formData.year)}
        </h4>
        <p className="text-xs text-gray-500">
          Schedule harvests by day of week (planlagteLokaliteter)
        </p>
      </div>

      {/* Summary */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-sm text-blue-800">Total Planned Fish</span>
            <div className="text-2xl font-bold text-blue-700">{formatNumber(totalQuantity)}</div>
          </div>
          <div>
            <span className="text-sm text-blue-800">Total Planned Biomass</span>
            <div className="text-2xl font-bold text-blue-700">{formatWeight(totalBiomass)}</div>
          </div>
        </div>
      </div>

      {/* Day-by-day grid */}
      <div className="space-y-2">
        {DAY_LABELS.map((dayLabel, dayIndex) => {
          const dayEntries = dayPlansGrouped[dayIndex]?.plans || [];
          const dayDate = dayDates[dayIndex];

          return (
            <div key={dayIndex} className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700">{dayLabel}</span>
                  <span className="text-xs text-gray-400">{dayDate}</span>
                  {dayEntries.length > 0 && (
                    <span className="px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">
                      {dayEntries.length} {dayEntries.length === 1 ? 'entry' : 'entries'}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => addDayPlan(dayIndex)}
                  className="px-2 py-1 text-xs text-blue-600 border border-blue-300 rounded hover:bg-blue-50"
                >
                  + Add
                </button>
              </div>

              {dayEntries.map((entry) => (
                <div
                  key={entry.originalIndex}
                  className="bg-white border border-gray-100 rounded p-2 mt-2"
                >
                  <div className="flex items-start justify-between mb-2">
                    <span className="text-xs text-gray-400">Entry</span>
                    <button
                      type="button"
                      onClick={() => removeDayPlan(entry.originalIndex)}
                      className="text-red-400 hover:text-red-600"
                    >
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="md:col-span-2">
                      <label className="block text-xs text-gray-500 mb-1">Batch</label>
                      <select
                        value={entry.batchId}
                        onChange={(e) => handleBatchSelect(entry.originalIndex, e.target.value)}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      >
                        <option value="">Select batch...</option>
                        {batchOptions.map((b) => (
                          <option key={b.batchId} value={b.batchId}>
                            {b.batchNumber} - {b.species} ({formatNumber(b.quantity)} pcs,{' '}
                            {b.tankName})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        Species (artskode: {entry.artskode || '-'})
                      </label>
                      <input
                        type="text"
                        value={entry.species}
                        onChange={(e) =>
                          updateDayPlan(entry.originalIndex, { species: e.target.value })
                        }
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md bg-gray-50"
                        placeholder="Auto from batch"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Quantity (antall)</label>
                      <input
                        type="number"
                        min="0"
                        value={entry.quantity || ''}
                        onChange={(e) =>
                          updateDayPlan(entry.originalIndex, {
                            quantity: parseInt(e.target.value) || 0,
                          })
                        }
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                        placeholder="0"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">
                        Biomass kg (mengdeKg)
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={entry.biomassKg || ''}
                        onChange={(e) =>
                          updateDayPlan(entry.originalIndex, {
                            biomassKg: parseFloat(e.target.value) || 0,
                          })
                        }
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                        placeholder="0"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ============================================================================
// Completed Slaughter Step (with Batch Selection + Quality Grade Distribution)
// ============================================================================

interface CompletedSlaughterStepProps {
  formData: SlaughterFormData;
  onChange: (data: Partial<SlaughterFormData>) => void;
  batchOptions: BatchOption[];
}

const CompletedSlaughterStep: React.FC<CompletedSlaughterStepProps> = ({
  formData,
  onChange,
  batchOptions,
}) => {
  const addCompleted = () => {
    const newRecord: CompletedSlaughter = {
      recordId: `harv-${Date.now()}`,
      batchId: '',
      batchNumber: '',
      speciesName: '',
      harvestDate: new Date(),
      actualQuantity: 0,
      actualBiomassKg: 0,
      avgWeightKg: 0,
      slaughterHouse: formData.facility.facilityName || '',
    };
    const completedSlaughters = [...formData.completedSlaughters, newRecord];
    onChange({
      completedSlaughters,
      summary: calculateSummary(formData.plannedSlaughters, completedSlaughters, formData.dayPlans),
    });
  };

  const handleBatchSelectCompleted = (index: number, batchId: string) => {
    const batch = batchOptions.find((b) => b.batchId === batchId);
    if (batch) {
      updateCompleted(index, {
        batchId: batch.batchId,
        batchNumber: batch.batchNumber,
        speciesName: batch.species,
        actualQuantity: batch.quantity,
        actualBiomassKg: batch.biomassKg,
        avgWeightKg: batch.quantity > 0 ? batch.biomassKg / batch.quantity : 0,
      });
    }
  };

  const updateCompleted = (index: number, updates: Partial<CompletedSlaughter>) => {
    const completedSlaughters = formData.completedSlaughters.map((c, i) => {
      if (i !== index) return c;
      const updated = { ...c, ...updates };
      // Auto-calculate avg weight
      if (updated.actualQuantity > 0 && updated.actualBiomassKg > 0) {
        updated.avgWeightKg = updated.actualBiomassKg / updated.actualQuantity;
      }
      return updated;
    });
    onChange({
      completedSlaughters,
      summary: calculateSummary(formData.plannedSlaughters, completedSlaughters, formData.dayPlans),
    });
  };

  const removeCompleted = (index: number) => {
    const completedSlaughters = formData.completedSlaughters.filter((_, i) => i !== index);
    onChange({
      completedSlaughters,
      summary: calculateSummary(formData.plannedSlaughters, completedSlaughters, formData.dayPlans),
    });
  };

  // Grade distribution handlers
  const gradeSum =
    formData.gradeDistribution.superior +
    formData.gradeDistribution.ordinary +
    formData.gradeDistribution.production +
    formData.gradeDistribution.discard;
  const gradeValid = gradeSum === 100 || gradeSum === 0;

  const updateGrade = (grade: keyof QualityGradeDistribution, value: number) => {
    onChange({
      gradeDistribution: {
        ...formData.gradeDistribution,
        [grade]: Math.max(0, Math.min(100, value)),
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700">Executed Slaughters</h4>
          <p className="text-xs text-gray-500">Record actual harvest results for the week</p>
        </div>
        <button
          type="button"
          onClick={addCompleted}
          className="px-3 py-1.5 text-sm text-green-600 border border-green-300 rounded-md hover:bg-green-50"
        >
          + Add Completed
        </button>
      </div>

      {/* Summary */}
      <div className="bg-green-50 border border-green-200 rounded-lg p-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-sm text-green-800">Total Harvested Fish</span>
            <div className="text-2xl font-bold text-green-700">
              {formatNumber(formData.summary.totalCompleted)}
            </div>
          </div>
          <div>
            <span className="text-sm text-green-800">Total Harvested Biomass</span>
            <div className="text-2xl font-bold text-green-700">
              {formatWeight(formData.summary.completedBiomassKg)}
            </div>
          </div>
        </div>
      </div>

      {formData.completedSlaughters.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <svg
            className="w-12 h-12 mx-auto text-gray-300"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No completed slaughters</p>
          <p className="text-xs text-gray-400">Click "Add Completed" to record a harvest</p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.completedSlaughters.map((record, index) => (
            <div key={record.recordId} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm font-medium text-gray-700">Harvest #{index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeCompleted(index)}
                  className="text-red-500 hover:text-red-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {/* Batch Selection Dropdown */}
                <div className="md:col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">
                    Batch (select to auto-fill)
                  </label>
                  <select
                    value={record.batchId}
                    onChange={(e) => handleBatchSelectCompleted(index, e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  >
                    <option value="">Select batch...</option>
                    {batchOptions.map((b) => (
                      <option key={b.batchId} value={b.batchId}>
                        {b.batchNumber} - {b.species} ({formatNumber(b.quantity)} pcs,{' '}
                        {formatWeight(b.biomassKg)}, {b.tankName})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Species</label>
                  <input
                    type="text"
                    value={record.speciesName || ''}
                    onChange={(e) => updateCompleted(index, { speciesName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md bg-gray-50"
                    placeholder="Auto from batch"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Harvest Date</label>
                  <input
                    type="date"
                    value={record.harvestDate.toISOString().split('T')[0]}
                    onChange={(e) =>
                      updateCompleted(index, { harvestDate: new Date(e.target.value) })
                    }
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Actual Quantity</label>
                  <input
                    type="number"
                    min="0"
                    value={record.actualQuantity || ''}
                    onChange={(e) =>
                      updateCompleted(index, { actualQuantity: parseInt(e.target.value) || 0 })
                    }
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Actual Biomass (kg)</label>
                  <input
                    type="number"
                    min="0"
                    value={record.actualBiomassKg || ''}
                    onChange={(e) =>
                      updateCompleted(index, { actualBiomassKg: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Avg Weight (kg)</label>
                  <input
                    type="text"
                    value={record.avgWeightKg.toFixed(2)}
                    disabled
                    className="w-full px-2 py-1.5 text-sm bg-gray-100 border border-gray-300 rounded-md text-gray-600"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Lot Number</label>
                  <input
                    type="text"
                    value={record.lotNumber || ''}
                    onChange={(e) => updateCompleted(index, { lotNumber: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="LOT-2026-001"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Quality Grade Distribution */}
      {formData.completedSlaughters.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mt-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h5 className="text-sm font-medium text-gray-700">
                Quality Grade Distribution (kvalitetsgrad)
              </h5>
              <p className="text-xs text-gray-500">
                Percentage breakdown across grades - must sum to 100%
              </p>
            </div>
            <span
              className={`px-2 py-0.5 text-xs font-medium rounded ${
                gradeValid ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              }`}
            >
              {gradeSum}% / 100%
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Superior (Superioer)</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={formData.gradeDistribution.superior || ''}
                  onChange={(e) => updateGrade('superior', parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Ordinary (Ordinaer)</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={formData.gradeDistribution.ordinary || ''}
                  onChange={(e) => updateGrade('ordinary', parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Production (Produksjonsfisk)
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={formData.gradeDistribution.production || ''}
                  onChange={(e) => updateGrade('production', parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Discard (Kassert)</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={formData.gradeDistribution.discard || ''}
                  onChange={(e) => updateGrade('discard', parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
            </div>
          </div>
          {!gradeValid && gradeSum > 0 && (
            <p className="text-xs text-red-600 mt-2">
              Grade percentages must sum to exactly 100% (currently {gradeSum}%)
            </p>
          )}
          {/* Visual bar */}
          {gradeSum > 0 && (
            <div className="flex h-4 rounded-full overflow-hidden mt-3 bg-gray-100">
              {formData.gradeDistribution.superior > 0 && (
                <div
                  className="bg-green-500 transition-all"
                  style={{ width: `${(formData.gradeDistribution.superior / gradeSum) * 100}%` }}
                  title={`Superior: ${formData.gradeDistribution.superior}%`}
                />
              )}
              {formData.gradeDistribution.ordinary > 0 && (
                <div
                  className="bg-blue-500 transition-all"
                  style={{ width: `${(formData.gradeDistribution.ordinary / gradeSum) * 100}%` }}
                  title={`Ordinary: ${formData.gradeDistribution.ordinary}%`}
                />
              )}
              {formData.gradeDistribution.production > 0 && (
                <div
                  className="bg-yellow-500 transition-all"
                  style={{ width: `${(formData.gradeDistribution.production / gradeSum) * 100}%` }}
                  title={`Production: ${formData.gradeDistribution.production}%`}
                />
              )}
              {formData.gradeDistribution.discard > 0 && (
                <div
                  className="bg-red-500 transition-all"
                  style={{ width: `${(formData.gradeDistribution.discard / gradeSum) * 100}%` }}
                  title={`Discard: ${formData.gradeDistribution.discard}%`}
                />
              )}
            </div>
          )}
          {gradeSum > 0 && (
            <div className="flex gap-4 mt-2 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Superior
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> Ordinary
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" /> Production
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Discard
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Review Step
// ============================================================================

interface ReviewStepProps {
  formData: SlaughterFormData;
  siteName: string;
}

const ReviewStep: React.FC<ReviewStepProps> = ({ formData, siteName }) => {
  const variance =
    formData.summary.totalPlanned > 0
      ? ((formData.summary.totalCompleted - formData.summary.totalPlanned) /
          formData.summary.totalPlanned) *
        100
      : 0;

  const weekLabel = getWeekLabel(formData.weekNumber, formData.year);
  const gradeSum =
    formData.gradeDistribution.superior +
    formData.gradeDistribution.ordinary +
    formData.gradeDistribution.production +
    formData.gradeDistribution.discard;

  return (
    <div className="space-y-6">
      {/* Regulatory Metadata */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-yellow-800 mb-2">
          Regulatory Metadata (Mattilsynet)
        </h4>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-gray-500">Org. Number:</span>
            <span className="ml-1 font-medium text-gray-900">
              {formData.regulatory.organisasjonsnummer || '-'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Site Number:</span>
            <span className="ml-1 font-medium text-gray-900">
              {formData.regulatory.lokalitetsnummer || '-'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Contact:</span>
            <span className="ml-1 font-medium text-gray-900">
              {formData.regulatory.kontaktperson.navn || '-'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Email:</span>
            <span className="ml-1 font-medium text-gray-900">
              {formData.regulatory.kontaktperson.epost || '-'}
            </span>
          </div>
        </div>
      </div>

      {/* Summary Header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-blue-800">Report Summary</h4>
        <p className="text-sm text-blue-600 mt-1">{siteName}</p>
        <p className="text-sm text-blue-700 font-medium mt-1">{weekLabel}</p>
        <span
          className={`inline-block mt-2 px-2 py-0.5 text-xs font-medium rounded ${
            formData.reportType === 'planned'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-green-100 text-green-700'
          }`}
        >
          {formData.reportType === 'planned'
            ? 'Planned Slaughter (Planlagt Slakt)'
            : 'Executed Slaughter (Utfort Slakt)'}
        </span>
      </div>

      {/* Slaughter Facility */}
      <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
        <h5 className="text-xs font-medium text-purple-800 uppercase mb-2">Slaughter Facility</h5>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-gray-500">Facility Name:</span>
            <span className="ml-1 font-medium text-gray-900">
              {formData.facility.facilityName || '-'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Approval No.:</span>
            <span className="ml-1 font-medium text-gray-900">
              {formData.facility.approvalNumber || '-'}
            </span>
          </div>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">
            {formatNumber(formData.summary.totalPlanned)}
          </div>
          <div className="text-xs text-gray-500">Planned Fish</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">
            {formatWeight(formData.summary.plannedBiomassKg)}
          </div>
          <div className="text-xs text-gray-500">Planned Biomass</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-green-600">
            {formatNumber(formData.summary.totalCompleted)}
          </div>
          <div className="text-xs text-gray-500">Completed Fish</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-green-600">
            {formatWeight(formData.summary.completedBiomassKg)}
          </div>
          <div className="text-xs text-gray-500">Completed Biomass</div>
        </div>
      </div>

      {/* Variance */}
      {formData.summary.totalPlanned > 0 && formData.summary.totalCompleted > 0 && (
        <div
          className={`rounded-lg p-4 ${variance >= 0 ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}
        >
          <div className="flex items-center justify-between">
            <span
              className={`text-sm font-medium ${variance >= 0 ? 'text-green-800' : 'text-red-800'}`}
            >
              Plan vs Actual Variance
            </span>
            <span
              className={`text-xl font-bold ${variance >= 0 ? 'text-green-700' : 'text-red-700'}`}
            >
              {variance > 0 ? '+' : ''}
              {variance.toFixed(1)}%
            </span>
          </div>
        </div>
      )}

      {/* Planned Day Plans */}
      {formData.dayPlans.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">
            Planned Slaughters by Day ({formData.dayPlans.length} entries)
          </h5>
          <div className="space-y-2">
            {formData.dayPlans.map((p, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">
                  {p.dayLabel} ({p.dateStr}) - {p.batchNumber || 'No batch'} -{' '}
                  {p.species || 'No species'}
                </span>
                <div className="text-right">
                  <span className="font-medium text-gray-900">{formatNumber(p.quantity)}</span>
                  <span className="text-gray-500 ml-2">({formatWeight(p.biomassKg)})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Legacy Planned Slaughters */}
      {formData.plannedSlaughters.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">
            Planned Slaughters ({formData.plannedSlaughters.length})
          </h5>
          <div className="space-y-2">
            {formData.plannedSlaughters.map((p, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">
                  {p.batchNumber} - {formatDate(p.plannedDate)}
                </span>
                <div className="text-right">
                  <span className="font-medium text-gray-900">
                    {formatNumber(p.estimatedQuantity)}
                  </span>
                  <span className="text-gray-500 ml-2">({formatWeight(p.estimatedBiomassKg)})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Completed Slaughters */}
      {formData.completedSlaughters.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">
            Executed Slaughters ({formData.completedSlaughters.length})
          </h5>
          <div className="space-y-2">
            {formData.completedSlaughters.map((c, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">
                  {c.batchNumber} - {formatDate(c.harvestDate)}
                  {c.speciesName && (
                    <span className="ml-2 px-1.5 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">
                      {c.speciesName}
                    </span>
                  )}
                </span>
                <div className="text-right">
                  <span className="font-medium text-gray-900">
                    {formatNumber(c.actualQuantity)}
                  </span>
                  <span className="text-gray-500 ml-2">({formatWeight(c.actualBiomassKg)})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quality Grade Distribution */}
      {gradeSum > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">
            Quality Grade Distribution
          </h5>
          <div className="grid grid-cols-4 gap-3">
            <div className="text-center p-2 bg-green-50 rounded">
              <div className="text-lg font-bold text-green-700">
                {formData.gradeDistribution.superior}%
              </div>
              <div className="text-xs text-gray-500">Superior</div>
            </div>
            <div className="text-center p-2 bg-blue-50 rounded">
              <div className="text-lg font-bold text-blue-700">
                {formData.gradeDistribution.ordinary}%
              </div>
              <div className="text-xs text-gray-500">Ordinary</div>
            </div>
            <div className="text-center p-2 bg-yellow-50 rounded">
              <div className="text-lg font-bold text-yellow-700">
                {formData.gradeDistribution.production}%
              </div>
              <div className="text-xs text-gray-500">Production</div>
            </div>
            <div className="text-center p-2 bg-red-50 rounded">
              <div className="text-lg font-bold text-red-700">
                {formData.gradeDistribution.discard}%
              </div>
              <div className="text-xs text-gray-500">Discard</div>
            </div>
          </div>
          {/* Visual bar */}
          <div className="flex h-3 rounded-full overflow-hidden mt-3 bg-gray-100">
            {formData.gradeDistribution.superior > 0 && (
              <div
                className="bg-green-500"
                style={{ width: `${formData.gradeDistribution.superior}%` }}
              />
            )}
            {formData.gradeDistribution.ordinary > 0 && (
              <div
                className="bg-blue-500"
                style={{ width: `${formData.gradeDistribution.ordinary}%` }}
              />
            )}
            {formData.gradeDistribution.production > 0 && (
              <div
                className="bg-yellow-500"
                style={{ width: `${formData.gradeDistribution.production}%` }}
              />
            )}
            {formData.gradeDistribution.discard > 0 && (
              <div
                className="bg-red-500"
                style={{ width: `${formData.gradeDistribution.discard}%` }}
              />
            )}
          </div>
        </div>
      )}

      {/* Submission Notice */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <p className="text-sm text-gray-600">
          By submitting this report, you confirm that the data is accurate and complete. This report
          will be submitted to Mattilsynet via the slakt API.
        </p>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const SlaughterReportTab: React.FC<SlaughterReportTabProps> = ({ siteId }) => {
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [formData, setFormData] = useState<SlaughterFormData>(getInitialFormData());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch tanks for batch auto-populate
  const { data: tanksData } = useTanksList();
  const batchOptions = useMemo(() => extractBatchOptions(tanksData?.items), [tanksData]);

  // Regulatory settings & submit mutations
  const { data: regulatorySettings } = useRegulatorySettings();
  const submitPlannedMutation = useSubmitPlannedSlaughterReport();
  const clientRef = useStableClientReference();
  const [submissionResult, setSubmissionResult] = useState<ReportSubmissionResult | null>(null);

  // Form handlers
  const handleFormChange = useCallback((updates: Partial<SlaughterFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleOpenWizard = useCallback(() => {
    setFormData(getInitialFormData());
    setIsWizardOpen(true);
  }, []);

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);
    setSubmissionResult(null);
    try {
      const siteMapping = regulatorySettings?.siteLocalityMappings?.find(
        (m) => m.siteId === siteId,
      );
      const orgNr =
        formData.regulatory.organisasjonsnummer || regulatorySettings?.organisationNumber || '';
      const lokNr =
        (typeof formData.regulatory.lokalitetsnummer === 'number'
          ? formData.regulatory.lokalitetsnummer
          : 0) ||
        siteMapping?.lokalitetsnummer ||
        0;
      const kontakt = {
        navn:
          formData.regulatory.kontaktperson.navn || regulatorySettings?.defaultContactName || '',
        epost:
          formData.regulatory.kontaktperson.epost || regulatorySettings?.defaultContactEmail || '',
        telefonnummer:
          formData.regulatory.kontaktperson.telefonnummer ||
          regulatorySettings?.defaultContactPhone ||
          '',
      };

      if (formData.reportType === 'planned') {
        // Group day plans by artskode for UkeplanPerArt
        const artskodeSet = new Set(formData.dayPlans.map((d) => d.artskode || 'SAL'));
        const ukeplanPerArt = Array.from(artskodeSet).map((artskode) => {
          const artPlans = formData.dayPlans.filter((d) => (d.artskode || 'SAL') === artskode);
          return {
            artskode,
            mandagKg: artPlans.find((d) => d.dayOfWeek === 0)?.biomassKg,
            tirsdagKg: artPlans.find((d) => d.dayOfWeek === 1)?.biomassKg,
            onsdagKg: artPlans.find((d) => d.dayOfWeek === 2)?.biomassKg,
            torsdagKg: artPlans.find((d) => d.dayOfWeek === 3)?.biomassKg,
            fredagKg: artPlans.find((d) => d.dayOfWeek === 4)?.biomassKg,
            lordagKg: artPlans.find((d) => d.dayOfWeek === 5)?.biomassKg,
            sondagKg: artPlans.find((d) => d.dayOfWeek === 6)?.biomassKg,
          };
        });

        const plannedInput: SubmitPlannedSlaughterInput = {
          klientReferanse: clientRef.get(),
          organisasjonsnummer: orgNr,
          lokalitetsnummer: lokNr,
          kontaktperson: kontakt,
          uke: formData.weekNumber,
          aar: formData.year,
          godkjenningsnummer: formData.facility.approvalNumber,
          planlagteLokaliteter: [
            {
              organisasjonsnummer: orgNr,
              lokalitetsnummer: lokNr,
              ukeplanPerArt,
            },
          ],
        };
        const result = await submitPlannedMutation.mutateAsync(plannedInput);
        setSubmissionResult(result);
        if (!result.success) {
          setError(result.feilmelding || 'Planned slaughter submission failed');
          setIsSubmitting(false);
          return;
        }
      }

      if (formData.reportType === 'completed') {
        // FARM-CRITICAL: executed slaughter is filed from harvest records
        // (per-species gutted kg) via the records-based "Scheduled reports due"
        // review-and-approve draft. This manual grade-percentage form cannot
        // produce a correct per-species absolute-kg filing — it has no species
        // breakdown and its grade values are PERCENTAGES — so it must NEVER submit
        // fabricated figures (percentages-as-kg under a hard-coded species) to
        // Mattilsynet. Fail closed and route the operator to the correct path.
        setError(
          'Executed slaughter is now filed from harvest records. Open “Scheduled reports due” ' +
            'above to review and submit the assembled weekly report — this manual form no longer ' +
            'submits executed slaughter because it cannot compute per-species gutted weights.',
        );
        setIsSubmitting(false);
        return;
      }

      // FARM-HIGH-126: rotate the stable client reference only on success.
      clientRef.reset();
      setIsWizardOpen(false);
      setFormData(getInitialFormData());
    } catch (err) {
      console.error('Slaughter report submission error:', err);
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, regulatorySettings, siteId, clientRef, submitPlannedMutation]);

  // Wizard steps
  const steps: ReportWizardStep[] = useMemo(
    () => [
      {
        id: 'type',
        title: 'Report Type',
        description: 'Week & type',
        content: (
          <ReportTypeStep
            formData={formData}
            onChange={handleFormChange}
            siteName={'Default Site'}
          />
        ),
      },
      {
        id: 'facility',
        title: 'Facility & Metadata',
        description: 'Regulatory info',
        content: <FacilityStep formData={formData} onChange={handleFormChange} />,
      },
      {
        id: 'planned',
        title: 'Planned',
        description: 'Day-by-day schedule',
        content: (
          <PlannedSlaughterStep
            formData={formData}
            onChange={handleFormChange}
            batchOptions={batchOptions}
          />
        ),
        optional: formData.reportType === 'completed',
      },
      {
        id: 'completed',
        title: 'Executed',
        description: 'Actual harvests',
        content: (
          <CompletedSlaughterStep
            formData={formData}
            onChange={handleFormChange}
            batchOptions={batchOptions}
          />
        ),
        optional: formData.reportType === 'planned',
      },
      {
        id: 'review',
        title: 'Review',
        description: 'Verify and submit',
        content: <ReviewStep formData={formData} siteName={'Default Site'} />,
      },
    ],
    [formData, handleFormChange, batchOptions],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Slaughter Reports</h2>
          <p className="text-sm text-gray-500">
            Weekly planned and executed harvest reports (Mattilsynet slakt)
          </p>
        </div>
        <button
          onClick={() => handleOpenWizard()}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Report
        </button>
      </div>

      {/* Submission History */}
      <SubmissionHistorySection
        reportType="SLAUGHTER_PLANNED"
        title="Planned Slaughter Submissions"
        siteId={siteId}
      />
      <SubmissionHistorySection
        reportType="SLAUGHTER_EXECUTED"
        title="Executed Slaughter Submissions"
        siteId={siteId}
      />

      {/* Wizard Modal */}
      <ReportWizard
        isOpen={isWizardOpen}
        onClose={() => {
          setIsWizardOpen(false);
          setFormData(getInitialFormData());
        }}
        onSubmit={handleSubmit}
        title="Slaughter Report"
        subtitle={
          formData.reportType === 'planned'
            ? `Planlagt Slakt - ${getWeekLabel(formData.weekNumber, formData.year)}`
            : `Utfort Slakt - ${getWeekLabel(formData.weekNumber, formData.year)}`
        }
        steps={steps}
        isSubmitting={isSubmitting}
        error={error}
        onClearError={() => setError(null)}
        submitButtonText="Submit Report"
        maxWidth="max-w-4xl"
      />
    </div>
  );
};

export default SlaughterReportTab;
