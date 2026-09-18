/**
 * Cleaner Fish Report Tab
 * Monthly rensefisk reports
 * Due 7th of each month
 *
 * Full Mattilsynet compliance:
 * - Per-cage (produksjonsenheter) breakdown
 * - Detailed mortality/removal categories (RensefiskUttak)
 * - Feed consumption (torrforKg / vatforKg)
 * - Species code mapping (USB, BER, GRO, BNB)
 */
import React, { useState, useMemo, useCallback } from 'react';
import {
  useRegulatorySettings,
  useSubmitCleanerFishReport,
} from '../../../hooks/useRegulatory';
import type { SubmitCleanerFishReportInput, ReportSubmissionResult } from '../../../hooks/useRegulatory';
import {
  CleanerFishSpecies,
  CleanerFishSpeciesCount,
  CleanerFishDeployment,
  CleanerFishArtskode,
} from '../types/reports.types';
import { ReportWizard, ReportWizardStep } from '../components/wizard/ReportWizard';
import { SubmissionHistorySection } from '../components/SubmissionHistorySection';
import { useStableClientReference } from '../../../hooks/useStableClientReference';
import { useEffectiveReportSite } from '../hooks/useEffectiveReportSite';
import { SiteLocalitySelector } from '../components/SiteLocalitySelector';
import { buildRegulatoryIdentity } from '../utils/regulatoryIdentity';
import { toBackendReportMonth } from '../utils/reportPeriod';
import { useTanksList, Tank } from '../../../hooks/useTanks';

// ============================================================================
// Types
// ============================================================================

interface CleanerFishReportTabProps {
  siteId?: string;
}

/** Detailed mortality/removal breakdown per species (Mattilsynet RensefiskUttak) */
interface DetailedMortalityEntry {
  disease: number;              // avlivetSykdom
  injuries: number;             // avlivetSkader
  emaciation: number;           // avlivetAvmagret
  preHandling: number;          // avlivetForestaendeHaandtering
  unfavorableEnvironment: number; // avlivetUgunstigLevemiljo
  naturalDeaths: number;        // selvdod
  transferredOut: number;       // flyttetUt
  unaccounted: number;          // kanIkkeGjoresRedeFor
}

/** Per-cage breakdown row */
interface PerCageEntry {
  tankId: string;
  tankName: string;
  tankCode: string;
  species: CleanerFishSpecies;
  openingStock: number;   // beholdningVedForrigeMaanedsslutt
  added: number;          // utsett.antallNy
  closingStock: number;   // current quantity from system
}

interface CleanerFishFormData {
  month: number;
  year: number;
  fishBySpecies: CleanerFishSpeciesCount[];
  totalCount: number;
  mortality: {
    bySpecies: { species: CleanerFishSpecies; count: number; rate: number }[];
    totalCount: number;
    overallRate: number;
  };
  deployments: CleanerFishDeployment[];
  perCageData: PerCageEntry[];
  detailedMortality: Record<CleanerFishSpecies, DetailedMortalityEntry>;
  feedConsumption: {
    dryFeedKg: number;
    wetFeedKg: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

const CLEANER_FISH_SPECIES: { value: CleanerFishSpecies; label: string; norwegian: string; mattilsynetCode: CleanerFishArtskode }[] = [
  { value: 'lumpfish', label: 'Lumpfish', norwegian: 'Rognkjeks', mattilsynetCode: 'USB' },
  { value: 'ballan_wrasse', label: 'Ballan Wrasse', norwegian: 'Berggylt', mattilsynetCode: 'BER' },
  { value: 'corkwing_wrasse', label: 'Corkwing Wrasse', norwegian: 'Gronngylt', mattilsynetCode: 'GRO' },
  { value: 'goldsinny_wrasse', label: 'Goldsinny Wrasse', norwegian: 'Bergnebb', mattilsynetCode: 'BNB' },
];

const MORTALITY_CATEGORIES: { key: keyof DetailedMortalityEntry; label: string; norwegian: string }[] = [
  { key: 'disease', label: 'Euthanized - Disease', norwegian: 'avlivetSykdom' },
  { key: 'injuries', label: 'Euthanized - Injuries', norwegian: 'avlivetSkader' },
  { key: 'emaciation', label: 'Euthanized - Emaciation', norwegian: 'avlivetAvmagret' },
  { key: 'preHandling', label: 'Euthanized - Pre-handling', norwegian: 'avlivetForestaendeHaandtering' },
  { key: 'unfavorableEnvironment', label: 'Euthanized - Unfavorable env.', norwegian: 'avlivetUgunstigLevemiljo' },
  { key: 'naturalDeaths', label: 'Natural Deaths', norwegian: 'selvdod' },
  { key: 'transferredOut', label: 'Transferred Out', norwegian: 'flyttetUt' },
  { key: 'unaccounted', label: 'Unaccounted', norwegian: 'kanIkkeGjoresRedeFor' },
];

function emptyDetailedMortality(): DetailedMortalityEntry {
  return {
    disease: 0,
    injuries: 0,
    emaciation: 0,
    preHandling: 0,
    unfavorableEnvironment: 0,
    naturalDeaths: 0,
    transferredOut: 0,
    unaccounted: 0,
  };
}

function getDefaultDetailedMortality(): Record<CleanerFishSpecies, DetailedMortalityEntry> {
  return {
    lumpfish: emptyDetailedMortality(),
    ballan_wrasse: emptyDetailedMortality(),
    corkwing_wrasse: emptyDetailedMortality(),
    goldsinny_wrasse: emptyDetailedMortality(),
  };
}

function sumDetailedMortality(entry: DetailedMortalityEntry): number {
  return entry.disease + entry.injuries + entry.emaciation + entry.preHandling
    + entry.unfavorableEnvironment + entry.naturalDeaths + entry.transferredOut + entry.unaccounted;
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

function getMonthLabel(month: number, year: number): string {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${monthNames[month]} ${year}`;
}

function formatNumber(num: number): string {
  return num.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

function getSpeciesLabel(species: CleanerFishSpecies): string {
  return CLEANER_FISH_SPECIES.find((s) => s.value === species)?.label || species;
}

function getSpeciesNorwegian(species: CleanerFishSpecies): string {
  return CLEANER_FISH_SPECIES.find((s) => s.value === species)?.norwegian || '';
}

function getSpeciesMattilsynetCode(species: CleanerFishSpecies): CleanerFishArtskode {
  return CLEANER_FISH_SPECIES.find((s) => s.value === species)?.mattilsynetCode || 'USB';
}

interface TankOption {
  id: string;
  name: string;
  code: string;
}

/**
 * Map cleaner fish species names from tank data to report species codes
 */
function mapSpeciesNameToCode(name: string): CleanerFishSpecies | null {
  const lower = name.toLowerCase();
  if (lower.includes('lumpfish') || lower.includes('rognkjeks')) return 'lumpfish';
  if (lower.includes('ballan') || lower.includes('berggylt')) return 'ballan_wrasse';
  if (lower.includes('corkwing') || lower.includes('gronngylt') || lower.includes('grønngylt')) return 'corkwing_wrasse';
  if (lower.includes('goldsinny') || lower.includes('bergnebb')) return 'goldsinny_wrasse';
  // Fallback for generic wrasse
  if (lower.includes('wrasse') || lower.includes('leppefisk')) return 'ballan_wrasse';
  return null;
}

/**
 * Aggregate cleaner fish inventory from all tanks
 */
function aggregateCleanerFishFromTanks(tanks: readonly Tank[]): {
  fishBySpecies: CleanerFishSpeciesCount[];
  totalCount: number;
  mortalityBySpecies: { species: CleanerFishSpecies; count: number; rate: number }[];
  totalMortality: number;
} {
  const speciesMap = new Map<CleanerFishSpecies, {
    count: number;
    source: 'farmed' | 'wild_caught';
    mortality: number;
    initialQuantity: number;
  }>();

  for (const tank of tanks) {
    const details = tank.batchMetrics?.cleanerFishDetails;
    if (!details || details.length === 0) continue;

    for (const detail of details) {
      const speciesCode = mapSpeciesNameToCode(detail.speciesName || '');
      if (!speciesCode) continue;

      const existing = speciesMap.get(speciesCode) || {
        count: 0,
        source: (detail.sourceType as 'farmed' | 'wild_caught') || 'farmed',
        mortality: 0,
        initialQuantity: 0,
      };

      existing.count += detail.quantity || 0;
      existing.mortality += detail.totalMortality || 0;
      existing.initialQuantity += detail.initialQuantity || 0;
      // Use sourceType from the first batch encountered
      if (detail.sourceType) {
        existing.source = detail.sourceType as 'farmed' | 'wild_caught';
      }
      speciesMap.set(speciesCode, existing);
    }
  }

  const fishBySpecies: CleanerFishSpeciesCount[] = [];
  const mortalityBySpecies: { species: CleanerFishSpecies; count: number; rate: number }[] = [];
  let totalCount = 0;
  let totalMortality = 0;

  for (const [species, data] of speciesMap.entries()) {
    fishBySpecies.push({
      species,
      norwegianName: getSpeciesNorwegian(species),
      count: data.count,
      source: data.source,
    });
    totalCount += data.count;

    if (data.mortality > 0) {
      const rate = data.count > 0 ? (data.mortality / (data.count + data.mortality)) * 100 : 0;
      mortalityBySpecies.push({ species, count: data.mortality, rate });
      totalMortality += data.mortality;
    }
  }

  return { fishBySpecies, totalCount, mortalityBySpecies, totalMortality };
}

/**
 * Build per-cage data from tanks that have cleaner fish
 */
function buildPerCageDataFromTanks(tanks: readonly Tank[]): PerCageEntry[] {
  const entries: PerCageEntry[] = [];

  for (const tank of tanks) {
    const details = tank.batchMetrics?.cleanerFishDetails;
    if (!details || details.length === 0) continue;

    for (const detail of details) {
      const speciesCode = mapSpeciesNameToCode(detail.speciesName || '');
      if (!speciesCode) continue;

      entries.push({
        tankId: tank.id,
        tankName: tank.name,
        tankCode: tank.code,
        species: speciesCode,
        openingStock: 0, // Default 0 for first report; user can edit
        added: 0,
        closingStock: detail.quantity || 0,
      });
    }
  }

  return entries;
}

function getInitialFormData(): CleanerFishFormData {
  const now = new Date();
  const prevMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  return {
    month: prevMonth,
    year,
    fishBySpecies: [],
    totalCount: 0,
    mortality: { bySpecies: [], totalCount: 0, overallRate: 0 },
    deployments: [],
    perCageData: [],
    detailedMortality: getDefaultDetailedMortality(),
    feedConsumption: { dryFeedKg: 0, wetFeedKg: 0 },
  };
}

// ============================================================================
// Wizard Step Components
// ============================================================================

interface InventoryStepProps {
  formData: CleanerFishFormData;
  onChange: (data: Partial<CleanerFishFormData>) => void;
  tanks?: readonly Tank[];
}

const InventoryStep: React.FC<InventoryStepProps> = ({ formData, onChange, tanks }) => {
  const handleLoadFromSystem = () => {
    if (!tanks || tanks.length === 0) return;
    const aggregated = aggregateCleanerFishFromTanks(tanks);

    // Also set mortality data from system
    const overallRate = aggregated.totalCount > 0
      ? (aggregated.totalMortality / (aggregated.totalCount + aggregated.totalMortality)) * 100
      : 0;

    // Build per-cage data
    const perCageData = buildPerCageDataFromTanks(tanks);

    onChange({
      fishBySpecies: aggregated.fishBySpecies,
      totalCount: aggregated.totalCount,
      mortality: {
        bySpecies: aggregated.mortalityBySpecies,
        totalCount: aggregated.totalMortality,
        overallRate,
      },
      perCageData,
    });
  };

  const addSpecies = (species: CleanerFishSpecies) => {
    if (formData.fishBySpecies.some((f) => f.species === species)) return;

    const newSpecies: CleanerFishSpeciesCount = {
      species,
      norwegianName: getSpeciesNorwegian(species),
      count: 0,
      source: 'farmed',
    };
    const fishBySpecies = [...formData.fishBySpecies, newSpecies];
    onChange({
      fishBySpecies,
      totalCount: fishBySpecies.reduce((sum, f) => sum + f.count, 0),
    });
  };

  const updateSpecies = (index: number, updates: Partial<CleanerFishSpeciesCount>) => {
    const fishBySpecies = formData.fishBySpecies.map((f, i) =>
      i === index ? { ...f, ...updates } : f
    );
    onChange({
      fishBySpecies,
      totalCount: fishBySpecies.reduce((sum, f) => sum + f.count, 0),
    });
  };

  const removeSpecies = (index: number) => {
    const fishBySpecies = formData.fishBySpecies.filter((_, i) => i !== index);
    onChange({
      fishBySpecies,
      totalCount: fishBySpecies.reduce((sum, f) => sum + f.count, 0),
    });
  };

  const availableSpecies = CLEANER_FISH_SPECIES.filter(
    (s) => !formData.fishBySpecies.some((f) => f.species === s.value)
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700">Cleaner Fish Inventory</h4>
          <p className="text-xs text-gray-500">Current stock by species</p>
        </div>
        <div className="flex items-center gap-2">
          {tanks && tanks.some(t => (t.batchMetrics?.cleanerFishQuantity || 0) > 0) && (
            <button
              type="button"
              onClick={handleLoadFromSystem}
              className="px-3 py-1.5 text-sm text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Load from Tanks
            </button>
          )}
          {availableSpecies.length > 0 && (
            <select
              onChange={(e) => addSpecies(e.target.value as CleanerFishSpecies)}
              value=""
              className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50 appearance-none cursor-pointer pr-8"
            >
              <option value="">+ Add Species</option>
              {availableSpecies.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label} ({s.norwegian})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Total Summary */}
      <div className="bg-teal-50 border border-teal-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-teal-800">Total Cleaner Fish</span>
          <span className="text-2xl font-bold text-teal-700">
            {formatNumber(formData.totalCount)}
          </span>
        </div>
      </div>

      {formData.fishBySpecies.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No species added</p>
          <p className="text-xs text-gray-400">Select a species to add from the dropdown above</p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.fishBySpecies.map((fish, index) => (
            <div key={fish.species} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <span className="text-sm font-medium text-gray-700">{getSpeciesLabel(fish.species)}</span>
                  <span className="text-xs text-gray-500 ml-2">({fish.norwegianName})</span>
                </div>
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Count</label>
                  <input
                    type="number"
                    min="0"
                    value={fish.count || ''}
                    onChange={(e) => updateSpecies(index, { count: parseInt(e.target.value) || 0 })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Source</label>
                  <select
                    value={fish.source}
                    onChange={(e) => updateSpecies(index, { source: e.target.value as 'wild_caught' | 'farmed' })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  >
                    <option value="farmed">Farmed</option>
                    <option value="wild_caught">Wild Caught</option>
                  </select>
                </div>
                {fish.source === 'wild_caught' && (
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">Capture Location</label>
                    <input
                      type="text"
                      value={fish.sourceLocation || ''}
                      onChange={(e) => updateSpecies(index, { sourceLocation: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      placeholder="Location where fish were caught"
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Detailed Mortality Step
// ============================================================================

interface DetailedMortalityStepProps {
  formData: CleanerFishFormData;
  onChange: (data: Partial<CleanerFishFormData>) => void;
}

const DetailedMortalityStep: React.FC<DetailedMortalityStepProps> = ({ formData, onChange }) => {
  const updateDetailedMortality = (
    species: CleanerFishSpecies,
    key: keyof DetailedMortalityEntry,
    value: number,
  ) => {
    const updated = { ...formData.detailedMortality };
    updated[species] = { ...updated[species], [key]: value };

    // Also recalculate the legacy mortality summary from detailed data
    const bySpecies: { species: CleanerFishSpecies; count: number; rate: number }[] = [];
    let totalCount = 0;

    for (const fish of formData.fishBySpecies) {
      const entry = updated[fish.species];
      if (!entry) continue;
      const speciesTotal = sumDetailedMortality(entry);
      const rate = fish.count > 0 ? (speciesTotal / fish.count) * 100 : 0;
      bySpecies.push({ species: fish.species, count: speciesTotal, rate });
      totalCount += speciesTotal;
    }

    const overallRate = formData.totalCount > 0 ? (totalCount / formData.totalCount) * 100 : 0;

    onChange({
      detailedMortality: updated,
      mortality: { bySpecies, totalCount, overallRate },
    });
  };

  const getSpeciesTotal = (species: CleanerFishSpecies): number => {
    const entry = formData.detailedMortality[species];
    return entry ? sumDetailedMortality(entry) : 0;
  };

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-700">Detailed Mortality / Removal</h4>
        <p className="text-xs text-gray-500">
          Mattilsynet requires categorized removal reasons per species (RensefiskUttak)
        </p>
      </div>

      {/* Overall Summary */}
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-medium text-red-800">Overall Mortality</span>
            <div className="text-xs text-red-600 mt-1">
              {formatNumber(formData.mortality.totalCount)} removals / deaths
            </div>
          </div>
          <span className="text-2xl font-bold text-red-700">
            {formData.mortality.overallRate.toFixed(1)}%
          </span>
        </div>
      </div>

      {formData.fishBySpecies.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <p className="text-sm text-gray-500">Add species inventory first to record mortality</p>
        </div>
      ) : (
        <div className="space-y-4">
          {formData.fishBySpecies.map((fish) => {
            const entry = formData.detailedMortality[fish.species] || emptyDetailedMortality();
            const speciesTotal = getSpeciesTotal(fish.species);
            const rate = fish.count > 0 ? (speciesTotal / fish.count) * 100 : 0;

            return (
              <div key={fish.species} className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="text-sm font-medium text-gray-700">
                      {getSpeciesLabel(fish.species)}
                    </span>
                    <span className="text-xs text-gray-400 ml-2">
                      ({getSpeciesMattilsynetCode(fish.species)})
                    </span>
                    <span className="text-xs text-gray-500 ml-2">
                      Inventory: {formatNumber(fish.count)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-medium text-red-600">
                      {formatNumber(speciesTotal)} total
                    </span>
                    <span className="text-xs text-gray-500 ml-2">
                      ({rate.toFixed(1)}%)
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {MORTALITY_CATEGORIES.map((cat) => (
                    <div key={cat.key}>
                      <label className="block text-xs text-gray-500 mb-1 truncate" title={cat.label}>
                        {cat.label}
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={entry[cat.key] || ''}
                        onChange={(e) =>
                          updateDetailedMortality(fish.species, cat.key, parseInt(e.target.value) || 0)
                        }
                        className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                        placeholder="0"
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Per-Cage Breakdown Step
// ============================================================================

interface PerCageStepProps {
  formData: CleanerFishFormData;
  onChange: (data: Partial<CleanerFishFormData>) => void;
}

const PerCageStep: React.FC<PerCageStepProps> = ({ formData, onChange }) => {
  const updatePerCageEntry = (index: number, updates: Partial<PerCageEntry>) => {
    const perCageData = formData.perCageData.map((entry, i) =>
      i === index ? { ...entry, ...updates } : entry
    );
    onChange({ perCageData });
  };

  const updateFeedConsumption = (field: 'dryFeedKg' | 'wetFeedKg', value: number) => {
    onChange({
      feedConsumption: { ...formData.feedConsumption, [field]: value },
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-700">Per-Cage Breakdown</h4>
        <p className="text-xs text-gray-500">
          Mattilsynet produksjonsenheter - per-cage stock data and feed consumption
        </p>
      </div>

      {/* Feed Consumption */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        <h5 className="text-xs font-medium text-amber-800 uppercase mb-3">Feed Consumption (for period)</h5>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Dry feed - torrforKg</label>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="0.1"
                value={formData.feedConsumption.dryFeedKg || ''}
                onChange={(e) => updateFeedConsumption('dryFeedKg', parseFloat(e.target.value) || 0)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md pr-10"
                placeholder="0"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">kg</span>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Wet feed - vatforKg</label>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="0.1"
                value={formData.feedConsumption.wetFeedKg || ''}
                onChange={(e) => updateFeedConsumption('wetFeedKg', parseFloat(e.target.value) || 0)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md pr-10"
                placeholder="0"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">kg</span>
            </div>
          </div>
        </div>
      </div>

      {/* Per-Cage Table */}
      {formData.perCageData.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <svg className="w-10 h-10 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No per-cage data available</p>
          <p className="text-xs text-gray-400">
            Use "Load from Tanks" in the Inventory step to populate cage data
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-100 text-left">
                <th className="px-3 py-2 text-xs font-medium text-gray-500">Cage (merdId)</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-500">Species</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-500 text-right">Opening Stock</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-500 text-right">Added</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-500 text-right">Closing Stock</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {formData.perCageData.map((entry, index) => (
                <tr key={`${entry.tankId}-${entry.species}-${index}`} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <div className="text-sm font-medium text-gray-700">{entry.tankName}</div>
                    <div className="text-xs text-gray-400">{entry.tankCode}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-sm text-gray-700">{getSpeciesLabel(entry.species)}</span>
                    <span className="text-xs text-gray-400 ml-1">
                      ({getSpeciesMattilsynetCode(entry.species)})
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min="0"
                      value={entry.openingStock || ''}
                      onChange={(e) =>
                        updatePerCageEntry(index, { openingStock: parseInt(e.target.value) || 0 })
                      }
                      className="w-24 ml-auto block px-2 py-1 text-sm text-right border border-gray-300 rounded-md"
                      placeholder="0"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min="0"
                      value={entry.added || ''}
                      onChange={(e) =>
                        updatePerCageEntry(index, { added: parseInt(e.target.value) || 0 })
                      }
                      className="w-24 ml-auto block px-2 py-1 text-sm text-right border border-gray-300 rounded-md"
                      placeholder="0"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="text-sm font-medium text-gray-900">
                      {formatNumber(entry.closingStock)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Deployments Step
// ============================================================================

interface DeploymentsStepProps {
  formData: CleanerFishFormData;
  onChange: (data: Partial<CleanerFishFormData>) => void;
  tankOptions?: TankOption[];
}

const DeploymentsStep: React.FC<DeploymentsStepProps> = ({ formData, onChange, tankOptions }) => {
  const addDeployment = () => {
    const newDeployment: CleanerFishDeployment = {
      id: `dep-${Date.now()}`,
      date: new Date(),
      species: 'lumpfish',
      quantity: 0,
      targetCageId: '',
      targetCageName: '',
    };
    onChange({ deployments: [...formData.deployments, newDeployment] });
  };

  const updateDeployment = (index: number, updates: Partial<CleanerFishDeployment>) => {
    const deployments = formData.deployments.map((d, i) =>
      i === index ? { ...d, ...updates } : d
    );
    onChange({ deployments });
  };

  const removeDeployment = (index: number) => {
    onChange({ deployments: formData.deployments.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700">Deployments to Salmon Cages</h4>
          <p className="text-xs text-gray-500">Record cleaner fish deployments during this period</p>
        </div>
        <button
          type="button"
          onClick={addDeployment}
          className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
        >
          + Add Deployment
        </button>
      </div>

      {formData.deployments.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No deployments recorded</p>
          <p className="text-xs text-gray-400">Click "Add Deployment" to record fish transfers to salmon cages</p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.deployments.map((deployment, index) => (
            <div key={deployment.id} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm font-medium text-gray-700">Deployment #{index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeDeployment(index)}
                  className="text-red-500 hover:text-red-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Date</label>
                  <input
                    type="date"
                    value={deployment.date.toISOString().split('T')[0]}
                    onChange={(e) => updateDeployment(index, { date: new Date(e.target.value) })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Species</label>
                  <select
                    value={deployment.species}
                    onChange={(e) => updateDeployment(index, { species: e.target.value as CleanerFishSpecies })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  >
                    {CLEANER_FISH_SPECIES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                  <input
                    type="number"
                    min="0"
                    value={deployment.quantity || ''}
                    onChange={(e) => updateDeployment(index, { quantity: parseInt(e.target.value) || 0 })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Target Cage/Tank</label>
                  {tankOptions && tankOptions.length > 0 ? (
                    <select
                      value={deployment.targetCageId || ''}
                      onChange={(e) => {
                        const tank = tankOptions.find(t => t.id === e.target.value);
                        updateDeployment(index, {
                          targetCageId: e.target.value,
                          targetCageName: tank ? `${tank.name} (${tank.code})` : '',
                        });
                      }}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    >
                      <option value="">Select tank...</option>
                      {tankOptions.map((t) => (
                        <option key={t.id} value={t.id}>{t.name} ({t.code})</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={deployment.targetCageName}
                      onChange={(e) => updateDeployment(index, { targetCageName: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      placeholder="Cage 1"
                    />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Review Step
// ============================================================================

interface ReviewStepProps {
  formData: CleanerFishFormData;
  siteName: string;
}

const ReviewStep: React.FC<ReviewStepProps> = ({ formData, siteName }) => {
  const totalDeployed = formData.deployments.reduce((sum, d) => sum + d.quantity, 0);

  return (
    <div className="space-y-6">
      {/* Summary Header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-blue-800">Report Summary</h4>
        <p className="text-sm text-blue-600 mt-1">
          {siteName} - {getMonthLabel(formData.month, formData.year)}
        </p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-white border border-gray-200 rounded-lg p-3 text-center">
          <div className="text-xl font-bold text-teal-600">{formatNumber(formData.totalCount)}</div>
          <div className="text-xs text-gray-500">Total Inventory</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-3 text-center">
          <div className="text-xl font-bold text-red-600">{formData.mortality.overallRate.toFixed(1)}%</div>
          <div className="text-xs text-gray-500">Mortality Rate</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-3 text-center">
          <div className="text-xl font-bold text-blue-600">{formatNumber(totalDeployed)}</div>
          <div className="text-xs text-gray-500">Deployed</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-3 text-center">
          <div className="text-xl font-bold text-purple-600">{formData.perCageData.length}</div>
          <div className="text-xs text-gray-500">Cages</div>
        </div>
      </div>

      {/* Species Breakdown with Mattilsynet codes */}
      {formData.fishBySpecies.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Inventory by Species</h5>
          <div className="space-y-2">
            {formData.fishBySpecies.map((fish) => (
              <div key={fish.species} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="px-1.5 py-0.5 text-xs font-mono bg-gray-100 text-gray-600 rounded">
                    {getSpeciesMattilsynetCode(fish.species)}
                  </span>
                  <span className="text-gray-700">{getSpeciesLabel(fish.species)}</span>
                  <span className="text-xs text-gray-400">({getSpeciesNorwegian(fish.species)})</span>
                  <span className={`px-1.5 py-0.5 text-xs rounded ${
                    fish.source === 'farmed' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
                  }`}>
                    {fish.source === 'farmed' ? 'Farmed' : 'Wild'}
                  </span>
                </div>
                <span className="font-medium text-gray-900">{formatNumber(fish.count)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Detailed Mortality Breakdown */}
      {formData.fishBySpecies.length > 0 && formData.mortality.totalCount > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">
            Detailed Mortality / Removal ({formatNumber(formData.mortality.totalCount)} total)
          </h5>
          <div className="space-y-3">
            {formData.fishBySpecies.map((fish) => {
              const entry = formData.detailedMortality[fish.species];
              if (!entry) return null;
              const speciesTotal = sumDetailedMortality(entry);
              if (speciesTotal === 0) return null;

              return (
                <div key={fish.species} className="text-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-gray-700">{getSpeciesLabel(fish.species)}</span>
                    <span className="text-xs font-mono text-gray-400">
                      ({getSpeciesMattilsynetCode(fish.species)})
                    </span>
                    <span className="text-xs text-red-600">- {formatNumber(speciesTotal)} removals</span>
                  </div>
                  <div className="grid grid-cols-4 gap-x-4 gap-y-1 pl-4 text-xs text-gray-600">
                    {MORTALITY_CATEGORIES.map((cat) => {
                      const val = entry[cat.key];
                      if (val === 0) return null;
                      return (
                        <div key={cat.key} className="flex justify-between">
                          <span className="truncate">{cat.label}:</span>
                          <span className="font-medium ml-1">{val}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-Cage Breakdown Summary */}
      {formData.perCageData.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">
            Per-Cage Breakdown ({formData.perCageData.length} entries)
          </h5>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left border-b border-gray-100">
                  <th className="pb-1 text-gray-500 font-medium">Cage</th>
                  <th className="pb-1 text-gray-500 font-medium">Species</th>
                  <th className="pb-1 text-gray-500 font-medium text-right">Opening</th>
                  <th className="pb-1 text-gray-500 font-medium text-right">Added</th>
                  <th className="pb-1 text-gray-500 font-medium text-right">Closing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {formData.perCageData.map((entry, i) => (
                  <tr key={i}>
                    <td className="py-1 text-gray-700">{entry.tankCode}</td>
                    <td className="py-1 text-gray-600">
                      {getSpeciesMattilsynetCode(entry.species)}
                    </td>
                    <td className="py-1 text-right text-gray-700">{formatNumber(entry.openingStock)}</td>
                    <td className="py-1 text-right text-gray-700">{formatNumber(entry.added)}</td>
                    <td className="py-1 text-right font-medium text-gray-900">{formatNumber(entry.closingStock)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Feed Consumption */}
      {(formData.feedConsumption.dryFeedKg > 0 || formData.feedConsumption.wetFeedKg > 0) && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Feed Consumption</h5>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Dry feed (torrforKg)</span>
              <span className="font-medium text-gray-900">{formData.feedConsumption.dryFeedKg.toFixed(1)} kg</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Wet feed (vatforKg)</span>
              <span className="font-medium text-gray-900">{formData.feedConsumption.wetFeedKg.toFixed(1)} kg</span>
            </div>
          </div>
        </div>
      )}

      {/* Deployments */}
      {formData.deployments.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">
            Deployments ({formData.deployments.length})
          </h5>
          <div className="space-y-2">
            {formData.deployments.map((d, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">
                  {formatDate(d.date)} - {getSpeciesLabel(d.species)} → {d.targetCageName || 'N/A'}
                </span>
                <span className="font-medium text-gray-900">{formatNumber(d.quantity)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Submission Notice */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <p className="text-sm text-gray-600">
          By submitting this report, you confirm that the data is accurate and complete.
          This report will be submitted to the Norwegian Food Safety Authority (Mattilsynet)
          via the rensefisk API endpoint.
        </p>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const CleanerFishReportTab: React.FC<CleanerFishReportTabProps> = ({ siteId }) => {
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [formData, setFormData] = useState<CleanerFishFormData>(getInitialFormData());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch tanks with cleaner fish data for auto-population
  const { data: tanksData } = useTanksList({ isActive: true });
  const tanks = tanksData?.items || [];
  const tankOptions: TankOption[] = useMemo(
    () => tanks.map((t) => ({ id: t.id, name: t.name, code: t.code })),
    [tanks]
  );

  // Regulatory settings & submit mutation
  const { data: regulatorySettings } = useRegulatorySettings();
  const submitCleanerFishMutation = useSubmitCleanerFishReport();
  const clientRef = useStableClientReference();
  const { effectiveSiteId, siteMappings, setSelectedSiteId, showSelector } =
    useEffectiveReportSite(siteId);
  const [submissionResult, setSubmissionResult] = useState<ReportSubmissionResult | null>(null);

  // Form handlers
  const handleFormChange = useCallback((updates: Partial<CleanerFishFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleOpenWizard = useCallback(() => {
    // Auto-populate from system data when creating new report
    const initialData = getInitialFormData();

    if (tanks.length > 0) {
      const aggregated = aggregateCleanerFishFromTanks(tanks);
      if (aggregated.totalCount > 0) {
        initialData.fishBySpecies = aggregated.fishBySpecies;
        initialData.totalCount = aggregated.totalCount;
        const overallRate = aggregated.totalCount > 0
          ? (aggregated.totalMortality / (aggregated.totalCount + aggregated.totalMortality)) * 100
          : 0;
        initialData.mortality = {
          bySpecies: aggregated.mortalityBySpecies,
          totalCount: aggregated.totalMortality,
          overallRate,
        };
      }

      // Auto-populate per-cage data
      initialData.perCageData = buildPerCageDataFromTanks(tanks);
    }

    setFormData(initialData);
    setIsWizardOpen(true);
  }, [tanks]);

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);
    setSubmissionResult(null);
    try {
      // FARM-HIGH-128: fail-closed identity — never ship a silent lokalitetsnummer 0.
      const identity = buildRegulatoryIdentity(regulatorySettings, effectiveSiteId ?? '');

      // Map species value to Mattilsynet artskode
      const speciesCodeMap: Record<string, string> = {
        lumpfish: 'USB', ballan_wrasse: 'BER', corkwing_wrasse: 'GRO', goldsinny_wrasse: 'BNB',
      };

      // Group per-cage entries by tankId (each entry is one species in one cage)
      const cageMap = new Map<string, typeof formData.perCageData>();
      formData.perCageData.forEach(cage => {
        const existing = cageMap.get(cage.tankId) || [];
        existing.push(cage);
        cageMap.set(cage.tankId, existing);
      });

      const input: SubmitCleanerFishReportInput = {
        klientReferanse: clientRef.get(),
        organisasjonsnummer: identity.organisasjonsnummer,
        lokalitetsnummer: identity.lokalitetsnummer,
        kontaktperson: identity.kontaktperson,
        rapporteringsmaaned: toBackendReportMonth(formData.month),
        rapporteringsaar: formData.year,
        torrforKg: formData.feedConsumption.dryFeedKg || undefined,
        vatforKg: formData.feedConsumption.wetFeedKg || undefined,
        produksjonsenheter: Array.from(cageMap.entries()).map(([tankId, cageEntries]) => ({
          merdId: cageEntries[0]?.tankName || tankId,
          arter: cageEntries.map(cage => {
            const artskode = speciesCodeMap[cage.species] || 'USB';
            const mort = formData.detailedMortality[cage.species as CleanerFishSpecies] || {} as DetailedMortalityEntry;
            return {
              artskode,
              opprinnelse: 'UKJENT',
              beholdningVedForrigeMaanedsslutt: cage.openingStock,
              utsett: {
                antallFlyttetInn: 0,
                antallNy: cage.added,
              },
              uttak: {
                antallAvlivetSykdom: mort.disease || 0,
                antallAvlivetSkader: mort.injuries || 0,
                antallAvlivetAvmagret: mort.emaciation || 0,
                antallAvlivetForestaendeHaandteringAvLaksen: mort.preHandling || 0,
                antallAvlivetForestaendeUgunstigLevemiljo: mort.unfavorableEnvironment || 0,
                antallAvlivetSkalIkkeBrukes: 0,
                antallSelvdod: mort.naturalDeaths || 0,
                antallFlyttetUt: mort.transferredOut || 0,
                antallKanIkkeGjoresRedeFor: mort.unaccounted || 0,
              },
            };
          }),
        })),
      };

      const result = await submitCleanerFishMutation.mutateAsync(input);
      setSubmissionResult(result);

      if (result.success) {
        // FARM-HIGH-126: rotate the stable client reference only on success.
        clientRef.reset();
        setIsWizardOpen(false);
        setFormData(getInitialFormData());
      } else {
        setError(result.feilmelding || 'Submission failed');
      }
    } catch (err) {
      console.error('Cleaner fish report submission error:', err);
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, regulatorySettings, effectiveSiteId, clientRef, submitCleanerFishMutation]);

  // Wizard steps
  const steps: ReportWizardStep[] = useMemo(
    () => [
      {
        id: 'inventory',
        title: 'Inventory',
        description: 'Current stock by species',
        content: <InventoryStep formData={formData} onChange={handleFormChange} tanks={tanks} />,
        isValid: () => formData.fishBySpecies.length > 0 && formData.totalCount > 0,
      },
      {
        id: 'mortality',
        title: 'Mortality',
        description: 'Detailed removal reasons',
        content: <DetailedMortalityStep formData={formData} onChange={handleFormChange} />,
      },
      {
        id: 'per-cage',
        title: 'Per-Cage',
        description: 'Cage breakdown & feed',
        content: <PerCageStep formData={formData} onChange={handleFormChange} />,
      },
      {
        id: 'deployments',
        title: 'Deployments',
        description: 'Transfers to salmon cages',
        content: <DeploymentsStep formData={formData} onChange={handleFormChange} tankOptions={tankOptions} />,
        optional: true,
      },
      {
        id: 'review',
        title: 'Review',
        description: 'Verify and submit',
        content: <ReviewStep formData={formData} siteName={"Default Site"} />,
      },
    ],
    [formData, handleFormChange, tanks, tankOptions]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Cleaner Fish Reports</h2>
          <p className="text-sm text-gray-500">Monthly rensefisk reports - Due 7th of each month</p>
        </div>
        <div className="flex items-center gap-3">
          <SiteLocalitySelector
            siteMappings={siteMappings}
            effectiveSiteId={effectiveSiteId}
            onChange={setSelectedSiteId}
            show={showSelector}
          />
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
      </div>

      {/* Submission History */}
      <SubmissionHistorySection reportType="CLEANER_FISH" siteId={effectiveSiteId} />

      {/* Wizard Modal */}
      <ReportWizard
        isOpen={isWizardOpen}
        onClose={() => {
          setIsWizardOpen(false);
          setFormData(getInitialFormData());
        }}
        onSubmit={handleSubmit}
        title="Cleaner Fish Report"
        subtitle={`Monthly report - ${getMonthLabel(formData.month, formData.year)}`}
        steps={steps}
        isSubmitting={isSubmitting}
        error={error}
        onClearError={() => setError(null)}
        submitButtonText="Submit Report"
        maxWidth="max-w-3xl"
      />
    </div>
  );
};

export default CleanerFishReportTab;
