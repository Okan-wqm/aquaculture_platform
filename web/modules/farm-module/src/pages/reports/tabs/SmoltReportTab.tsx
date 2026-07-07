/**
 * Smolt Report Tab
 * Monthly settefisk reports for smolt facilities
 * Due 7th of each month
 * Aligned with Norwegian Mattilsynet "settefisk" requirements
 */
import React, { useState, useMemo, useCallback } from 'react';
import { useRegulatorySettings, useSubmitSmoltReport } from '../../../hooks/useRegulatory';
import type { SubmitSmoltReportInput, ReportSubmissionResult } from '../../../hooks/useRegulatory';
import {
  SmoltUnitCount,
  SmoltStageWeight,
  SmoltMortalityUnit,
  TransferRecord,
} from '../types/reports.types';
import { ReportWizard, ReportWizardStep } from '../components/wizard/ReportWizard';
import { SubmissionHistorySection } from '../components/SubmissionHistorySection';
import { useStableClientReference } from '../../../hooks/useStableClientReference';
import { useEffectiveReportSite } from '../hooks/useEffectiveReportSite';
import { useReportPrefill, findFieldMeta, ReportFieldMeta } from '../../../hooks/useReportPrefill';
import { ProvenanceBadge } from '../components/common';
import { SiteLocalitySelector } from '../components/SiteLocalitySelector';
import { buildRegulatoryIdentity } from '../utils/regulatoryIdentity';
import { toBackendReportMonth } from '../utils/reportPeriod';
import { useTanksList } from '../../../hooks/useTanks';
import type { Tank } from '../../../hooks/useTanks';

// ============================================================================
// Types
// ============================================================================

interface SmoltReportTabProps {
  siteId?: string;
}

/** Species codes for Mattilsynet artskode field */
const SPECIES_CODES = [
  { code: 'SAL', label: 'Atlantic Salmon (Atlantisk laks)' },
  { code: 'ORR', label: 'Rainbow Trout (Regnbueørret)' },
  { code: 'ORB', label: 'Brown Trout (Ørret/Brunørret)' },
  { code: 'ROY', label: 'Arctic Char (Røye)' },
] as const;

/** Extended mortality unit with euthanized/natural death split */
interface SmoltMortalityUnitExtended extends SmoltMortalityUnit {
  euthanized: number; // antallAvlivet
  naturalDeaths: number; // antallSelvdød
  externalTransfers: number; // antallFlyttetEksternt
}

/** Extended unit count with species code */
interface SmoltUnitCountExtended extends SmoltUnitCount {
  speciesCode: string; // artskode
}

/** Per-unit shape of the server-assembled settefisk draft (see SettefiskReportAssembler). */
interface SmoltPrefillUnit {
  karId: string;
  artskode: string;
  snittvektGram: number;
  beholdningVedMånedsslutt: number;
  antallAvlivet: number;
  antallSelvdød: number;
  antallFlyttetEksternt: number;
}

interface SmoltFormData {
  month: number;
  year: number;
  facilityType: 'freshwater' | 'land_based';
  fishCounts: {
    byUnit: SmoltUnitCountExtended[];
    total: number;
  };
  averageWeights: {
    overall: number;
    byStage: SmoltStageWeight[];
  };
  mortalityRates: {
    overall: number;
    byUnit: SmoltMortalityUnitExtended[];
  };
  transfers: {
    outgoing: TransferRecord[];
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

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

function getInitialFormData(): SmoltFormData {
  const now = new Date();
  const prevMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  return {
    month: prevMonth,
    year,
    facilityType: 'land_based',
    fishCounts: { byUnit: [], total: 0 },
    averageWeights: { overall: 0, byStage: [] },
    mortalityRates: { overall: 0, byUnit: [] },
    transfers: { outgoing: [] },
  };
}

/** Derive stage from batch data or tank name heuristics */
function deriveStage(tank: Tank): 'fry' | 'parr' | 'smolt' {
  const name = (tank.name || '').toLowerCase();
  if (name.includes('smolt')) return 'smolt';
  if (name.includes('parr')) return 'parr';
  // Default based on weight if available
  const avgWeight = tank.batchMetrics?.avgWeight || 0;
  if (avgWeight >= 60) return 'smolt';
  if (avgWeight >= 5) return 'parr';
  return 'fry';
}

/** Map tank type to unit type */
function mapTankType(tank: Tank): 'tank' | 'raceway' | 'pond' {
  const typeCode = tank.equipmentType?.code?.toLowerCase() || '';
  const typeName = tank.equipmentType?.name?.toLowerCase() || '';
  if (typeCode.includes('raceway') || typeName.includes('raceway')) return 'raceway';
  if (typeCode.includes('pond') || typeName.includes('pond')) return 'pond';
  return 'tank';
}

const STAGES = ['fry', 'parr', 'smolt'] as const;

// ============================================================================
// Wizard Step Components
// ============================================================================

interface BasicInfoStepProps {
  formData: SmoltFormData;
  onChange: (data: Partial<SmoltFormData>) => void;
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
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">Facility Type</label>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => onChange({ facilityType: 'land_based' })}
          className={`p-4 border-2 rounded-lg text-center ${
            formData.facilityType === 'land_based'
              ? 'border-blue-500 bg-blue-50'
              : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <div className="font-medium text-gray-900">Land Based</div>
          <div className="text-sm text-gray-500">RAS or flow-through systems</div>
        </button>
        <button
          type="button"
          onClick={() => onChange({ facilityType: 'freshwater' })}
          className={`p-4 border-2 rounded-lg text-center ${
            formData.facilityType === 'freshwater'
              ? 'border-cyan-500 bg-cyan-50'
              : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <div className="font-medium text-gray-900">Freshwater</div>
          <div className="text-sm text-gray-500">Lake or river-based</div>
        </button>
      </div>
    </div>
  </div>
);

interface FishCountsStepProps {
  formData: SmoltFormData;
  onChange: (data: Partial<SmoltFormData>) => void;
  tanks: Tank[];
  prefillUnits?: SmoltPrefillUnit[];
  unitsMeta?: ReportFieldMeta;
}

const FishCountsStep: React.FC<FishCountsStepProps> = ({
  formData,
  onChange,
  tanks,
  prefillUnits,
  unitsMeta,
}) => {
  const addUnit = () => {
    const newUnit: SmoltUnitCountExtended = {
      unitId: `unit-${Date.now()}`,
      unitName: '',
      unitType: 'tank',
      quantity: 0,
      avgWeightG: 0,
      stage: 'fry',
      speciesCode: 'SAL',
    };
    const byUnit = [...formData.fishCounts.byUnit, newUnit];
    onChange({
      fishCounts: {
        byUnit,
        total: byUnit.reduce((sum, u) => sum + u.quantity, 0),
      },
    });
  };

  const loadFromSystem = () => {
    // Server-assembled draft is the source (plan Phase 1b): per-tank stock,
    // average weight and species come from the batch/tank SSoTs; the local
    // tank list only resolves display ids/types for the form rows.
    if (!prefillUnits || prefillUnits.length === 0) return;

    const byUnit: SmoltUnitCountExtended[] = prefillUnits.map((unit) => {
      const tank = tanks.find((t) => t.code === unit.karId || t.name === unit.karId);
      return {
        unitId: tank?.id ?? unit.karId,
        unitName: tank?.name ?? unit.karId,
        unitType: tank ? mapTankType(tank) : 'tank',
        quantity: unit.beholdningVedMånedsslutt,
        avgWeightG: unit.snittvektGram,
        stage: tank ? deriveStage(tank) : undefined,
        speciesCode: unit.artskode || 'SAL',
      };
    });

    onChange({
      fishCounts: {
        byUnit,
        total: byUnit.reduce((sum, u) => sum + u.quantity, 0),
      },
    });
  };

  const updateUnit = (index: number, updates: Partial<SmoltUnitCountExtended>) => {
    const byUnit = formData.fishCounts.byUnit.map((u, i) =>
      i === index ? { ...u, ...updates } : u,
    );
    onChange({
      fishCounts: {
        byUnit,
        total: byUnit.reduce((sum, u) => sum + u.quantity, 0),
      },
    });
  };

  const removeUnit = (index: number) => {
    const byUnit = formData.fishCounts.byUnit.filter((_, i) => i !== index);
    onChange({
      fishCounts: {
        byUnit,
        total: byUnit.reduce((sum, u) => sum + u.quantity, 0),
      },
    });
  };

  // Build tank options for dropdown (tanks not already used)
  const usedTankIds = new Set(formData.fishCounts.byUnit.map((u) => u.unitId));
  const availableTanks = tanks.filter((t) => !usedTankIds.has(t.id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700 flex items-center gap-2">
            Fish Counts by Unit
            {unitsMeta && <ProvenanceBadge meta={unitsMeta} />}
          </h4>
          <p className="text-xs text-gray-500">
            Record fish in each production unit (Mattilsynet: produksjonsenhet)
          </p>
        </div>
        <div className="flex items-center gap-2">
          {prefillUnits && prefillUnits.length > 0 && (
            <button
              type="button"
              onClick={loadFromSystem}
              className="px-3 py-1.5 text-sm text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 flex items-center gap-1"
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
          <button
            type="button"
            onClick={addUnit}
            className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
          >
            + Add Unit
          </button>
        </div>
      </div>

      {/* Total Summary */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-blue-800">Total Fish Count</span>
          <span className="text-2xl font-bold text-blue-700">
            {formatNumber(formData.fishCounts.total)}
          </span>
        </div>
      </div>

      {formData.fishCounts.byUnit.length === 0 ? (
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
              d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
            />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No units added</p>
          <p className="text-xs text-gray-400">
            {prefillUnits && prefillUnits.length > 0
              ? 'Click "Load from System" to auto-populate from batch records, or "Add Unit" manually'
              : 'Click "Add Unit" to record fish in tanks/raceways'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.fishCounts.byUnit.map((unit, index) => {
            // Check if this unit matches a known tank
            const matchedTank = tanks.find((t) => t.id === unit.unitId);
            const isFromSystem = !!matchedTank;

            return (
              <div key={unit.unitId} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
                <div className="flex items-start justify-between mb-3">
                  <span className="text-sm font-medium text-gray-700">Unit #{index + 1}</span>
                  <button
                    type="button"
                    onClick={() => removeUnit(index)}
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
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Unit Name / Tank</label>
                    {tanks.length > 0 ? (
                      <select
                        value={isFromSystem ? unit.unitId : '__manual__'}
                        onChange={(e) => {
                          if (e.target.value === '__manual__') {
                            updateUnit(index, { unitId: `unit-${Date.now()}`, unitName: '' });
                          } else {
                            const tank = tanks.find((t) => t.id === e.target.value);
                            if (tank) {
                              updateUnit(index, {
                                unitId: tank.id,
                                unitName: tank.name,
                                unitType: mapTankType(tank),
                                quantity: tank.batchMetrics?.pieces || unit.quantity,
                                avgWeightG: tank.batchMetrics?.avgWeight || unit.avgWeightG,
                                stage: deriveStage(tank),
                                speciesCode:
                                  tank.batchMetrics?.speciesCode ||
                                  (unit as SmoltUnitCountExtended).speciesCode ||
                                  'SAL',
                              });
                            }
                          }
                        }}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      >
                        <option value="__manual__">-- Manual entry --</option>
                        {tanks.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}{' '}
                            {t.batchMetrics?.pieces
                              ? `(${formatNumber(t.batchMetrics.pieces)} fish)`
                              : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={unit.unitName}
                        onChange={(e) => updateUnit(index, { unitName: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                        placeholder="Tank A1"
                      />
                    )}
                    {!isFromSystem && tanks.length > 0 && (
                      <input
                        type="text"
                        value={unit.unitName}
                        onChange={(e) => updateUnit(index, { unitName: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md mt-1"
                        placeholder="Enter unit name"
                      />
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Type</label>
                    <select
                      value={unit.unitType}
                      onChange={(e) =>
                        updateUnit(index, {
                          unitType: e.target.value as 'tank' | 'raceway' | 'pond',
                        })
                      }
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    >
                      <option value="tank">Tank</option>
                      <option value="raceway">Raceway</option>
                      <option value="pond">Pond</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">
                      Species Code (artskode)
                    </label>
                    <select
                      value={(unit as SmoltUnitCountExtended).speciesCode || 'SAL'}
                      onChange={(e) => updateUnit(index, { speciesCode: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    >
                      {SPECIES_CODES.map((sp) => (
                        <option key={sp.code} value={sp.code}>
                          {sp.code} - {sp.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Stage</label>
                    <select
                      value={unit.stage}
                      onChange={(e) =>
                        updateUnit(index, { stage: e.target.value as 'fry' | 'parr' | 'smolt' })
                      }
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    >
                      <option value="fry">Fry</option>
                      <option value="parr">Parr</option>
                      <option value="smolt">Smolt</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Fish Count</label>
                    <input
                      type="number"
                      min="0"
                      value={unit.quantity || ''}
                      onChange={(e) =>
                        updateUnit(index, { quantity: parseInt(e.target.value) || 0 })
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
                      value={unit.avgWeightG || ''}
                      onChange={(e) =>
                        updateUnit(index, { avgWeightG: parseFloat(e.target.value) || 0 })
                      }
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

interface MortalityStepProps {
  formData: SmoltFormData;
  onChange: (data: Partial<SmoltFormData>) => void;
}

const MortalityStep: React.FC<MortalityStepProps> = ({ formData, onChange }) => {
  // Calculate from unit data
  const calculateMortality = () => {
    if (formData.fishCounts.byUnit.length === 0) return;

    const byUnit: SmoltMortalityUnitExtended[] = formData.fishCounts.byUnit.map((unit) => ({
      unitId: unit.unitId,
      unitName: unit.unitName,
      rate: 0,
      count: 0,
      euthanized: 0,
      naturalDeaths: 0,
      externalTransfers: 0,
    }));

    onChange({
      mortalityRates: {
        byUnit,
        overall: 0,
      },
    });
  };

  const updateMortality = (index: number, updates: Partial<SmoltMortalityUnitExtended>) => {
    const byUnit = formData.mortalityRates.byUnit.map((m, i) => {
      if (i !== index) return m;
      const updated = { ...m, ...updates } as SmoltMortalityUnitExtended;
      // Auto-calculate total count from euthanized + natural deaths
      updated.count = (updated.euthanized || 0) + (updated.naturalDeaths || 0);
      // FIX: Calculate per-unit rate
      const unitData = formData.fishCounts.byUnit[i];
      if (unitData && unitData.quantity > 0) {
        updated.rate = (updated.count / unitData.quantity) * 100;
      } else {
        updated.rate = 0;
      }
      return updated;
    });

    const totalCount = byUnit.reduce((sum, m) => sum + m.count, 0);
    const totalFish = formData.fishCounts.total;
    const overall = totalFish > 0 ? (totalCount / totalFish) * 100 : 0;

    onChange({
      mortalityRates: {
        byUnit,
        overall,
      },
    });
  };

  // Sync units if needed
  React.useEffect(() => {
    if (formData.fishCounts.byUnit.length > 0 && formData.mortalityRates.byUnit.length === 0) {
      calculateMortality();
    }
  }, [formData.fishCounts.byUnit.length]);

  const totalEuthanized = formData.mortalityRates.byUnit.reduce(
    (sum, m) => sum + ((m as SmoltMortalityUnitExtended).euthanized || 0),
    0,
  );
  const totalNaturalDeaths = formData.mortalityRates.byUnit.reduce(
    (sum, m) => sum + ((m as SmoltMortalityUnitExtended).naturalDeaths || 0),
    0,
  );
  const totalExternalTransfers = formData.mortalityRates.byUnit.reduce(
    (sum, m) => sum + ((m as SmoltMortalityUnitExtended).externalTransfers || 0),
    0,
  );

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-700">Mortality and Transfers by Unit</h4>
        <p className="text-xs text-gray-500">
          Mattilsynet requires separate counts for euthanized (avlivet) and natural deaths
          (selvdod), plus external transfers
        </p>
      </div>

      {/* Overall Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <div className="text-xs text-red-600 font-medium">Overall Mortality</div>
          <div className="text-xl font-bold text-red-700">
            {formData.mortalityRates.overall.toFixed(2)}%
          </div>
        </div>
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
          <div className="text-xs text-orange-600 font-medium">Euthanized (avlivet)</div>
          <div className="text-xl font-bold text-orange-700">{formatNumber(totalEuthanized)}</div>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <div className="text-xs text-red-600 font-medium">Natural Deaths (selvdod)</div>
          <div className="text-xl font-bold text-red-700">{formatNumber(totalNaturalDeaths)}</div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="text-xs text-blue-600 font-medium">External Transfers</div>
          <div className="text-xl font-bold text-blue-700">
            {formatNumber(totalExternalTransfers)}
          </div>
        </div>
      </div>

      {formData.mortalityRates.byUnit.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <p className="text-sm text-gray-500">Add fish counts first to record mortality by unit</p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.mortalityRates.byUnit.map((mort, index) => {
            const ext = mort as SmoltMortalityUnitExtended;
            const unitData = formData.fishCounts.byUnit[index];
            return (
              <div key={mort.unitId} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="text-sm font-medium text-gray-700">
                      {mort.unitName || `Unit ${index + 1}`}
                    </span>
                    {unitData && (
                      <span className="ml-2 text-xs text-gray-400">
                        ({formatNumber(unitData.quantity)} fish)
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-gray-500">Rate: </span>
                    <span
                      className={`font-medium text-sm ${mort.rate > 1 ? 'text-red-600' : 'text-gray-700'}`}
                    >
                      {mort.rate.toFixed(2)}%
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Euthanized (avlivet)</label>
                    <input
                      type="number"
                      min="0"
                      value={ext.euthanized || ''}
                      onChange={(e) =>
                        updateMortality(index, { euthanized: parseInt(e.target.value) || 0 })
                      }
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">
                      Natural Deaths (selvdod)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={ext.naturalDeaths || ''}
                      onChange={(e) =>
                        updateMortality(index, { naturalDeaths: parseInt(e.target.value) || 0 })
                      }
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Total Dead</label>
                    <div className="w-full px-2 py-1.5 text-sm bg-gray-100 border border-gray-200 rounded-md text-gray-700 font-medium">
                      {formatNumber(mort.count)}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">External Transfers</label>
                    <input
                      type="number"
                      min="0"
                      value={ext.externalTransfers || ''}
                      onChange={(e) =>
                        updateMortality(index, { externalTransfers: parseInt(e.target.value) || 0 })
                      }
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

interface ReviewStepProps {
  formData: SmoltFormData;
  siteName: string;
}

const ReviewStep: React.FC<ReviewStepProps> = ({ formData, siteName }) => {
  // Calculate stage totals
  const stageTotals = STAGES.map((stage) => ({
    stage,
    quantity: formData.fishCounts.byUnit
      .filter((u) => u.stage === stage)
      .reduce((sum, u) => sum + u.quantity, 0),
  })).filter((s) => s.quantity > 0);

  // Totals for mortality breakdown
  const totalEuthanized = formData.mortalityRates.byUnit.reduce(
    (sum, m) => sum + ((m as SmoltMortalityUnitExtended).euthanized || 0),
    0,
  );
  const totalNaturalDeaths = formData.mortalityRates.byUnit.reduce(
    (sum, m) => sum + ((m as SmoltMortalityUnitExtended).naturalDeaths || 0),
    0,
  );
  const totalExternalTransfers = formData.mortalityRates.byUnit.reduce(
    (sum, m) => sum + ((m as SmoltMortalityUnitExtended).externalTransfers || 0),
    0,
  );

  return (
    <div className="space-y-6">
      {/* Summary Header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-blue-800">Report Summary</h4>
        <p className="text-sm text-blue-600 mt-1">
          {siteName} - {getMonthLabel(formData.month, formData.year)}
        </p>
        <span
          className={`inline-block mt-2 px-2 py-0.5 text-xs font-medium rounded ${
            formData.facilityType === 'land_based'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-cyan-100 text-cyan-700'
          }`}
        >
          {formData.facilityType === 'land_based' ? 'Land Based Facility' : 'Freshwater Facility'}
        </span>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">
            {formatNumber(formData.fishCounts.total)}
          </div>
          <div className="text-xs text-gray-500">Total Fish</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-green-600">
            {formData.averageWeights.overall.toFixed(1)}g
          </div>
          <div className="text-xs text-gray-500">Avg Weight</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-red-600">
            {formData.mortalityRates.overall.toFixed(2)}%
          </div>
          <div className="text-xs text-gray-500">Mortality Rate</div>
        </div>
      </div>

      {/* Mortality Breakdown (Mattilsynet) */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">
          Mortality Breakdown (Mattilsynet)
        </h5>
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-2 bg-orange-50 rounded">
            <div className="text-lg font-bold text-orange-700">{formatNumber(totalEuthanized)}</div>
            <div className="text-xs text-gray-500">Euthanized (avlivet)</div>
          </div>
          <div className="text-center p-2 bg-red-50 rounded">
            <div className="text-lg font-bold text-red-700">{formatNumber(totalNaturalDeaths)}</div>
            <div className="text-xs text-gray-500">Natural Deaths (selvdod)</div>
          </div>
          <div className="text-center p-2 bg-blue-50 rounded">
            <div className="text-lg font-bold text-blue-700">
              {formatNumber(totalExternalTransfers)}
            </div>
            <div className="text-xs text-gray-500">External Transfers</div>
          </div>
        </div>
      </div>

      {/* Stage Breakdown */}
      {stageTotals.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Fish by Stage</h5>
          <div className="grid grid-cols-3 gap-4">
            {stageTotals.map((s) => (
              <div key={s.stage} className="text-center p-2 bg-gray-50 rounded">
                <div className="text-lg font-bold text-gray-900">{formatNumber(s.quantity)}</div>
                <div className="text-xs text-gray-500 capitalize">{s.stage}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unit Summary with species codes, mortality rates, and transfers */}
      {formData.fishCounts.byUnit.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">
            Production Units ({formData.fishCounts.byUnit.length})
          </h5>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 font-medium pb-1 border-b border-gray-100">
              <div className="col-span-3">Unit</div>
              <div className="col-span-1">Species</div>
              <div className="col-span-2 text-right">Fish Count</div>
              <div className="col-span-1 text-right">Wt (g)</div>
              <div className="col-span-1 text-right">Euth.</div>
              <div className="col-span-1 text-right">Nat.D</div>
              <div className="col-span-1 text-right">Transf.</div>
              <div className="col-span-2 text-right">Mort %</div>
            </div>
            {formData.fishCounts.byUnit.map((unit, i) => {
              const mort = formData.mortalityRates.byUnit[i] as
                | SmoltMortalityUnitExtended
                | undefined;
              const ext = unit as SmoltUnitCountExtended;
              return (
                <div key={i} className="grid grid-cols-12 gap-2 text-sm items-center">
                  <div className="col-span-3 text-gray-700 truncate">
                    {unit.unitName || `Unit ${i + 1}`}
                  </div>
                  <div className="col-span-1">
                    <span className="px-1.5 py-0.5 text-xs bg-purple-100 text-purple-700 rounded">
                      {ext.speciesCode || 'SAL'}
                    </span>
                  </div>
                  <div className="col-span-2 text-right font-medium text-gray-900">
                    {formatNumber(unit.quantity)}
                  </div>
                  <div className="col-span-1 text-right text-gray-500">
                    {unit.avgWeightG.toFixed(1)}
                  </div>
                  <div className="col-span-1 text-right text-orange-600">
                    {mort?.euthanized || 0}
                  </div>
                  <div className="col-span-1 text-right text-red-600">
                    {mort?.naturalDeaths || 0}
                  </div>
                  <div className="col-span-1 text-right text-blue-600">
                    {mort?.externalTransfers || 0}
                  </div>
                  <div className="col-span-2 text-right">
                    <span
                      className={`font-medium ${(mort?.rate || 0) > 1 ? 'text-red-600' : 'text-gray-700'}`}
                    >
                      {(mort?.rate || 0).toFixed(2)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Submission Notice */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <p className="text-sm text-gray-600">
          By submitting this report, you confirm that the data is accurate and complete. This report
          will be submitted to the Norwegian Food Safety Authority (Mattilsynet) via the settefisk
          API endpoint.
        </p>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const SmoltReportTab: React.FC<SmoltReportTabProps> = ({ siteId }) => {
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [formData, setFormData] = useState<SmoltFormData>(getInitialFormData());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch tanks for auto-populate
  const { data: tanksData } = useTanksList({ isActive: true });
  const tanks = tanksData?.items || [];

  // Regulatory settings & submit mutation
  const { data: regulatorySettings } = useRegulatorySettings();
  const submitSmoltMutation = useSubmitSmoltReport();
  const clientRef = useStableClientReference();
  const { effectiveSiteId, siteMappings, setSelectedSiteId, showSelector } =
    useEffectiveReportSite(siteId);

  // Server-assembled draft (plan Phase 1b): per-unit stock, weights, species
  // and the month's mortality/cull splits computed from the operational SSoTs.
  const prefillPeriod = useMemo(() => {
    const seed = getInitialFormData();
    return { year: seed.year, month: seed.month + 1 };
  }, []);
  const { data: prefill } = useReportPrefill<{ produksjonsenheter: SmoltPrefillUnit[] }>(
    'SMOLT',
    effectiveSiteId,
    prefillPeriod,
  );
  const unitsMeta = findFieldMeta(prefill?.fields, '/produksjonsenheter');
  const [submissionResult, setSubmissionResult] = useState<ReportSubmissionResult | null>(null);

  // Form handlers
  const handleFormChange = useCallback((updates: Partial<SmoltFormData>) => {
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
      // FARM-HIGH-128: fail-closed identity — never ship a silent lokalitetsnummer 0.
      const identity = buildRegulatoryIdentity(regulatorySettings, effectiveSiteId ?? '');

      const input: SubmitSmoltReportInput = {
        klientReferanse: clientRef.get(),
        organisasjonsnummer: identity.organisasjonsnummer,
        lokalitetsnummer: identity.lokalitetsnummer,
        kontaktperson: identity.kontaktperson,
        rapporteringsmaaned: toBackendReportMonth(formData.month),
        rapporteringsaar: formData.year,
        produksjonsenheter: formData.fishCounts.byUnit.map((unit) => {
          const mortalityUnit = formData.mortalityRates.byUnit.find(
            (m) => m.unitId === unit.unitId,
          );
          return {
            karId: unit.unitName || unit.unitId,
            artskode: (unit as SmoltUnitCountExtended).speciesCode || 'SAL',
            snittvektGram: formData.averageWeights.overall || 0,
            beholdningVedMaanedsslutt: unit.quantity,
            antallAvlivet: (mortalityUnit as SmoltMortalityUnitExtended)?.euthanized || 0,
            antallSelvdod: (mortalityUnit as SmoltMortalityUnitExtended)?.naturalDeaths || 0,
            antallFlyttetEksternt:
              (mortalityUnit as SmoltMortalityUnitExtended)?.externalTransfers || 0,
          };
        }),
      };

      const result = await submitSmoltMutation.mutateAsync(input);
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
      console.error('Smolt report submission error:', err);
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, regulatorySettings, effectiveSiteId, clientRef, submitSmoltMutation]);

  // Wizard steps
  const steps: ReportWizardStep[] = useMemo(
    () => [
      {
        id: 'basic',
        title: 'Facility Info',
        description: 'Period and facility type',
        content: (
          <BasicInfoStep
            formData={formData}
            onChange={handleFormChange}
            siteName={'Default Smolt Facility'}
          />
        ),
      },
      {
        id: 'fish-counts',
        title: 'Fish Counts',
        description: 'Fish by production unit',
        content: (
          <FishCountsStep
            formData={formData}
            onChange={handleFormChange}
            tanks={tanks}
            prefillUnits={prefill?.draftPayload.produksjonsenheter}
            unitsMeta={unitsMeta}
          />
        ),
        isValid: () => formData.fishCounts.byUnit.length > 0 && formData.fishCounts.total > 0,
      },
      {
        id: 'mortality',
        title: 'Mortality',
        description: 'Mortality & transfers',
        content: <MortalityStep formData={formData} onChange={handleFormChange} />,
      },
      {
        id: 'review',
        title: 'Review',
        description: 'Verify and submit',
        content: <ReviewStep formData={formData} siteName={'Default Smolt Facility'} />,
      },
    ],
    [formData, handleFormChange, tanks],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Smolt Reports</h2>
          <p className="text-sm text-gray-500">Monthly settefisk reports - Due 7th of each month</p>
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
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            New Report
          </button>
        </div>
      </div>

      {/* Submission History */}
      <SubmissionHistorySection reportType="SMOLT" siteId={effectiveSiteId} />

      {/* Wizard Modal */}
      <ReportWizard
        isOpen={isWizardOpen}
        onClose={() => {
          setIsWizardOpen(false);
          setFormData(getInitialFormData());
        }}
        onSubmit={handleSubmit}
        title="Smolt Report"
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

export default SmoltReportTab;
