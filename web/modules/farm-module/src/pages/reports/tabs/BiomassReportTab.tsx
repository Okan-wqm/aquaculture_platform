/**
 * Biomass Report Tab
 * Monthly biomass reports for Fiskeridirektoratet
 * Due 7th of each month
 */
import React, { useState, useMemo, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { graphqlClient } from '@aquaculture/shared-ui';
import { useRegulatorySettings } from '../../../hooks/useRegulatory';
import { mockBiomassReports } from '../mock/biomassData';
import {
  BiomassReport,
  BiomassSpeciesBreakdown,
  StockingRecord,
  MortalityDetail,
  SlaughterRecord,
  TransferRecord,
  ReportStatus,
} from '../types/reports.types';
import { ReportStatusBadge, DeadlineIndicator } from '../components/common';
import { ReportWizard, ReportWizardStep } from '../components/wizard/ReportWizard';
import { useTanksList, Tank } from '../../../hooks/useTanks';
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

interface BiomassFormData {
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
    details: MortalityDetail[];
  };
  slaughter: {
    totalQuantity: number;
    totalBiomassKg: number;
    records: SlaughterRecord[];
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
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
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
 * Aggregate biomass data by species from tank batch metrics
 */
function aggregateBiomassFromTanks(tanks: Tank[]): {
  bySpecies: BiomassSpeciesBreakdown[];
  totalKg: number;
  totalMortality: number;
} {
  const speciesMap = new Map<string, {
    fishCount: number;
    biomassKg: number;
    totalMortality: number;
  }>();

  for (const tank of tanks) {
    const metrics = tank.batchMetrics;
    if (!metrics || !metrics.speciesCode) continue;

    const code = metrics.speciesCode;
    const existing = speciesMap.get(code) || { fishCount: 0, biomassKg: 0, totalMortality: 0 };
    existing.fishCount += metrics.pieces || 0;
    existing.biomassKg += metrics.biomass || 0;
    existing.totalMortality += metrics.totalMortality || 0;
    speciesMap.set(code, existing);
  }

  const bySpecies: BiomassSpeciesBreakdown[] = [];
  let totalKg = 0;
  let totalMortality = 0;

  for (const [code, data] of speciesMap.entries()) {
    const avgWeightG = data.fishCount > 0 ? (data.biomassKg * 1000) / data.fishCount : 0;
    bySpecies.push({
      speciesId: code,
      speciesName: code,
      fishCount: data.fishCount,
      biomassKg: data.biomassKg,
      avgWeightG,
    });
    totalKg += data.biomassKg;
    totalMortality += data.totalMortality;
  }

  return { bySpecies, totalKg, totalMortality };
}

/**
 * Aggregate feed data from tank batch metrics
 */
function aggregateFeedFromTanks(tanks: Tank[]): {
  byFeedType: { feedName: string; brandName?: string; quantityKg: number }[];
  totalKg: number;
} {
  const feedMap = new Map<string, { feedName: string; dailyKg: number }>();

  for (const tank of tanks) {
    const metrics = tank.batchMetrics;
    if (!metrics || !metrics.feedCode) continue;

    const key = metrics.feedCode;
    const existing = feedMap.get(key) || { feedName: metrics.feedName || metrics.feedCode, dailyKg: 0 };
    existing.dailyKg += metrics.dailyFeedKg || 0;
    feedMap.set(key, existing);
  }

  const byFeedType: { feedName: string; brandName?: string; quantityKg: number }[] = [];
  let totalKg = 0;

  for (const [_code, data] of feedMap.entries()) {
    // Estimate monthly consumption from daily feed rate (30 days)
    const monthlyKg = Math.round(data.dailyKg * 30);
    byFeedType.push({
      feedName: data.feedName,
      quantityKg: monthlyKg,
    });
    totalKg += monthlyKg;
  }

  return { byFeedType, totalKg };
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

// ============================================================================
// Report Card Component
// ============================================================================

interface BiomassReportCardProps {
  report: BiomassReport;
  onView: () => void;
  onEdit?: () => void;
}

const BiomassReportCard: React.FC<BiomassReportCardProps> = ({ report, onView, onEdit }) => {
  const isPending = report.status === 'pending' || report.status === 'overdue';

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-100 rounded-lg">
              <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
              </svg>
            </div>
            <div>
              <h3 className="font-medium text-gray-900">{getMonthLabel(report.month, report.year)}</h3>
              <p className="text-sm text-gray-500">{report.siteName}</p>
            </div>
          </div>
          <ReportStatusBadge status={report.status} size="sm" />
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        {/* Key Metrics */}
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="text-center p-2 bg-blue-50 rounded">
            <div className="text-lg font-bold text-blue-700">{formatWeight(report.currentBiomass.totalKg)}</div>
            <div className="text-xs text-gray-500">Biomass</div>
          </div>
          <div className="text-center p-2 bg-red-50 rounded">
            <div className="text-lg font-bold text-red-700">{formatNumber(report.mortality.totalCount)}</div>
            <div className="text-xs text-gray-500">Mortality</div>
          </div>
          <div className="text-center p-2 bg-orange-50 rounded">
            <div className="text-lg font-bold text-orange-700">{formatWeight(report.feedConsumption.totalKg)}</div>
            <div className="text-xs text-gray-500">Feed</div>
          </div>
        </div>

        {/* Additional Stats */}
        <div className="grid grid-cols-2 gap-2 text-sm pt-3 border-t border-gray-100">
          <div>
            <span className="text-gray-500">Species:</span>
            <span className="ml-1 font-medium">{report.currentBiomass.bySpecies.length}</span>
          </div>
          <div>
            <span className="text-gray-500">Stockings:</span>
            <span className="ml-1 font-medium">{report.stockings.length}</span>
          </div>
          <div>
            <span className="text-gray-500">Harvests:</span>
            <span className="ml-1 font-medium">{report.slaughter.records.length}</span>
          </div>
          <div>
            <span className="text-gray-500">Transfers:</span>
            <span className="ml-1 font-medium">
              {report.transfers.incoming.length + report.transfers.outgoing.length}
            </span>
          </div>
        </div>

        {/* Deadline for pending */}
        {isPending && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <DeadlineIndicator deadline={report.deadline} status={report.status} reportType="Biomass" />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-100 bg-gray-50 flex justify-end gap-2">
        <button
          onClick={onView}
          className="px-3 py-1.5 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          View Details
        </button>
        {isPending && onEdit && (
          <button
            onClick={onEdit}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            Complete Report
          </button>
        )}
      </div>
    </div>
  );
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
        This report includes biomass, stocking records, mortality, harvests, transfers, and feed consumption for the reporting period.
      </p>
      <ul className="mt-3 space-y-1 text-sm text-blue-700">
        <li className="flex items-center">
          <svg className="w-4 h-4 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Current biomass by species
        </li>
        <li className="flex items-center">
          <svg className="w-4 h-4 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Stocking records (fish arrivals)
        </li>
        <li className="flex items-center">
          <svg className="w-4 h-4 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Mortality by cause
        </li>
        <li className="flex items-center">
          <svg className="w-4 h-4 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Slaughter/harvest records
        </li>
        <li className="flex items-center">
          <svg className="w-4 h-4 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Feed consumption
        </li>
        <li className="flex items-center">
          <svg className="w-4 h-4 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
  tanks: Tank[];
}

const BiomassStep: React.FC<BiomassStepProps> = ({ formData, onChange, tanks }) => {
  const handleLoadFromSystem = () => {
    if (!tanks || tanks.length === 0) return;
    const aggregated = aggregateBiomassFromTanks(tanks);
    if (aggregated.bySpecies.length === 0) return;

    onChange({
      currentBiomass: {
        bySpecies: aggregated.bySpecies,
        totalKg: aggregated.totalKg,
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
          <h4 className="text-sm font-medium text-gray-700">Current Biomass by Species</h4>
          <p className="text-xs text-gray-500">End of month standing stock</p>
        </div>
        <div className="flex items-center gap-2">
          {tanks.length > 0 && (
            <button
              type="button"
              onClick={handleLoadFromSystem}
              className="px-3 py-1.5 text-sm text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Load from System
            </button>
          )}
          <button
            type="button"
            onClick={addSpecies}
            className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
          >
            + Add Species
          </button>
        </div>
      </div>

      {/* Auto-populated notice */}
      {formData.biomassLoadedFromSystem && formData.currentBiomass.bySpecies.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-green-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-sm text-green-700">Auto-populated from current tank data. You can adjust values manually.</span>
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
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No species added</p>
          <p className="text-xs text-gray-400">
            {tanks.length > 0
              ? 'Click "Load from System" to auto-populate from tank data, or "Add Species" to enter manually'
              : 'Click "Add Species" to enter biomass data'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.currentBiomass.bySpecies.map((species, index) => (
            <div key={species.speciesId} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm font-medium text-gray-700">Species #{index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeSpecies(index)}
                  className="text-red-500 hover:text-red-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="col-span-2 md:col-span-1">
                  <label className="block text-xs text-gray-500 mb-1">Species Name</label>
                  <input
                    type="text"
                    value={species.speciesName}
                    onChange={(e) => updateSpecies(index, { speciesName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g., Atlantic Salmon"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Fish Count</label>
                  <input
                    type="number"
                    min="0"
                    value={species.fishCount || ''}
                    onChange={(e) => updateSpecies(index, { fishCount: parseInt(e.target.value) || 0 })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Biomass (kg)</label>
                  <input
                    type="number"
                    min="0"
                    value={species.biomassKg || ''}
                    onChange={(e) => updateSpecies(index, { biomassKg: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
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
}

const StockingStep: React.FC<StockingStepProps> = ({ formData, onChange }) => {
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
    const stockings = formData.stockings.map((r, i) =>
      i === index ? { ...r, ...updates } : r
    );
    onChange({ stockings });
  };

  const removeStockingRecord = (index: number) => {
    onChange({ stockings: formData.stockings.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700">Stocking Records</h4>
          <p className="text-xs text-gray-500">Fish arrivals during the reporting period (required by Fiskeridirektoratet)</p>
        </div>
        <button
          type="button"
          onClick={addStockingRecord}
          className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
        >
          + Add Stocking Record
        </button>
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
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No stocking records</p>
          <p className="text-xs text-gray-400">Click "+ Add Stocking Record" if fish were received this period</p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.stockings.map((record, index) => (
            <div key={record.id} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm font-medium text-gray-700">Stocking #{index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeStockingRecord(index)}
                  className="text-red-500 hover:text-red-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
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
                    onChange={(e) => updateStockingRecord(index, { quantity: parseInt(e.target.value) || 0 })}
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
                    onChange={(e) => updateStockingRecord(index, { avgWeightG: parseFloat(e.target.value) || 0 })}
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
        </div>
      )}
    </div>
  );
};

// ---------- Mortality Step ----------

interface MortalityStepProps {
  formData: BiomassFormData;
  onChange: (data: Partial<BiomassFormData>) => void;
  tanks: Tank[];
}

const MortalityStep: React.FC<MortalityStepProps> = ({ formData, onChange, tanks }) => {
  const handleLoadMortalityFromSystem = () => {
    if (!tanks || tanks.length === 0) return;
    const aggregated = aggregateBiomassFromTanks(tanks);
    if (aggregated.totalMortality > 0) {
      // Put total mortality under "Unknown" cause since we don't have per-cause breakdown from tanks
      const byCause = [{ cause: 'Unknown', count: aggregated.totalMortality }];
      onChange({
        mortality: {
          ...formData.mortality,
          byCause,
          totalCount: aggregated.totalMortality,
        },
      });
    }
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
          <h4 className="text-sm font-medium text-gray-700">Mortality by Cause</h4>
          <p className="text-xs text-gray-500">Record fish losses during the reporting period</p>
        </div>
        {tanks.length > 0 && (
          <button
            type="button"
            onClick={handleLoadMortalityFromSystem}
            className="px-3 py-1.5 text-sm text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
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
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
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
  tanks: Tank[];
}

const FeedStep: React.FC<FeedStepProps> = ({ formData, onChange, tanks }) => {
  const handleLoadFeedFromSystem = () => {
    if (!tanks || tanks.length === 0) return;
    const aggregated = aggregateFeedFromTanks(tanks);
    if (aggregated.byFeedType.length === 0) return;

    onChange({
      feedConsumption: {
        byFeedType: aggregated.byFeedType,
        totalKg: aggregated.totalKg,
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

  const updateFeedType = (index: number, updates: Partial<{ feedName: string; brandName: string; quantityKg: number }>) => {
    const byFeedType = formData.feedConsumption.byFeedType.map((f, i) =>
      i === index ? { ...f, ...updates } : f
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
          <h4 className="text-sm font-medium text-gray-700">Feed Consumption</h4>
          <p className="text-xs text-gray-500">Total feed used during the reporting period</p>
        </div>
        <div className="flex items-center gap-2">
          {tanks.length > 0 && (
            <button
              type="button"
              onClick={handleLoadFeedFromSystem}
              className="px-3 py-1.5 text-sm text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Load from System
            </button>
          )}
          <button
            type="button"
            onClick={addFeedType}
            className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
          >
            + Add Feed Type
          </button>
        </div>
      </div>

      {/* Auto-populated notice */}
      {formData.feedLoadedFromSystem && formData.feedConsumption.byFeedType.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-green-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-sm text-green-700">Auto-populated from current tank data (estimated from daily feed rates x 30 days). Adjust as needed.</span>
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
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No feed records added</p>
          <p className="text-xs text-gray-400">
            {tanks.length > 0
              ? 'Click "Load from System" to auto-populate, or "Add Feed Type" to enter manually'
              : 'Click "Add Feed Type" to enter feed data'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.feedConsumption.byFeedType.map((feed, index) => (
            <div key={index} className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Feed #{index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeFeedType(index)}
                  className="text-red-500 hover:text-red-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Feed Name</label>
                  <input
                    type="text"
                    value={feed.feedName}
                    onChange={(e) => updateFeedType(index, { feedName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g., Grower 2mm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Brand</label>
                  <input
                    type="text"
                    value={feed.brandName}
                    onChange={(e) => updateFeedType(index, { brandName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g., Skretting"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Quantity (kg)</label>
                  <input
                    type="number"
                    min="0"
                    value={feed.quantityKg || ''}
                    onChange={(e) => updateFeedType(index, { quantityKg: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
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
}

const TransfersStep: React.FC<TransfersStepProps> = ({ formData, onChange }) => {
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
    const transfers = formData.transfers.map((t, i) =>
      i === index ? { ...t, ...updates } : t
    );
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
          <h4 className="text-sm font-medium text-gray-700">Transfers</h4>
          <p className="text-xs text-gray-500">Record fish transfers in and out during the reporting period</p>
        </div>
        <button
          type="button"
          onClick={addTransfer}
          className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
        >
          + Add Transfer
        </button>
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
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No transfers recorded</p>
          <p className="text-xs text-gray-400">Click "+ Add Transfer" if fish were transferred this period</p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.transfers.map((transfer, index) => (
            <div key={transfer.id} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700">Transfer #{index + 1}</span>
                  <span className={`px-2 py-0.5 text-xs rounded-full ${
                    transfer.direction === 'incoming'
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-purple-100 text-purple-700'
                  }`}>
                    {transfer.direction === 'incoming' ? 'IN' : 'OUT'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => removeTransfer(index)}
                  className="text-red-500 hover:text-red-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Direction</label>
                  <select
                    value={transfer.direction}
                    onChange={(e) => updateTransfer(index, { direction: e.target.value as 'incoming' | 'outgoing' })}
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
                    onChange={(e) => updateTransfer(index, { quantity: parseInt(e.target.value) || 0 })}
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
                    onChange={(e) => updateTransfer(index, { biomassKg: parseFloat(e.target.value) || 0 })}
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
        </div>
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
  const estimatedFcr = formData.feedConsumption.totalKg > 0 && formData.currentBiomass.totalKg > 0
    ? 'N/A (insufficient data for accurate calculation)'
    : 'N/A';

  // Simple display FCR if we have both feed and biomass
  const fcrDisplay = formData.feedConsumption.totalKg > 0 && formData.currentBiomass.totalKg > 0
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
          <div className="text-2xl font-bold text-green-600">{formatWeight(formData.currentBiomass.totalKg)}</div>
          <div className="text-xs text-gray-500">Total Biomass</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-red-600">{formatNumber(formData.mortality.totalCount)}</div>
          <div className="text-xs text-gray-500">Total Mortality</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-orange-600">{formatWeight(formData.feedConsumption.totalKg)}</div>
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
              <div key={i} className="flex items-center justify-between text-sm bg-indigo-50 rounded p-2">
                <div>
                  <span className="text-gray-700">{s.speciesName || 'Unknown'}</span>
                  {s.date && <span className="text-gray-400 ml-2 text-xs">{s.date}</span>}
                </div>
                <div className="text-right">
                  <span className="font-medium text-indigo-700">{formatNumber(s.quantity)} fish</span>
                  {s.avgWeightG > 0 && <span className="text-gray-500 ml-2">({s.avgWeightG.toFixed(0)}g avg)</span>}
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
              <div key={i} className="flex items-center justify-between text-sm bg-red-50 rounded p-2">
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
              <div key={i} className="flex items-center justify-between text-sm bg-orange-50 rounded p-2">
                <div>
                  <span className="text-gray-700">{f.feedName || 'Unknown'}</span>
                  {f.brandName && <span className="text-gray-400 ml-2 text-xs">({f.brandName})</span>}
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
                  <div key={i} className="flex items-center justify-between text-sm bg-blue-50 rounded p-2">
                    <div>
                      <span className="text-gray-700">{t.speciesName || 'Unknown'}</span>
                      {t.fromToSite && <span className="text-gray-400 ml-2 text-xs">from {t.fromToSite}</span>}
                    </div>
                    <div className="text-right">
                      <span className="font-medium text-blue-700">{formatNumber(t.quantity)} fish</span>
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
                  <div key={i} className="flex items-center justify-between text-sm bg-purple-50 rounded p-2">
                    <div>
                      <span className="text-gray-700">{t.speciesName || 'Unknown'}</span>
                      {t.fromToSite && <span className="text-gray-400 ml-2 text-xs">to {t.fromToSite}</span>}
                    </div>
                    <div className="text-right">
                      <span className="font-medium text-purple-700">{formatNumber(t.quantity)} fish</span>
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
          <span className="font-medium">Note on Estimated FCR:</span> The displayed FCR is a simplified ratio
          (total feed / current biomass). Accurate FCR requires: total feed consumed / (current biomass - initial biomass + harvested biomass + mortality biomass).
          Please verify with your production records.
        </p>
      </div>

      {/* Submission Notice */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <p className="text-sm text-gray-600">
          By submitting this report, you confirm that the data is accurate and complete.
          This report will be submitted to Fiskeridirektoratet.
        </p>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const BiomassReportTab: React.FC<BiomassReportTabProps> = ({ siteId }) => {
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [selectedReport, setSelectedReport] = useState<BiomassReport | null>(null);
  const [formData, setFormData] = useState<BiomassFormData>(getInitialFormData());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'all'>('all');

  // Fetch active tanks for auto-populate
  const { data: tanksData } = useTanksList({ isActive: true });
  const tanks = tanksData?.items || [];

  // Regulatory settings (pre-populates contact info; biomass submission API TBD)
  const { data: regulatorySettings } = useRegulatorySettings();

  // Filter reports
  const reports = useMemo(() => {
    let filtered = siteId
      ? mockBiomassReports.filter((r) => r.siteId === siteId)
      : mockBiomassReports;

    if (statusFilter !== 'all') {
      filtered = filtered.filter((r) => r.status === statusFilter);
    }

    return filtered.sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    });
  }, [siteId, statusFilter]);

  // Stats
  const stats = useMemo(() => {
    const totalBiomass = mockBiomassReports.reduce((sum, r) => sum + r.currentBiomass.totalKg, 0);
    const totalMortality = mockBiomassReports.reduce((sum, r) => sum + r.mortality.totalCount, 0);
    const pending = mockBiomassReports.filter((r) => r.status === 'pending' || r.status === 'overdue').length;
    return { totalBiomass, totalMortality, pending, total: mockBiomassReports.length };
  }, []);

  // Form handlers
  const handleFormChange = useCallback((updates: Partial<BiomassFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleOpenWizard = useCallback((report?: BiomassReport) => {
    if (report) {
      setFormData({
        month: report.month,
        year: report.year,
        currentBiomass: { ...report.currentBiomass },
        stockings: [],
        mortality: { ...report.mortality },
        slaughter: { ...report.slaughter },
        transfers: [],
        feedConsumption: { ...report.feedConsumption },
        biomassLoadedFromSystem: false,
        feedLoadedFromSystem: false,
      });
    } else {
      const initialData = getInitialFormData();

      // Auto-populate from tanks if available
      if (tanks.length > 0) {
        const biomassAggregated = aggregateBiomassFromTanks(tanks);
        if (biomassAggregated.bySpecies.length > 0) {
          initialData.currentBiomass = {
            bySpecies: biomassAggregated.bySpecies,
            totalKg: biomassAggregated.totalKg,
          };
          initialData.biomassLoadedFromSystem = true;

          // Pre-populate mortality total if available
          if (biomassAggregated.totalMortality > 0) {
            initialData.mortality = {
              totalCount: biomassAggregated.totalMortality,
              byCause: [{ cause: 'Unknown', count: biomassAggregated.totalMortality }],
              details: [],
            };
          }
        }

        const feedAggregated = aggregateFeedFromTanks(tanks);
        if (feedAggregated.byFeedType.length > 0) {
          initialData.feedConsumption = {
            byFeedType: feedAggregated.byFeedType,
            totalKg: feedAggregated.totalKg,
          };
          initialData.feedLoadedFromSystem = true;
        }
      }

      setFormData(initialData);
    }
    setIsWizardOpen(true);
  }, [tanks]);

  const createReportMutation = useMutation({
    mutationFn: async (payload: { input: Record<string, unknown> }) => {
      return graphqlClient.request(CREATE_BIOMASS_REPORT_MUTATION, payload);
    },
  });

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      if (!siteId) {
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
        siteId,
        reportMonth: formData.month + 1,
        reportYear: formData.year,
        submit: true,
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
      setIsWizardOpen(false);
      setFormData(getInitialFormData());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, siteId, createReportMutation]);

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
            siteName={selectedReport?.siteName || 'Default Site'}
          />
        ),
      },
      {
        id: 'biomass',
        title: 'Biomass',
        description: 'Current stock levels',
        content: <BiomassStep formData={formData} onChange={handleFormChange} tanks={tanks} />,
        isValid: () => formData.currentBiomass.bySpecies.length > 0,
      },
      {
        id: 'stockings',
        title: 'Stockings',
        description: 'Fish arrivals',
        content: <StockingStep formData={formData} onChange={handleFormChange} />,
      },
      {
        id: 'mortality',
        title: 'Mortality',
        description: 'Fish losses by cause',
        content: <MortalityStep formData={formData} onChange={handleFormChange} tanks={tanks} />,
      },
      {
        id: 'feed',
        title: 'Feed',
        description: 'Feed consumption data',
        content: <FeedStep formData={formData} onChange={handleFormChange} tanks={tanks} />,
        isValid: () => formData.feedConsumption.totalKg > 0,
      },
      {
        id: 'transfers',
        title: 'Transfers',
        description: 'Fish movements in/out',
        content: <TransfersStep formData={formData} onChange={handleFormChange} />,
      },
      {
        id: 'review',
        title: 'Review',
        description: 'Verify and submit',
        content: <ReviewStep formData={formData} siteName={selectedReport?.siteName || 'Default Site'} />,
      },
    ],
    [formData, handleFormChange, selectedReport, tanks]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Biomass Reports</h2>
          <p className="text-sm text-gray-500">Monthly reports for Fiskeridirektoratet - Due 7th of each month</p>
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

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
          <div className="text-sm text-gray-500">Total Reports</div>
        </div>
        <div className="bg-white rounded-lg border border-green-200 p-4">
          <div className="text-2xl font-bold text-green-600">{formatWeight(stats.totalBiomass)}</div>
          <div className="text-sm text-gray-500">Total Biomass</div>
        </div>
        <div className="bg-white rounded-lg border border-red-200 p-4">
          <div className="text-2xl font-bold text-red-600">{formatNumber(stats.totalMortality)}</div>
          <div className="text-sm text-gray-500">Total Mortality</div>
        </div>
        <div className="bg-white rounded-lg border border-yellow-200 p-4">
          <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
          <div className="text-sm text-gray-500">Pending</div>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500">Filter:</span>
        {(['all', 'pending', 'submitted', 'approved'] as const).map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`px-3 py-1.5 text-sm rounded-md ${
              statusFilter === status
                ? 'bg-blue-100 text-blue-700'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {/* Reports Grid */}
      {reports.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No reports found</p>
          <button
            onClick={() => handleOpenWizard()}
            className="mt-4 px-4 py-2 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
          >
            Create First Report
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {reports.map((report) => (
            <BiomassReportCard
              key={report.id}
              report={report}
              onView={() => setSelectedReport(report)}
              onEdit={() => {
                setSelectedReport(report);
                handleOpenWizard(report);
              }}
            />
          ))}
        </div>
      )}

      {/* Wizard Modal */}
      <ReportWizard
        isOpen={isWizardOpen}
        onClose={() => {
          setIsWizardOpen(false);
          setSelectedReport(null);
          setFormData(getInitialFormData());
        }}
        onSubmit={handleSubmit}
        title="Biomass Report"
        subtitle={`Monthly report - ${getMonthLabel(formData.month, formData.year)}`}
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

export default BiomassReportTab;
