/**
 * Biomass Report Tab
 * Monthly biomass reports for Fiskeridirektoratet
 * Due 7th of each month
 */
import React, { useState, useMemo, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';
import { useRegulatorySettings } from '../../../hooks/useRegulatory';
import {
  useBiomassReport,
  useBiomassReports,
  useInvalidateBiomassReports,
  isTerminalBiomassStatus,
  BiomassReportPayload,
  BiomassReportStatusValue,
} from '../../../hooks/useBiomassReports';
import { BiomassSpeciesBreakdown } from '../types/reports.types';
import { ReportWizard, ReportWizardStep } from '../components/wizard/ReportWizard';
import { useReportPrefill, findFieldMeta, ReportPrefill } from '../../../hooks/useReportPrefill';
import { ProvenanceBadge } from '../components/common';
import { BiomassAltinnPanel } from '../components/BiomassAltinnPanel';
import { CREATE_BIOMASS_REPORT_MUTATION } from '../../../graphql/regulatory.operations';

// ============================================================================
// Types
// ============================================================================

interface BiomassReportTabProps {
  siteId?: string;
}

interface StockingFormRecord {
  id: string;
  date: string;
  speciesName: string;
  quantity: number;
  avgWeightG: number;
  supplier: string;
  batchNumber: string;
}

/**
 * Form-shaped mortality detail record. The canonical `MortalityDetail` from
 * `reports.types.ts` is the SHAPE the backend regulatory mutation expects
 * (count + cause + biomassKg). The form additionally collects `speciesName`
 * (mapped to `speciesCode` in the submission payload) and a separate
 * `biomassLossKg` field that's distinct from the canonical `biomassKg`
 * (the latter is "current biomass at this date", the former is the
 * delta lost). Mirrors the StockingFormRecord/TransferFormRecord pattern
 * already in this file — a form-shaped local type is cleaner than
 * polluting the canonical types with form-only fields.
 */
interface MortalityFormDetail {
  id: string;
  date: string;
  cause: string;
  speciesName: string;
  count: number;
  biomassLossKg?: number;
  notes?: string;
}

interface SlaughterFormRecord {
  id: string;
  date: string;
  speciesName: string;
  quantity: number;
  biomassKg: number;
  buyer?: string;
  notes?: string;
}

interface TransferFormRecord {
  id: string;
  direction: 'incoming' | 'outgoing';
  date: string;
  speciesName: string;
  quantity: number;
  biomassKg: number;
  fromToSite: string;
  batchNumber: string;
  reason: string;
}

export interface BiomassFormData {
  month: number;
  year: number;
  currentBiomass: {
    totalKg: number;
    bySpecies: BiomassSpeciesBreakdown[];
  };
  stockings: StockingFormRecord[];
  mortality: {
    totalCount: number;
    byCause: { cause: string; count: number }[];
    details: MortalityFormDetail[];
  };
  slaughter: {
    totalQuantity: number;
    totalBiomassKg: number;
    records: SlaughterFormRecord[];
  };
  transfers: TransferFormRecord[];
  feedConsumption: {
    totalKg: number;
    byFeedType: { feedName: string; brandName?: string; quantityKg: number }[];
  };
  biomassLoadedFromSystem: boolean;
  feedLoadedFromSystem: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const MORTALITY_CAUSES = [
  'Disease',
  'Water Quality',
  'Stress',
  'Handling',
  'Predation',
  'Cannibalism',
  'Starvation',
  'Temperature',
  'Oxygen',
  'Ammonia',
  'Genetic',
  'Unknown',
  'Other',
];

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

function getMonthLabel(month: number, year: number): string {
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${monthNames[month]} ${year}`;
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

/**
 * Map an internal mortality-cause value ('water_quality') to the Title Case
 * label the form's cause grid uses ('Water Quality'). Idempotent for values
 * that are already labels, so persisted drafts and server prefill share one
 * mapper.
 */
function causeLabel(cause: string): string {
  return cause
    .split(/[_\s]+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(' ');
}

function getInitialFormData(): BiomassFormData {
  const now = new Date();
  const prevMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  return {
    month: prevMonth,
    year,
    currentBiomass: { totalKg: 0, bySpecies: [] },
    stockings: [],
    mortality: { totalCount: 0, byCause: [], details: [] },
    slaughter: { totalQuantity: 0, totalBiomassKg: 0, records: [] },
    transfers: [],
    feedConsumption: { totalKg: 0, byFeedType: [] },
    biomassLoadedFromSystem: false,
    feedLoadedFromSystem: false,
  };
}

/**
 * Reverse of the submit mapping: hydrate the wizard form from a persisted
 * report payload so returning to a drafted month pre-fills instead of starting
 * blank (which would silently overwrite the DRAFT on submit). `month` is the
 * 0-indexed JS month (the form convention); the persisted `reportMonth` is
 * 1–12, so the caller subtracts one. Record `id`s are regenerated because the
 * payload does not persist the form-only row identity — this runs on wizard
 * open (an event handler), never in render, so fresh ids are safe.
 */
export function hydrateFormFromPayload(
  payload: BiomassReportPayload,
  month: number,
  year: number,
): BiomassFormData {
  return {
    month,
    year,
    currentBiomass: {
      totalKg: payload.currentBiomass.totalKg,
      bySpecies: payload.currentBiomass.bySpecies.map((s) => ({
        speciesId: s.speciesId,
        speciesName: s.speciesName,
        fishCount: s.fishCount,
        biomassKg: s.biomassKg,
        avgWeightG: s.avgWeightG,
      })),
    },
    stockings: payload.stockings.map((r) => ({
      id: crypto.randomUUID(),
      date: r.date,
      speciesName: r.speciesCode,
      quantity: r.fishCount,
      avgWeightG: r.avgWeightG,
      supplier: r.supplier ?? '',
      batchNumber: r.notes ?? '',
    })),
    mortality: {
      totalCount: payload.mortality.totalCount,
      byCause: payload.mortality.byCause.map((c) => ({
        cause: causeLabel(c.cause),
        count: c.count,
      })),
      details: payload.mortality.details.map((d) => ({
        id: crypto.randomUUID(),
        date: d.date,
        cause: causeLabel(d.cause),
        speciesName: d.speciesCode,
        count: d.count,
        biomassLossKg: d.biomassLossKg ?? undefined,
        notes: d.notes ?? undefined,
      })),
    },
    slaughter: {
      totalQuantity: payload.slaughter.totalQuantity,
      totalBiomassKg: payload.slaughter.totalBiomassKg,
      records: payload.slaughter.records.map((r) => ({
        id: crypto.randomUUID(),
        date: r.date,
        speciesName: r.speciesCode,
        quantity: r.quantity,
        biomassKg: r.biomassKg,
        buyer: r.buyer ?? undefined,
        notes: r.notes ?? undefined,
      })),
    },
    transfers: payload.transfers.map((t) => ({
      id: crypto.randomUUID(),
      direction: t.direction === 'IN' ? 'incoming' : 'outgoing',
      date: t.date,
      speciesName: t.speciesCode,
      quantity: t.fishCount,
      biomassKg: t.biomassKg,
      fromToSite: t.counterparty ?? '',
      batchNumber: '',
      reason: t.notes ?? '',
    })),
    feedConsumption: {
      totalKg: payload.feedConsumption.totalKg,
      byFeedType: payload.feedConsumption.byFeedType.map((f) => ({
        feedName: f.feedName,
        brandName: f.brandName ?? undefined,
        quantityKg: f.quantityKg,
      })),
    },
    // The saved draft is the source of truth here, not a fresh system pull —
    // leave the "auto-populated from tanks" banners off.
    biomassLoadedFromSystem: false,
    feedLoadedFromSystem: false,
  };
}

/** Renders the provenance badge governing a draft-payload section, if any. */
const SectionProvenance: React.FC<{
  prefill?: ReportPrefill<BiomassReportPayload>;
  path: string;
}> = ({ prefill, path }) => {
  const meta = prefill ? findFieldMeta(prefill.fields, path) : undefined;
  return meta ? <ProvenanceBadge meta={meta} /> : null;
};

// ============================================================================
// Wizard Step Components
// ============================================================================

interface BasicInfoStepProps {
  formData: BiomassFormData;
  onChange: (data: Partial<BiomassFormData>) => void;
  siteName: string;
}

const BasicInfoStep: React.FC<BasicInfoStepProps> = ({ formData, onChange, siteName }) => (
  <div className="space-y-4">
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Site</label>
        <input
          type="text"
          value={siteName}
          disabled
          className="w-full px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-gray-700"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Report Period</label>
        <input
          type="text"
          value={getMonthLabel(formData.month, formData.year)}
          disabled
          className="w-full px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-gray-700"
        />
      </div>
    </div>
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
      <h4 className="text-sm font-medium text-blue-800">Report Contents</h4>
      <p className="text-sm text-blue-600 mt-1">
        This report includes biomass, stocking records, mortality, harvests, transfers, and feed
        consumption for the reporting period.
      </p>
      <ul className="mt-3 space-y-1 text-sm text-blue-700">
        <li className="flex items-center">
          <svg
            className="w-4 h-4 mr-2 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Current biomass by species
        </li>
        <li className="flex items-center">
          <svg
            className="w-4 h-4 mr-2 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Stocking records (fish arrivals)
        </li>
        <li className="flex items-center">
          <svg
            className="w-4 h-4 mr-2 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Mortality by cause
        </li>
        <li className="flex items-center">
          <svg
            className="w-4 h-4 mr-2 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Slaughter/harvest records
        </li>
        <li className="flex items-center">
          <svg
            className="w-4 h-4 mr-2 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Feed consumption
        </li>
        <li className="flex items-center">
          <svg
            className="w-4 h-4 mr-2 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Transfers in/out
        </li>
      </ul>
    </div>
  </div>
);

// ---------- Biomass Step ----------

interface BiomassStepProps {
  formData: BiomassFormData;
  onChange: (data: Partial<BiomassFormData>) => void;
  prefill?: ReportPrefill<BiomassReportPayload>;
}

export const BiomassStep: React.FC<BiomassStepProps> = ({ formData, onChange, prefill }) => {
  // Standing stock assembled from batch/tank records (BiomassCalculatorService)
  // is the SSoT — the per-species rows render read-only (corrections go to the
  // batch/tank records, not the report). hydrateFormFromPayload already seeded
  // the rows on wizard open.
  const biomassMeta = prefill ? findFieldMeta(prefill.fields, '/currentBiomass') : undefined;
  const biomassFromRecords = biomassMeta?.provenance === 'RECORDS';

  const handleLoadFromSystem = () => {
    if (!prefill) return;
    const { currentBiomass } = prefill.draftPayload;
    if (currentBiomass.bySpecies.length === 0) return;

    onChange({
      currentBiomass: {
        bySpecies: currentBiomass.bySpecies.map((entry) => ({ ...entry })),
        totalKg: currentBiomass.totalKg,
      },
      biomassLoadedFromSystem: true,
    });
  };

  const addSpecies = () => {
    const newSpecies: BiomassSpeciesBreakdown = {
      speciesId: `sp-${Date.now()}`,
      speciesName: '',
      fishCount: 0,
      biomassKg: 0,
      avgWeightG: 0,
    };
    const bySpecies = [...formData.currentBiomass.bySpecies, newSpecies];
    onChange({
      currentBiomass: {
        ...formData.currentBiomass,
        bySpecies,
        totalKg: bySpecies.reduce((sum, s) => sum + s.biomassKg, 0),
      },
    });
  };

  const updateSpecies = (index: number, updates: Partial<BiomassSpeciesBreakdown>) => {
    const bySpecies = formData.currentBiomass.bySpecies.map((s, i) => {
      if (i !== index) return s;
      const updated = { ...s, ...updates };
      // Auto-calculate average weight if count and biomass provided
      if (updated.fishCount > 0 && updated.biomassKg > 0) {
        updated.avgWeightG = (updated.biomassKg * 1000) / updated.fishCount;
      }
      return updated;
    });
    onChange({
      currentBiomass: {
        bySpecies,
        totalKg: bySpecies.reduce((sum, s) => sum + s.biomassKg, 0),
      },
    });
  };

  const removeSpecies = (index: number) => {
    const bySpecies = formData.currentBiomass.bySpecies.filter((_, i) => i !== index);
    onChange({
      currentBiomass: {
        bySpecies,
        totalKg: bySpecies.reduce((sum, s) => sum + s.biomassKg, 0),
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
            Current Biomass by Species
            <SectionProvenance prefill={prefill} path="/currentBiomass" />
          </h4>
          <p className="text-xs text-gray-500">End of month standing stock</p>
        </div>
        <div className="flex items-center gap-2">
          {prefill && !biomassFromRecords && (
            <button
              type="button"
              onClick={handleLoadFromSystem}
              className="px-3 py-1.5 text-sm text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Load from System
            </button>
          )}
          {!biomassFromRecords && (
            <button
              type="button"
              onClick={addSpecies}
              className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
            >
              + Add Species
            </button>
          )}
        </div>
      </div>

      {/* Auto-populated notice */}
      {formData.biomassLoadedFromSystem && formData.currentBiomass.bySpecies.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-2">
          <svg
            className="w-4 h-4 text-green-600 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-sm text-green-700">
            Assembled from batch and tank records.
            {biomassFromRecords
              ? ' Corrections go to the batch/tank records, not the report.'
              : ' You can adjust values manually.'}
          </span>
        </div>
      )}

      {/* Total Summary */}
      <div className="bg-green-50 border border-green-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-green-800">Total Biomass</span>
          <span className="text-2xl font-bold text-green-700">
            {formatWeight(formData.currentBiomass.totalKg)}
          </span>
        </div>
      </div>

      {formData.currentBiomass.bySpecies.length === 0 ? (
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
              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
            />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No species added</p>
          <p className="text-xs text-gray-400">
            {prefill
              ? 'Click "Load from System" to auto-populate from batch records, or "Add Species" to enter manually'
              : 'Click "Add Species" to enter biomass data'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.currentBiomass.bySpecies.map((species, index) => (
            <div
              key={species.speciesId}
              className="p-4 bg-gray-50 border border-gray-200 rounded-lg"
            >
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm font-medium text-gray-700">Species #{index + 1}</span>
                {!biomassFromRecords && (
                  <button
                    type="button"
                    onClick={() => removeSpecies(index)}
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
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="col-span-2 md:col-span-1">
                  <label className="block text-xs text-gray-500 mb-1">Species Name</label>
                  <input
                    type="text"
                    value={species.speciesName}
                    onChange={(e) => updateSpecies(index, { speciesName: e.target.value })}
                    disabled={biomassFromRecords}
                    className={`w-full px-2 py-1.5 text-sm border rounded-md ${
                      biomassFromRecords ? 'border-gray-200 bg-gray-100 text-gray-700' : 'border-gray-300'
                    }`}
                    placeholder="e.g., Atlantic Salmon"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Fish Count</label>
                  <input
                    type="number"
                    min="0"
                    value={species.fishCount || ''}
                    onChange={(e) =>
                      updateSpecies(index, { fishCount: parseInt(e.target.value) || 0 })
                    }
                    disabled={biomassFromRecords}
                    className={`w-full px-2 py-1.5 text-sm border rounded-md ${
                      biomassFromRecords ? 'border-gray-200 bg-gray-100 text-gray-700' : 'border-gray-300'
                    }`}
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Biomass (kg)</label>
                  <input
                    type="number"
                    min="0"
                    value={species.biomassKg || ''}
                    onChange={(e) =>
                      updateSpecies(index, { biomassKg: parseFloat(e.target.value) || 0 })
                    }
                    disabled={biomassFromRecords}
                    className={`w-full px-2 py-1.5 text-sm border rounded-md ${
                      biomassFromRecords ? 'border-gray-200 bg-gray-100 text-gray-700' : 'border-gray-300'
                    }`}
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Avg Weight (g)</label>
                  <input
                    type="text"
                    value={species.avgWeightG.toFixed(0)}
                    disabled
                    className="w-full px-2 py-1.5 text-sm bg-gray-100 border border-gray-300 rounded-md text-gray-600"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ---------- Stocking Records Step ----------

interface StockingStepProps {
  formData: BiomassFormData;
  onChange: (data: Partial<BiomassFormData>) => void;
  prefill?: ReportPrefill<BiomassReportPayload>;
}

export const StockingStep: React.FC<StockingStepProps> = ({ formData, onChange, prefill }) => {
  // Stockings assembled from batches_v2 (stockedAt / initialQuantity) are the
  // SSoT — the rows render read-only (corrections go to the batch records, not
  // the report). hydrateFormFromPayload already seeded them on wizard open.
  const stockingsMeta = prefill ? findFieldMeta(prefill.fields, '/stockings') : undefined;
  const stockingsFromRecords = stockingsMeta?.provenance === 'RECORDS';

  const addStockingRecord = () => {
    const newRecord: StockingFormRecord = {
      id: `stk-${Date.now()}`,
      date: '',
      speciesName: '',
      quantity: 0,
      avgWeightG: 0,
      supplier: '',
      batchNumber: '',
    };
    onChange({ stockings: [...formData.stockings, newRecord] });
  };

  const updateStockingRecord = (index: number, updates: Partial<StockingFormRecord>) => {
    const stockings = formData.stockings.map((r, i) => (i === index ? { ...r, ...updates } : r));
    onChange({ stockings });
  };

  const removeStockingRecord = (index: number) => {
    onChange({ stockings: formData.stockings.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <span>Stocking Records</span>
            <SectionProvenance prefill={prefill} path="/stockings" />
          </h4>
          <p className="text-xs text-gray-500">
            Fish arrivals during the reporting period (required by Fiskeridirektoratet)
          </p>
        </div>
        {!stockingsFromRecords && (
          <button
            type="button"
            onClick={addStockingRecord}
            className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
          >
            + Add Stocking Record
          </button>
        )}
      </div>

      {/* Summary */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-indigo-800">Total Stocked</span>
          <span className="text-2xl font-bold text-indigo-700">
            {formatNumber(formData.stockings.reduce((sum, s) => sum + s.quantity, 0))} fish
          </span>
        </div>
      </div>

      {formData.stockings.length === 0 ? (
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
              d="M12 4v16m8-8H4"
            />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No stocking records</p>
          <p className="text-xs text-gray-400">
            Click "+ Add Stocking Record" if fish were received this period
          </p>
        </div>
      ) : (
        <fieldset
          disabled={stockingsFromRecords}
          className={`space-y-3 border-0 p-0 m-0 ${stockingsFromRecords ? 'opacity-75' : ''}`}
        >
          {formData.stockings.map((record, index) => (
            <div key={record.id} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm font-medium text-gray-700">Stocking #{index + 1}</span>
                {!stockingsFromRecords && (
                  <button
                    type="button"
                    onClick={() => removeStockingRecord(index)}
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
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Date</label>
                  <input
                    type="date"
                    value={record.date}
                    onChange={(e) => updateStockingRecord(index, { date: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Species</label>
                  <input
                    type="text"
                    value={record.speciesName}
                    onChange={(e) => updateStockingRecord(index, { speciesName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g., Atlantic Salmon"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                  <input
                    type="number"
                    min="0"
                    value={record.quantity || ''}
                    onChange={(e) =>
                      updateStockingRecord(index, { quantity: parseInt(e.target.value) || 0 })
                    }
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Avg Weight (g)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={record.avgWeightG || ''}
                    onChange={(e) =>
                      updateStockingRecord(index, { avgWeightG: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Supplier</label>
                  <input
                    type="text"
                    value={record.supplier}
                    onChange={(e) => updateStockingRecord(index, { supplier: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g., SalmoBreed"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Batch Number</label>
                  <input
                    type="text"
                    value={record.batchNumber}
                    onChange={(e) => updateStockingRecord(index, { batchNumber: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g., B-2024-001"
                  />
                </div>
              </div>
            </div>
          ))}
        </fieldset>
      )}
    </div>
  );
};

// ---------- Mortality Step ----------

interface MortalityStepProps {
  formData: BiomassFormData;
  onChange: (data: Partial<BiomassFormData>) => void;
  prefill?: ReportPrefill<BiomassReportPayload>;
}

export const MortalityStep: React.FC<MortalityStepProps> = ({ formData, onChange, prefill }) => {
  // When mortality is aggregated from mortality_records it is the SSoT and the
  // per-cause grid renders read-only — corrections flow to the source records,
  // never the report. hydrateFormFromPayload already seeded the counts on wizard
  // open, so there is nothing to type.
  const mortalityMeta = prefill ? findFieldMeta(prefill.fields, '/mortality') : undefined;
  const mortalityFromRecords = mortalityMeta?.provenance === 'RECORDS';

  const handleLoadMortalityFromSystem = () => {
    if (!prefill) return;
    // Real per-cause aggregation from mortality_records — no more lumping
    // everything under "Unknown".
    const { mortality } = prefill.draftPayload;
    onChange({
      mortality: {
        totalCount: mortality.totalCount,
        byCause: mortality.byCause.map((entry) => ({
          cause: causeLabel(entry.cause),
          count: entry.count,
        })),
        details: mortality.details.map((detail) => ({
          id: crypto.randomUUID(),
          date: detail.date,
          cause: causeLabel(detail.cause),
          speciesName: detail.speciesCode,
          count: detail.count,
          biomassLossKg: detail.biomassLossKg ?? undefined,
          notes: detail.notes ?? undefined,
        })),
      },
    });
  };

  const updateByCause = (cause: string, count: number) => {
    const byCause = [...formData.mortality.byCause];
    const existingIndex = byCause.findIndex((c) => c.cause === cause);
    if (existingIndex >= 0) {
      if (count > 0) {
        byCause[existingIndex] = { cause, count };
      } else {
        byCause.splice(existingIndex, 1);
      }
    } else if (count > 0) {
      byCause.push({ cause, count });
    }

    const totalCount = byCause.reduce((sum, c) => sum + c.count, 0);
    onChange({
      mortality: {
        ...formData.mortality,
        byCause,
        totalCount,
      },
    });
  };

  const getCauseCount = (cause: string): number => {
    return formData.mortality.byCause.find((c) => c.cause === cause)?.count || 0;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
            Mortality by Cause
            <SectionProvenance prefill={prefill} path="/mortality" />
          </h4>
          <p className="text-xs text-gray-500">Record fish losses during the reporting period</p>
        </div>
        {prefill && !mortalityFromRecords && (
          <button
            type="button"
            onClick={handleLoadMortalityFromSystem}
            className="px-3 py-1.5 text-sm text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Load from System
          </button>
        )}
      </div>

      {/* Total Summary */}
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-red-800">Total Mortality</span>
          <span className="text-2xl font-bold text-red-700">
            {formatNumber(formData.mortality.totalCount)}
          </span>
        </div>
      </div>

      {mortalityFromRecords && (
        <p className="text-xs text-gray-500">
          Aggregated per cause from mortality records; corrections go to the source records, not the
          report.
        </p>
      )}

      {/* Cause Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {MORTALITY_CAUSES.map((cause) => (
          <div key={cause} className="bg-gray-50 border border-gray-200 rounded-lg p-3">
            <label className="block text-xs font-medium text-gray-600 mb-2">{cause}</label>
            <input
              type="number"
              min="0"
              value={getCauseCount(cause) || ''}
              onChange={(e) => updateByCause(cause, parseInt(e.target.value) || 0)}
              disabled={mortalityFromRecords}
              className={`w-full px-2 py-1.5 text-sm border rounded-md ${
                mortalityFromRecords
                  ? 'border-gray-200 bg-gray-100 text-gray-700'
                  : 'border-gray-300'
              }`}
              placeholder="0"
            />
          </div>
        ))}
      </div>
    </div>
  );
};

// ---------- Feed Step ----------

interface FeedStepProps {
  formData: BiomassFormData;
  onChange: (data: Partial<BiomassFormData>) => void;
  prefill?: ReportPrefill<BiomassReportPayload>;
}

export const FeedStep: React.FC<FeedStepProps> = ({ formData, onChange, prefill }) => {
  // Feed consumption summed from feeding_records is the SSoT — the per-feed-type
  // rows render read-only (corrections go to the feeding records, not the
  // report). hydrateFormFromPayload already seeded the rows on wizard open.
  const feedMeta = prefill ? findFieldMeta(prefill.fields, '/feedConsumption') : undefined;
  const feedFromRecords = feedMeta?.provenance === 'RECORDS';

  const handleLoadFeedFromSystem = () => {
    if (!prefill) return;
    // Real period sums from feeding_records — the old "daily rate × 30"
    // estimate is gone with the client-side aggregation.
    const { feedConsumption } = prefill.draftPayload;
    if (feedConsumption.byFeedType.length === 0) return;

    onChange({
      feedConsumption: {
        byFeedType: feedConsumption.byFeedType.map((entry) => ({
          ...entry,
          brandName: entry.brandName ?? undefined,
        })),
        totalKg: feedConsumption.totalKg,
      },
      feedLoadedFromSystem: true,
    });
  };

  const addFeedType = () => {
    const newFeed = { feedName: '', brandName: '', quantityKg: 0 };
    const byFeedType = [...formData.feedConsumption.byFeedType, newFeed];
    onChange({
      feedConsumption: {
        byFeedType,
        totalKg: byFeedType.reduce((sum, f) => sum + f.quantityKg, 0),
      },
    });
  };

  const updateFeedType = (
    index: number,
    updates: Partial<{ feedName: string; brandName: string; quantityKg: number }>,
  ) => {
    const byFeedType = formData.feedConsumption.byFeedType.map((f, i) =>
      i === index ? { ...f, ...updates } : f,
    );
    onChange({
      feedConsumption: {
        byFeedType,
        totalKg: byFeedType.reduce((sum, f) => sum + f.quantityKg, 0),
      },
    });
  };

  const removeFeedType = (index: number) => {
    const byFeedType = formData.feedConsumption.byFeedType.filter((_, i) => i !== index);
    onChange({
      feedConsumption: {
        byFeedType,
        totalKg: byFeedType.reduce((sum, f) => sum + f.quantityKg, 0),
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
            Feed Consumption
            <SectionProvenance prefill={prefill} path="/feedConsumption" />
          </h4>
          <p className="text-xs text-gray-500">Total feed used during the reporting period</p>
        </div>
        <div className="flex items-center gap-2">
          {prefill && !feedFromRecords && (
            <button
              type="button"
              onClick={handleLoadFeedFromSystem}
              className="px-3 py-1.5 text-sm text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Load from System
            </button>
          )}
          {!feedFromRecords && (
            <button
              type="button"
              onClick={addFeedType}
              className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
            >
              + Add Feed Type
            </button>
          )}
        </div>
      </div>

      {/* Auto-populated notice */}
      {formData.feedLoadedFromSystem && formData.feedConsumption.byFeedType.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-2">
          <svg
            className="w-4 h-4 text-green-600 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-sm text-green-700">
            Summed from feeding records for the reporting period.
            {feedFromRecords
              ? ' Corrections go to the feeding records, not the report.'
              : ' Adjust as needed.'}
          </span>
        </div>
      )}

      {/* Total Summary */}
      <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-orange-800">Total Feed Consumption</span>
          <span className="text-2xl font-bold text-orange-700">
            {formatWeight(formData.feedConsumption.totalKg)}
          </span>
        </div>
      </div>

      {formData.feedConsumption.byFeedType.length === 0 ? (
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
              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
            />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No feed records added</p>
          <p className="text-xs text-gray-400">
            {prefill
              ? 'Click "Load from System" to load feeding-record sums, or "Add Feed Type" to enter manually'
              : 'Click "Add Feed Type" to enter feed data'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.feedConsumption.byFeedType.map((feed, index) => (
            <div key={index} className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Feed #{index + 1}</span>
                {!feedFromRecords && (
                  <button
                    type="button"
                    onClick={() => removeFeedType(index)}
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
                )}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Feed Name</label>
                  <input
                    type="text"
                    value={feed.feedName}
                    onChange={(e) => updateFeedType(index, { feedName: e.target.value })}
                    disabled={feedFromRecords}
                    className={`w-full px-2 py-1.5 text-sm border rounded-md ${
                      feedFromRecords ? 'border-gray-200 bg-gray-100 text-gray-700' : 'border-gray-300'
                    }`}
                    placeholder="e.g., Grower 2mm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Brand</label>
                  <input
                    type="text"
                    value={feed.brandName}
                    onChange={(e) => updateFeedType(index, { brandName: e.target.value })}
                    disabled={feedFromRecords}
                    className={`w-full px-2 py-1.5 text-sm border rounded-md ${
                      feedFromRecords ? 'border-gray-200 bg-gray-100 text-gray-700' : 'border-gray-300'
                    }`}
                    placeholder="e.g., Skretting"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Quantity (kg)</label>
                  <input
                    type="number"
                    min="0"
                    value={feed.quantityKg || ''}
                    onChange={(e) =>
                      updateFeedType(index, { quantityKg: parseFloat(e.target.value) || 0 })
                    }
                    disabled={feedFromRecords}
                    className={`w-full px-2 py-1.5 text-sm border rounded-md ${
                      feedFromRecords ? 'border-gray-200 bg-gray-100 text-gray-700' : 'border-gray-300'
                    }`}
                    placeholder="0"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ---------- Transfers Step ----------

interface TransfersStepProps {
  formData: BiomassFormData;
  onChange: (data: Partial<BiomassFormData>) => void;
  prefill?: ReportPrefill<BiomassReportPayload>;
}

export const TransfersStep: React.FC<TransfersStepProps> = ({ formData, onChange, prefill }) => {
  // Transfers assembled from tank_operations (TRANSFER_IN/OUT) are the SSoT — the
  // rows render read-only (corrections go to the transfer records, not the
  // report). hydrateFormFromPayload already seeded them on wizard open.
  const transfersMeta = prefill ? findFieldMeta(prefill.fields, '/transfers') : undefined;
  const transfersFromRecords = transfersMeta?.provenance === 'RECORDS';

  const addTransfer = () => {
    const newTransfer: TransferFormRecord = {
      id: `tr-${Date.now()}`,
      direction: 'incoming',
      date: '',
      speciesName: '',
      quantity: 0,
      biomassKg: 0,
      fromToSite: '',
      batchNumber: '',
      reason: '',
    };
    onChange({ transfers: [...formData.transfers, newTransfer] });
  };

  const updateTransfer = (index: number, updates: Partial<TransferFormRecord>) => {
    const transfers = formData.transfers.map((t, i) => (i === index ? { ...t, ...updates } : t));
    onChange({ transfers });
  };

  const removeTransfer = (index: number) => {
    onChange({ transfers: formData.transfers.filter((_, i) => i !== index) });
  };

  const incomingCount = formData.transfers.filter((t) => t.direction === 'incoming').length;
  const outgoingCount = formData.transfers.filter((t) => t.direction === 'outgoing').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <span>Transfers</span>
            <SectionProvenance prefill={prefill} path="/transfers" />
          </h4>
          <p className="text-xs text-gray-500">
            Record fish transfers in and out during the reporting period
          </p>
        </div>
        {!transfersFromRecords && (
          <button
            type="button"
            onClick={addTransfer}
            className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
          >
            + Add Transfer
          </button>
        )}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-blue-800">Incoming</span>
            <span className="text-xl font-bold text-blue-700">{incomingCount}</span>
          </div>
        </div>
        <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-purple-800">Outgoing</span>
            <span className="text-xl font-bold text-purple-700">{outgoingCount}</span>
          </div>
        </div>
      </div>

      {formData.transfers.length === 0 ? (
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
              d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
            />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No transfers recorded</p>
          <p className="text-xs text-gray-400">
            Click "+ Add Transfer" if fish were transferred this period
          </p>
        </div>
      ) : (
        <fieldset
          disabled={transfersFromRecords}
          className={`space-y-3 border-0 p-0 m-0 ${transfersFromRecords ? 'opacity-75' : ''}`}
        >
          {formData.transfers.map((transfer, index) => (
            <div key={transfer.id} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700">Transfer #{index + 1}</span>
                  <span
                    className={`px-2 py-0.5 text-xs rounded-full ${
                      transfer.direction === 'incoming'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-purple-100 text-purple-700'
                    }`}
                  >
                    {transfer.direction === 'incoming' ? 'IN' : 'OUT'}
                  </span>
                </div>
                {!transfersFromRecords && (
                  <button
                    type="button"
                    onClick={() => removeTransfer(index)}
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
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Direction</label>
                  <select
                    value={transfer.direction}
                    onChange={(e) =>
                      updateTransfer(index, {
                        direction: e.target.value as 'incoming' | 'outgoing',
                      })
                    }
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  >
                    <option value="incoming">Incoming</option>
                    <option value="outgoing">Outgoing</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Date</label>
                  <input
                    type="date"
                    value={transfer.date}
                    onChange={(e) => updateTransfer(index, { date: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Species</label>
                  <input
                    type="text"
                    value={transfer.speciesName}
                    onChange={(e) => updateTransfer(index, { speciesName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g., Atlantic Salmon"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                  <input
                    type="number"
                    min="0"
                    value={transfer.quantity || ''}
                    onChange={(e) =>
                      updateTransfer(index, { quantity: parseInt(e.target.value) || 0 })
                    }
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Biomass (kg)</label>
                  <input
                    type="number"
                    min="0"
                    value={transfer.biomassKg || ''}
                    onChange={(e) =>
                      updateTransfer(index, { biomassKg: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">
                    {transfer.direction === 'incoming' ? 'From Site' : 'To Site'}
                  </label>
                  <input
                    type="text"
                    value={transfer.fromToSite}
                    onChange={(e) => updateTransfer(index, { fromToSite: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="Site name"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Batch Number</label>
                  <input
                    type="text"
                    value={transfer.batchNumber}
                    onChange={(e) => updateTransfer(index, { batchNumber: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g., B-2024-001"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Reason</label>
                  <input
                    type="text"
                    value={transfer.reason}
                    onChange={(e) => updateTransfer(index, { reason: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g., Production move"
                  />
                </div>
              </div>
            </div>
          ))}
        </fieldset>
      )}
    </div>
  );
};

// ---------- Review Step ----------

interface ReviewStepProps {
  formData: BiomassFormData;
  siteName: string;
}

const ReviewStep: React.FC<ReviewStepProps> = ({ formData, siteName }) => {
  // Estimated FCR - show raw ratio only, label as estimated
  const estimatedFcr =
    formData.feedConsumption.totalKg > 0 && formData.currentBiomass.totalKg > 0
      ? 'N/A (insufficient data for accurate calculation)'
      : 'N/A';

  // Simple display FCR if we have both feed and biomass
  const fcrDisplay =
    formData.feedConsumption.totalKg > 0 && formData.currentBiomass.totalKg > 0
      ? (formData.feedConsumption.totalKg / formData.currentBiomass.totalKg).toFixed(2)
      : 'N/A';

  const incomingTransfers = formData.transfers.filter((t) => t.direction === 'incoming');
  const outgoingTransfers = formData.transfers.filter((t) => t.direction === 'outgoing');

  return (
    <div className="space-y-6">
      {/* Summary Header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-blue-800">Report Summary</h4>
        <p className="text-sm text-blue-600 mt-1">
          {siteName} - {getMonthLabel(formData.month, formData.year)}
        </p>
      </div>

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-green-600">
            {formatWeight(formData.currentBiomass.totalKg)}
          </div>
          <div className="text-xs text-gray-500">Total Biomass</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-red-600">
            {formatNumber(formData.mortality.totalCount)}
          </div>
          <div className="text-xs text-gray-500">Total Mortality</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-orange-600">
            {formatWeight(formData.feedConsumption.totalKg)}
          </div>
          <div className="text-xs text-gray-500">Feed Used</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{fcrDisplay}</div>
          <div className="text-xs text-gray-500">Estimated FCR</div>
        </div>
      </div>

      {/* Species Breakdown */}
      {formData.currentBiomass.bySpecies.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Biomass by Species</h5>
          <div className="space-y-2">
            {formData.currentBiomass.bySpecies.map((s, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">{s.speciesName || 'Unknown'}</span>
                <div className="text-right">
                  <span className="font-medium text-gray-900">{formatWeight(s.biomassKg)}</span>
                  <span className="text-gray-500 ml-2">({formatNumber(s.fishCount)} fish)</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stocking Records */}
      {formData.stockings.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Stocking Records</h5>
          <div className="space-y-2">
            {formData.stockings.map((s, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-sm bg-indigo-50 rounded p-2"
              >
                <div>
                  <span className="text-gray-700">{s.speciesName || 'Unknown'}</span>
                  {s.date && <span className="text-gray-400 ml-2 text-xs">{s.date}</span>}
                </div>
                <div className="text-right">
                  <span className="font-medium text-indigo-700">
                    {formatNumber(s.quantity)} fish
                  </span>
                  {s.avgWeightG > 0 && (
                    <span className="text-gray-500 ml-2">({s.avgWeightG.toFixed(0)}g avg)</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mortality Breakdown */}
      {formData.mortality.byCause.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Mortality by Cause</h5>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {formData.mortality.byCause.map((c, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-sm bg-red-50 rounded p-2"
              >
                <span className="text-gray-700">{c.cause}</span>
                <span className="font-medium text-red-700">{formatNumber(c.count)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Feed Breakdown */}
      {formData.feedConsumption.byFeedType.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Feed Consumption</h5>
          <div className="space-y-2">
            {formData.feedConsumption.byFeedType.map((f, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-sm bg-orange-50 rounded p-2"
              >
                <div>
                  <span className="text-gray-700">{f.feedName || 'Unknown'}</span>
                  {f.brandName && (
                    <span className="text-gray-400 ml-2 text-xs">({f.brandName})</span>
                  )}
                </div>
                <span className="font-medium text-orange-700">{formatWeight(f.quantityKg)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transfers */}
      {formData.transfers.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Transfers</h5>
          {incomingTransfers.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-medium text-blue-600 mb-1">Incoming</p>
              <div className="space-y-1">
                {incomingTransfers.map((t, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-sm bg-blue-50 rounded p-2"
                  >
                    <div>
                      <span className="text-gray-700">{t.speciesName || 'Unknown'}</span>
                      {t.fromToSite && (
                        <span className="text-gray-400 ml-2 text-xs">from {t.fromToSite}</span>
                      )}
                    </div>
                    <div className="text-right">
                      <span className="font-medium text-blue-700">
                        {formatNumber(t.quantity)} fish
                      </span>
                      <span className="text-gray-500 ml-2">({formatWeight(t.biomassKg)})</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {outgoingTransfers.length > 0 && (
            <div>
              <p className="text-xs font-medium text-purple-600 mb-1">Outgoing</p>
              <div className="space-y-1">
                {outgoingTransfers.map((t, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-sm bg-purple-50 rounded p-2"
                  >
                    <div>
                      <span className="text-gray-700">{t.speciesName || 'Unknown'}</span>
                      {t.fromToSite && (
                        <span className="text-gray-400 ml-2 text-xs">to {t.fromToSite}</span>
                      )}
                    </div>
                    <div className="text-right">
                      <span className="font-medium text-purple-700">
                        {formatNumber(t.quantity)} fish
                      </span>
                      <span className="text-gray-500 ml-2">({formatWeight(t.biomassKg)})</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* FCR Note */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
        <p className="text-xs text-yellow-700">
          <span className="font-medium">Note on Estimated FCR:</span> The displayed FCR is a
          simplified ratio (total feed / current biomass). Accurate FCR requires: total feed
          consumed / (current biomass - initial biomass + harvested biomass + mortality biomass).
          Please verify with your production records.
        </p>
      </div>

      {/* Submission Notice — honest manual-Altinn channel (RPT-001) */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <p className="text-sm text-gray-600">
          Saving stores this report as a draft. Biomass reports are submitted to Fiskeridirektoratet
          manually via Altinn (FD-0001): after saving, mark the report ready, download the FD-0001
          export, transcribe it into the Altinn form, then confirm the submission with the Altinn
          receipt reference.
        </p>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

/** Honest per-status list chip — DRAFT / READY / CONFIRMED / legacy SUBMITTED. */
function biomassStatusChip(status: BiomassReportStatusValue): { label: string; className: string } {
  switch (status) {
    case 'CONFIRMED_SUBMITTED':
      return { label: 'Submitted (Altinn)', className: 'bg-green-100 text-green-800' };
    case 'SUBMITTED':
      return { label: 'Submitted (legacy)', className: 'bg-green-100 text-green-800' };
    case 'READY':
      return { label: 'Ready for Altinn', className: 'bg-blue-100 text-blue-800' };
    case 'DRAFT':
    default:
      return { label: 'Draft', className: 'bg-amber-100 text-amber-800' };
  }
}

export const BiomassReportTab: React.FC<BiomassReportTabProps> = ({ siteId }) => {
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [formData, setFormData] = useState<BiomassFormData>(getInitialFormData());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Regulatory settings supply contact info + the site↔locality mappings
  // that drive site selection when the tab is mounted without a siteId
  // (ReportsPage mounts it bare — previously the required-site submit
  // guard could never be satisfied).
  const { data: regulatorySettings } = useRegulatorySettings();
  const [selectedSiteId, setSelectedSiteId] = useState<string | undefined>(undefined);
  const siteMappings = regulatorySettings?.siteLocalityMappings ?? [];
  const effectiveSiteId = siteId ?? selectedSiteId ?? siteMappings[0]?.siteId;
  const effectiveMapping = siteMappings.find((m) => m.siteId === effectiveSiteId);
  const effectiveSiteName =
    effectiveMapping?.siteName ??
    (effectiveMapping ? `Lokalitet ${effectiveMapping.lokalitetsnummer}` : 'Default Site');

  // Persisted report history (FARM-HIGH-125) — real rows, no mock.
  const {
    data: biomassReports = [],
    isLoading: reportsLoading,
    isError: reportsError,
  } = useBiomassReports(effectiveSiteId);
  const invalidateBiomassReports = useInvalidateBiomassReports();

  const stats = useMemo(
    () => ({
      total: biomassReports.length,
      // Not-yet-submitted (DRAFT + READY-for-Altinn).
      inProgress: biomassReports.filter((r) => !isTerminalBiomassStatus(r.status)).length,
      // Confirmed submitted via Altinn (+ legacy SUBMITTED).
      submitted: biomassReports.filter((r) => isTerminalBiomassStatus(r.status)).length,
    }),
    [biomassReports],
  );

  // The wizard always targets the previous calendar month (getInitialFormData);
  // resolve whether that period is already persisted so we can pre-fill a DRAFT
  // and block editing a finalised (immutable) SUBMITTED period.
  const targetPeriod = useMemo(() => {
    const seed = getInitialFormData();
    return { month: seed.month, year: seed.year };
  }, []);
  const periodRow = biomassReports.find(
    (r) => r.reportMonth === targetPeriod.month + 1 && r.reportYear === targetPeriod.year,
  );
  const periodDraftExists = periodRow?.status === 'DRAFT';
  // A terminal (confirmed/legacy) period is immutable. A READY period is a
  // reviewed snapshot — it must be reopened to DRAFT (via the Altinn panel)
  // before the wizard can edit it, so both block the editable wizard.
  const periodTerminal = periodRow ? isTerminalBiomassStatus(periodRow.status) : false;
  const periodEditable = !periodRow || periodRow.status === 'DRAFT';

  // Server-assembled draft for the target period: every section aggregated
  // from the operational SSoTs with per-field provenance (plan Phase 1).
  const { data: prefill } = useReportPrefill<BiomassReportPayload>('BIOMASS', effectiveSiteId, {
    year: targetPeriod.year,
    month: targetPeriod.month + 1,
  });

  // Fetch the full JSONB payload for the target period only when a DRAFT exists,
  // so the wizard opens pre-filled instead of overwriting it.
  const { data: existingDraft } = useBiomassReport(
    effectiveSiteId,
    targetPeriod.month + 1,
    targetPeriod.year,
    { enabled: !!periodDraftExists },
  );

  // Form handlers
  const handleFormChange = useCallback((updates: Partial<BiomassFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleOpenWizard = useCallback(() => {
    // Only a DRAFT (or a brand-new period) is editable. A READY snapshot must
    // be reopened via the Altinn panel and a terminal period is immutable —
    // opening the wizard for either would only fail on save.
    if (!periodEditable) return;

    // Returning to a drafted month: hydrate from the persisted payload so the
    // user continues the draft instead of blanking it.
    if (existingDraft?.reportData) {
      setFormData(
        hydrateFormFromPayload(existingDraft.reportData, targetPeriod.month, targetPeriod.year),
      );
      setIsWizardOpen(true);
      return;
    }

    // Fresh month: seed the whole wizard from the server-assembled draft —
    // biomass, stockings, mortality by cause, slaughter, transfers and feed
    // all arrive aggregated from the operational records.
    if (prefill) {
      setFormData({
        ...hydrateFormFromPayload(prefill.draftPayload, targetPeriod.month, targetPeriod.year),
        biomassLoadedFromSystem: prefill.draftPayload.currentBiomass.bySpecies.length > 0,
        feedLoadedFromSystem: prefill.draftPayload.feedConsumption.byFeedType.length > 0,
      });
    } else {
      setFormData(getInitialFormData());
    }
    setIsWizardOpen(true);
  }, [prefill, periodEditable, existingDraft, targetPeriod]);

  const createReportMutation = useMutation({
    mutationFn: async (payload: { input: Record<string, unknown> }) => {
      return graphqlClient.request(CREATE_BIOMASS_REPORT_MUTATION, payload);
    },
  });

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      if (!effectiveSiteId) {
        throw new Error('Site is required to submit a biomass report.');
      }

      // Map frontend BiomassFormData → backend CreateBiomassReportInput.
      //
      // Two conventions differ across the layers:
      //   - Frontend `month` is 0-indexed (JS Date.getMonth semantics);
      //     backend `reportMonth` is 1–12.
      //   - Frontend `transfers[].direction` uses 'incoming' / 'outgoing'
      //     strings; backend enum is 'IN' / 'OUT'.
      //
      // Stocking records store `quantity` + `avgWeightG`; the backend
      // wants `biomassKg` explicitly, so we derive it here. All
      // optional notes fields collapse to `undefined` when empty so the
      // validator's `@IsOptional` branch is taken instead of failing
      // on empty strings.
      const input = {
        siteId: effectiveSiteId,
        reportMonth: formData.month + 1,
        reportYear: formData.year,
        currentBiomass: {
          totalKg: formData.currentBiomass.totalKg,
          bySpecies: formData.currentBiomass.bySpecies.map((s) => ({
            speciesId: s.speciesId,
            speciesName: s.speciesName,
            fishCount: s.fishCount,
            biomassKg: s.biomassKg,
            avgWeightG: s.avgWeightG,
          })),
        },
        stockings: formData.stockings.map((r) => ({
          date: r.date,
          speciesCode: r.speciesName,
          supplier: r.supplier || undefined,
          fishCount: r.quantity,
          avgWeightG: r.avgWeightG,
          biomassKg: (r.quantity * r.avgWeightG) / 1000,
          notes: r.batchNumber || undefined,
        })),
        mortality: {
          totalCount: formData.mortality.totalCount,
          byCause: formData.mortality.byCause.map((c) => ({
            cause: c.cause,
            count: c.count,
          })),
          details: formData.mortality.details.map((d) => ({
            date: d.date,
            cause: d.cause,
            speciesCode: d.speciesName ?? '',
            count: d.count,
            biomassLossKg: d.biomassLossKg ?? undefined,
            notes: d.notes || undefined,
          })),
        },
        slaughter: {
          totalQuantity: formData.slaughter.totalQuantity,
          totalBiomassKg: formData.slaughter.totalBiomassKg,
          records: formData.slaughter.records.map((r) => ({
            date: r.date,
            speciesCode: r.speciesName ?? '',
            quantity: r.quantity,
            biomassKg: r.biomassKg,
            buyer: r.buyer || undefined,
            notes: r.notes || undefined,
          })),
        },
        transfers: formData.transfers.map((t) => ({
          date: t.date,
          direction: t.direction === 'incoming' ? 'IN' : 'OUT',
          speciesCode: t.speciesName,
          fishCount: t.quantity,
          biomassKg: t.biomassKg,
          counterparty: t.fromToSite || undefined,
          notes: t.reason || undefined,
        })),
        feedConsumption: {
          totalKg: formData.feedConsumption.totalKg,
          byFeedType: formData.feedConsumption.byFeedType.map((f) => ({
            feedName: f.feedName,
            brandName: f.brandName || undefined,
            quantityKg: f.quantityKg,
          })),
        },
      };

      await createReportMutation.mutateAsync({ input });
      invalidateBiomassReports();
      setIsWizardOpen(false);
      setFormData(getInitialFormData());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, effectiveSiteId, createReportMutation, invalidateBiomassReports]);

  // Wizard steps
  const steps: ReportWizardStep[] = useMemo(
    () => [
      {
        id: 'basic',
        title: 'Report Info',
        description: 'Period and overview',
        content: (
          <BasicInfoStep
            formData={formData}
            onChange={handleFormChange}
            siteName={effectiveSiteName}
          />
        ),
      },
      {
        id: 'biomass',
        title: 'Biomass',
        description: 'Current stock levels',
        content: <BiomassStep formData={formData} onChange={handleFormChange} prefill={prefill} />,
        isValid: () => formData.currentBiomass.bySpecies.length > 0,
      },
      {
        id: 'stockings',
        title: 'Stockings',
        description: 'Fish arrivals',
        content: <StockingStep formData={formData} onChange={handleFormChange} prefill={prefill} />,
      },
      {
        id: 'mortality',
        title: 'Mortality',
        description: 'Fish losses by cause',
        content: (
          <MortalityStep formData={formData} onChange={handleFormChange} prefill={prefill} />
        ),
      },
      {
        id: 'feed',
        title: 'Feed',
        description: 'Feed consumption data',
        content: <FeedStep formData={formData} onChange={handleFormChange} prefill={prefill} />,
        isValid: () => formData.feedConsumption.totalKg > 0,
      },
      {
        id: 'transfers',
        title: 'Transfers',
        description: 'Fish movements in/out',
        content: <TransfersStep formData={formData} onChange={handleFormChange} prefill={prefill} />,
      },
      {
        id: 'review',
        title: 'Review',
        description: 'Verify and save',
        content: <ReviewStep formData={formData} siteName={effectiveSiteName} />,
      },
    ],
    [formData, handleFormChange, effectiveSiteName, prefill],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Biomass Reports</h2>
          <p className="text-sm text-gray-500">
            Monthly reports for Fiskeridirektoratet - Due 7th of each month
          </p>
        </div>
        <div className="flex items-center gap-3">
          {!siteId && siteMappings.length > 0 && (
            <select
              value={effectiveSiteId ?? ''}
              onChange={(e) => setSelectedSiteId(e.target.value || undefined)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white"
              aria-label="Site"
            >
              {siteMappings.map((m) => (
                <option key={m.siteId} value={m.siteId}>
                  {m.siteName ?? `Lokalitet ${m.lokalitetsnummer}`}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => handleOpenWizard()}
            disabled={!periodEditable}
            title={
              periodTerminal
                ? `${getMonthLabel(targetPeriod.month, targetPeriod.year)} is already submitted and immutable`
                : !periodEditable
                  ? `${getMonthLabel(targetPeriod.month, targetPeriod.year)} is ready for Altinn — reopen it to draft to edit`
                  : undefined
            }
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            {periodDraftExists ? 'Continue Draft' : 'New Report'}
          </button>
        </div>
      </div>

      {/* Altinn manual-submission panel for the target period's saved report */}
      {periodRow && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">
            {getMonthLabel(targetPeriod.month, targetPeriod.year)} — Fiskeridirektoratet submission
          </p>
          <BiomassAltinnPanel report={periodRow} />
        </div>
      )}

      {/* Stats Cards — real persisted rows */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
          <div className="text-sm text-gray-500">Total Reports</div>
        </div>
        <div className="bg-white rounded-lg border border-amber-200 p-4">
          <div className="text-2xl font-bold text-amber-600">{stats.inProgress}</div>
          <div className="text-sm text-gray-500">In Progress</div>
        </div>
        <div className="bg-white rounded-lg border border-green-200 p-4">
          <div className="text-2xl font-bold text-green-600">{stats.submitted}</div>
          <div className="text-sm text-gray-500">Submitted</div>
        </div>
      </div>

      {/* Report History (FARM-HIGH-125) */}
      {!effectiveSiteId ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
          <p className="text-sm text-gray-500">
            Configure site–locality mappings in Report Settings to list biomass reports.
          </p>
        </div>
      ) : reportsLoading ? (
        <p className="text-sm text-gray-500 py-8 text-center">Loading report history…</p>
      ) : reportsError ? (
        <div className="text-center py-8 bg-red-50 rounded-lg border border-red-200">
          <p className="text-sm text-red-700">Failed to load report history. Please retry.</p>
        </div>
      ) : biomassReports.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <p className="mt-2 text-sm text-gray-500">No reports found</p>
          <button
            onClick={() => handleOpenWizard()}
            className="mt-4 px-4 py-2 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
          >
            Create First Report
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-gray-200 bg-white rounded-lg border border-gray-200">
          {biomassReports.map((row) => (
            <li key={row.id} className="p-4 flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">
                    {getMonthLabel(row.reportMonth - 1, row.reportYear)}
                  </span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${
                      biomassStatusChip(row.status).className
                    }`}
                  >
                    {biomassStatusChip(row.status).label}
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {formatWeight(Number(row.totalBiomassKg))} total biomass
                </p>
              </div>
              <p className="text-xs text-gray-500">
                {row.submittedAt ? formatDate(new Date(row.submittedAt)) : '—'}
              </p>
            </li>
          ))}
        </ul>
      )}

      {/* Wizard Modal */}
      <ReportWizard
        isOpen={isWizardOpen}
        onClose={() => {
          setIsWizardOpen(false);
          setFormData(getInitialFormData());
        }}
        onSubmit={handleSubmit}
        title="Biomass Report"
        subtitle={`Monthly report - ${getMonthLabel(formData.month, formData.year)}`}
        steps={steps}
        isSubmitting={isSubmitting}
        error={error}
        onClearError={() => setError(null)}
        submitButtonText="Save Draft"
        maxWidth="max-w-4xl"
      />
    </div>
  );
};

export default BiomassReportTab;
