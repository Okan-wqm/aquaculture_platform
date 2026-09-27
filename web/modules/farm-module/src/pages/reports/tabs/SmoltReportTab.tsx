/**
 * Smolt Report Tab
 * Monthly settefisk reports for smolt facilities
 * Due 7th of each month
 * Aligned with Norwegian Mattilsynet "settefisk" requirements
 */
import React, { useState, useMemo, useCallback } from 'react';
import { Button, Input, Select } from '@aquaculture/shared-ui';
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
import { Database, Download, Plus, X } from 'lucide-react';

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
  /**
   * Mattilsynet regulatory unit id (karId) carried from the server-assembled
   * draft — SettefiskReportAssembler derives it from Tank.regulatoryUnitId /
   * tank code, so the report matches the catalog the assembler read instead of
   * re-deriving it from the display name at submission.
   */
  karId?: string;
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

/**
 * Map the form's per-unit rows to the Mattilsynet settefisk `produksjonsenheter`
 * wire shape. The values come from the server-assembled draft (loaded via
 * "Load from System"): the regulatory karId and per-unit average weight are the
 * assembler's SSoT — a single overall weight and the display name are only
 * fallbacks for units the operator adds by hand.
 */
export function buildSmoltProduksjonsenheter(
  byUnit: SmoltUnitCountExtended[],
  mortalityByUnit: SmoltMortalityUnitExtended[],
  overallWeightGram: number,
): SubmitSmoltReportInput['produksjonsenheter'] {
  return byUnit.map((unit) => {
    const mortalityUnit = mortalityByUnit.find((m) => m.unitId === unit.unitId);
    return {
      karId: unit.karId || unit.unitName || unit.unitId,
      artskode: unit.speciesCode || 'SAL',
      snittvektGram: unit.avgWeightG || overallWeightGram || 0,
      beholdningVedMaanedsslutt: unit.quantity,
      antallAvlivet: mortalityUnit?.euthanized || 0,
      antallSelvdod: mortalityUnit?.naturalDeaths || 0,
      antallFlyttetEksternt: mortalityUnit?.externalTransfers || 0,
    };
  });
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
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Site
        </label>
        <Input fullWidth type="text" value={siteName} disabled />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Report Period
        </label>
        <Input
          fullWidth
          type="text"
          value={getMonthLabel(formData.month, formData.year)}
          disabled
        />
      </div>
    </div>
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        Facility Type
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => onChange({ facilityType: 'land_based' })}
          className={`p-4 border-2 rounded-lg text-center ${
            formData.facilityType === 'land_based'
              ? 'border-info-500 bg-info-50 dark:bg-info-900/20'
              : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500'
          }`}
        >
          <div className="font-medium text-gray-900 dark:text-gray-100">Land Based</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            RAS or flow-through systems
          </div>
        </button>
        <button
          type="button"
          onClick={() => onChange({ facilityType: 'freshwater' })}
          className={`p-4 border-2 rounded-lg text-center ${
            formData.facilityType === 'freshwater'
              ? 'border-info-500 bg-info-50 dark:bg-info-900/20'
              : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500'
          }`}
        >
          <div className="font-medium text-gray-900 dark:text-gray-100">Freshwater</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">Lake or river-based</div>
        </button>
      </div>
    </div>
  </div>
);

interface FishCountsStepProps {
  formData: SmoltFormData;
  onChange: (data: Partial<SmoltFormData>) => void;
  tanks: readonly Tank[];
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
        // Preserve the assembler's regulatory karId (do not re-derive from the
        // resolved tank display name at submission).
        karId: unit.karId,
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
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-2">
            Fish Counts by Unit
            {unitsMeta && <ProvenanceBadge meta={unitsMeta} />}
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Record fish in each production unit (Mattilsynet: produksjonsenhet)
          </p>
        </div>
        <div className="flex items-center gap-2">
          {prefillUnits && prefillUnits.length > 0 && (
            <button
              type="button"
              onClick={loadFromSystem}
              className="px-3 py-1.5 text-sm text-success-700 dark:text-success-300 bg-success-50 dark:bg-success-900/20 border border-success-300 dark:border-success-700 rounded-md hover:bg-success-100 dark:hover:bg-success-900/50 flex items-center gap-1"
            >
              <Download className="w-4 h-4" aria-hidden="true" />
              Load from System
            </button>
          )}
          <Button variant="secondary" size="sm" type="button" onClick={addUnit}>
            + Add Unit
          </Button>
        </div>
      </div>

      {/* Total Summary */}
      <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-info-800 dark:text-info-200">
            Total Fish Count
          </span>
          <span className="text-2xl font-bold text-info-700 dark:text-info-300">
            {formatNumber(formData.fishCounts.total)}
          </span>
        </div>
      </div>

      {formData.fishCounts.byUnit.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 dark:bg-gray-800 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700">
          <Database className="w-12 h-12 mx-auto text-gray-300" aria-hidden="true" />
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No units added</p>
          <p className="text-xs text-gray-400 dark:text-gray-500">
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
              <div
                key={unit.unitId}
                className="p-4 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg"
              >
                <div className="flex items-start justify-between mb-3">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Unit #{index + 1}
                  </span>
                  <Button variant="ghost" type="button" onClick={() => removeUnit(index)}>
                    <X className="w-4 h-4" aria-hidden="true" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
                  <div>
                    <label
                      htmlFor={`smolt-unit-tank-${index}`}
                      className="block text-xs text-gray-500 dark:text-gray-400 mb-1"
                    >
                      Unit Name / Tank
                    </label>
                    {tanks.length > 0 ? (
                      <Select
                        id={`smolt-unit-tank-${index}`}
                        size="sm"
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
                        options={[
                          { value: '__manual__', label: '-- Manual entry --' },
                          ...tanks.map((t) => ({
                            value: t.id,
                            label: `${t.name} ${
                              t.batchMetrics?.pieces
                                ? `(${formatNumber(t.batchMetrics.pieces)} fish)`
                                : ''
                            }`,
                          })),
                        ]}
                      />
                    ) : (
                      <Input
                        fullWidth
                        type="text"
                        value={unit.unitName}
                        onChange={(e) => updateUnit(index, { unitName: e.target.value })}
                        placeholder="Tank A1"
                      />
                    )}
                    {!isFromSystem && tanks.length > 0 && (
                      <Input
                        fullWidth
                        type="text"
                        value={unit.unitName}
                        onChange={(e) => updateUnit(index, { unitName: e.target.value })}
                        placeholder="Enter unit name"
                      />
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Type
                    </label>
                    <Select
                      fullWidth
                      options={[
                        { value: 'tank', label: 'Tank' },
                        { value: 'raceway', label: 'Raceway' },
                        { value: 'pond', label: 'Pond' },
                      ]}
                      value={unit.unitType}
                      onChange={(e) =>
                        updateUnit(index, {
                          unitType: e.target.value as 'tank' | 'raceway' | 'pond',
                        })
                      }
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`smolt-species-code-${index}`}
                      className="block text-xs text-gray-500 dark:text-gray-400 mb-1"
                    >
                      Species Code (artskode)
                    </label>
                    <Select
                      id={`smolt-species-code-${index}`}
                      size="sm"
                      value={(unit as SmoltUnitCountExtended).speciesCode || 'SAL'}
                      onChange={(e) => updateUnit(index, { speciesCode: e.target.value })}
                      options={SPECIES_CODES.map((sp) => ({
                        value: sp.code,
                        label: `${sp.code} - ${sp.label}`,
                      }))}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Stage
                    </label>
                    <Select
                      fullWidth
                      options={[
                        { value: 'fry', label: 'Fry' },
                        { value: 'parr', label: 'Parr' },
                        { value: 'smolt', label: 'Smolt' },
                      ]}
                      value={unit.stage}
                      onChange={(e) =>
                        updateUnit(index, { stage: e.target.value as 'fry' | 'parr' | 'smolt' })
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Fish Count
                    </label>
                    <Input
                      fullWidth
                      type="number"
                      min="0"
                      value={unit.quantity || ''}
                      onChange={(e) =>
                        updateUnit(index, { quantity: parseInt(e.target.value) || 0 })
                      }
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Avg Weight (g)
                    </label>
                    <Input
                      fullWidth
                      type="number"
                      min="0"
                      step="0.1"
                      value={unit.avgWeightG || ''}
                      onChange={(e) =>
                        updateUnit(index, { avgWeightG: parseFloat(e.target.value) || 0 })
                      }
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
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Mortality and Transfers by Unit
        </h4>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Mattilsynet requires separate counts for euthanized (avlivet) and natural deaths
          (selvdod), plus external transfers
        </p>
      </div>

      {/* Overall Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3">
          <div className="text-xs text-error-600 dark:text-error-400 font-medium">
            Overall Mortality
          </div>
          <div className="text-xl font-bold text-error-700 dark:text-error-300">
            {formData.mortalityRates.overall.toFixed(2)}%
          </div>
        </div>
        <div className="bg-accent-50 dark:bg-accent-900/20 border border-accent-200 dark:border-accent-800 rounded-lg p-3">
          <div className="text-xs text-accent-600 dark:text-accent-400 font-medium">
            Euthanized (avlivet)
          </div>
          <div className="text-xl font-bold text-accent-700 dark:text-accent-300">
            {formatNumber(totalEuthanized)}
          </div>
        </div>
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3">
          <div className="text-xs text-error-600 dark:text-error-400 font-medium">
            Natural Deaths (selvdod)
          </div>
          <div className="text-xl font-bold text-error-700 dark:text-error-300">
            {formatNumber(totalNaturalDeaths)}
          </div>
        </div>
        <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-3">
          <div className="text-xs text-info-600 dark:text-info-400 font-medium">
            External Transfers
          </div>
          <div className="text-xl font-bold text-info-700 dark:text-info-300">
            {formatNumber(totalExternalTransfers)}
          </div>
        </div>
      </div>

      {formData.mortalityRates.byUnit.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 dark:bg-gray-800 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Add fish counts first to record mortality by unit
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.mortalityRates.byUnit.map((mort, index) => {
            const ext = mort as SmoltMortalityUnitExtended;
            const unitData = formData.fishCounts.byUnit[index];
            return (
              <div
                key={mort.unitId}
                className="p-4 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg"
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {mort.unitName || `Unit ${index + 1}`}
                    </span>
                    {unitData && (
                      <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                        ({formatNumber(unitData.quantity)} fish)
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-gray-500 dark:text-gray-400">Rate: </span>
                    <span
                      className={`font-medium text-sm ${mort.rate > 1 ? 'text-error-600 dark:text-error-400' : 'text-gray-700 dark:text-gray-300'}`}
                    >
                      {mort.rate.toFixed(2)}%
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Euthanized (avlivet)
                    </label>
                    <Input
                      fullWidth
                      type="number"
                      min="0"
                      value={ext.euthanized || ''}
                      onChange={(e) =>
                        updateMortality(index, { euthanized: parseInt(e.target.value) || 0 })
                      }
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Natural Deaths (selvdod)
                    </label>
                    <Input
                      fullWidth
                      type="number"
                      min="0"
                      value={ext.naturalDeaths || ''}
                      onChange={(e) =>
                        updateMortality(index, { naturalDeaths: parseInt(e.target.value) || 0 })
                      }
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Total Dead
                    </label>
                    <div className="w-full px-2 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md text-gray-700 dark:text-gray-300 font-medium">
                      {formatNumber(mort.count)}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      External Transfers
                    </label>
                    <Input
                      fullWidth
                      type="number"
                      min="0"
                      value={ext.externalTransfers || ''}
                      onChange={(e) =>
                        updateMortality(index, { externalTransfers: parseInt(e.target.value) || 0 })
                      }
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
      <div className="bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-info-800 dark:text-info-200">Report Summary</h4>
        <p className="text-sm text-info-600 dark:text-info-400 mt-1">
          {siteName} - {getMonthLabel(formData.month, formData.year)}
        </p>
        <span
          className={`inline-block mt-2 px-2 py-0.5 text-xs font-medium rounded ${
            formData.facilityType === 'land_based'
              ? 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300'
              : 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300'
          }`}
        >
          {formData.facilityType === 'land_based' ? 'Land Based Facility' : 'Freshwater Facility'}
        </span>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-info-600 dark:text-info-400">
            {formatNumber(formData.fishCounts.total)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Total Fish</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-success-600 dark:text-success-400">
            {formData.averageWeights.overall.toFixed(1)}g
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Avg Weight</div>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-error-600 dark:text-error-400">
            {formData.mortalityRates.overall.toFixed(2)}%
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Mortality Rate</div>
        </div>
      </div>

      {/* Mortality Breakdown (Mattilsynet) */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <h5 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-3">
          Mortality Breakdown (Mattilsynet)
        </h5>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="text-center p-2 bg-accent-50 dark:bg-accent-900/20 rounded">
            <div className="text-lg font-bold text-accent-700 dark:text-accent-300">
              {formatNumber(totalEuthanized)}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Euthanized (avlivet)</div>
          </div>
          <div className="text-center p-2 bg-error-50 dark:bg-error-900/20 rounded">
            <div className="text-lg font-bold text-error-700 dark:text-error-300">
              {formatNumber(totalNaturalDeaths)}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Natural Deaths (selvdod)</div>
          </div>
          <div className="text-center p-2 bg-info-50 dark:bg-info-900/20 rounded">
            <div className="text-lg font-bold text-info-700 dark:text-info-300">
              {formatNumber(totalExternalTransfers)}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">External Transfers</div>
          </div>
        </div>
      </div>

      {/* Stage Breakdown */}
      {stageTotals.length > 0 && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-3">
            Fish by Stage
          </h5>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {stageTotals.map((s) => (
              <div key={s.stage} className="text-center p-2 bg-gray-50 dark:bg-gray-800 rounded">
                <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
                  {formatNumber(s.quantity)}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 capitalize">{s.stage}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unit Summary with species codes, mortality rates, and transfers */}
      {formData.fishCounts.byUnit.length > 0 && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-3">
            Production Units ({formData.fishCounts.byUnit.length})
          </h5>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 dark:text-gray-400 font-medium pb-1 border-b border-gray-100 dark:border-gray-700">
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
                  <div className="col-span-3 text-gray-700 dark:text-gray-300 truncate">
                    {unit.unitName || `Unit ${i + 1}`}
                  </div>
                  <div className="col-span-1">
                    <span className="px-1.5 py-0.5 text-xs bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300 rounded">
                      {ext.speciesCode || 'SAL'}
                    </span>
                  </div>
                  <div className="col-span-2 text-right font-medium text-gray-900 dark:text-gray-100">
                    {formatNumber(unit.quantity)}
                  </div>
                  <div className="col-span-1 text-right text-gray-500 dark:text-gray-400">
                    {unit.avgWeightG.toFixed(1)}
                  </div>
                  <div className="col-span-1 text-right text-accent-600 dark:text-accent-400">
                    {mort?.euthanized || 0}
                  </div>
                  <div className="col-span-1 text-right text-error-600 dark:text-error-400">
                    {mort?.naturalDeaths || 0}
                  </div>
                  <div className="col-span-1 text-right text-info-600 dark:text-info-400">
                    {mort?.externalTransfers || 0}
                  </div>
                  <div className="col-span-2 text-right">
                    <span
                      className={`font-medium ${(mort?.rate || 0) > 1 ? 'text-error-600 dark:text-error-400' : 'text-gray-700 dark:text-gray-300'}`}
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
      <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
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
        produksjonsenheter: buildSmoltProduksjonsenheter(
          formData.fishCounts.byUnit,
          formData.mortalityRates.byUnit,
          formData.averageWeights.overall || 0,
        ),
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
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Smolt Reports</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Monthly settefisk reports - Due 7th of each month
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SiteLocalitySelector
            siteMappings={siteMappings}
            effectiveSiteId={effectiveSiteId}
            onChange={setSelectedSiteId}
            show={showSelector}
          />
          <Button variant="primary" onClick={() => handleOpenWizard()}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            New Report
          </Button>
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
