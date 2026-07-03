/**
 * Sea Lice Report Tab
 * Weekly lakselus reports with wizard-based entry
 * Due every Tuesday
 * Aligned with Norwegian Mattilsynet "lakselus" API requirements
 */
import React, { useState, useMemo, useCallback } from 'react';
import { useTanksList } from '../../../hooks/useTanks';
import {
  useRegulatorySettings,
  useSubmitSeaLiceReport,
} from '../../../hooks/useRegulatory';
import type { SubmitSeaLiceReportInput, ReportSubmissionResult } from '../../../hooks/useRegulatory';
import {
  SeaLiceCounts,
  CleanerFishEntry,
  SeaLiceTreatment,
} from '../types/reports.types';
import { SEA_LICE_THRESHOLDS, REGULATORY_CONTACTS } from '../utils/thresholds';
import { ReportWizard, ReportWizardStep } from '../components/wizard/ReportWizard';
import { SubmissionHistorySection } from '../components/SubmissionHistorySection';
import { useStableClientReference } from '../../../hooks/useStableClientReference';
import { useEffectiveReportSite } from '../hooks/useEffectiveReportSite';
import { SiteLocalitySelector } from '../components/SiteLocalitySelector';
import { buildRegulatoryIdentity } from '../utils/regulatoryIdentity';

// ============================================================================
// Types
// ============================================================================

interface SeaLiceReportTabProps {
  siteId?: string;
}

interface CageCountEntry {
  cageId: string;
  cageName: string;
  adultFemale: number;
  mobile: number;
  attached: number;
  fishSampled: number;
}

interface TreatmentEntry {
  id: string;
  category: 'non_medicated' | 'medicated';
  nonMedicatedType?: string;
  activeIngredient?: string;
  dosage?: number;
  dosageUnit?: string;
  date: string;
  beforeCounting: boolean;
  wholeSite: boolean;
  cagesTreated?: number;
  notes: string;
}

interface SensitivityTestData {
  performed: boolean;
  labName: string;
  testDate: string;
  ingredientTested: string;
  result: 'sensitive' | 'reduced' | 'resistant' | '';
}

interface TankOption {
  id: string;
  name: string;
  code: string;
}

interface SeaLiceFormData {
  weekNumber: number;
  year: number;
  waterTemperature3m: number;
  siteCounts: SeaLiceCounts;
  cageCounts: CageCountEntry[];
  treatmentEntries: TreatmentEntry[];
  cleanerFish: CleanerFishEntry[];
  resistanceSuspicion: boolean;
  resistanceDetails: string;
  sensitivityTest: SensitivityTestData;
  // Legacy field kept for wizard compatibility
  treatments: SeaLiceTreatment[];
}

// ============================================================================
// Constants
// ============================================================================

const NON_MEDICATED_TYPES = [
  { value: 'TERMISK_BEHANDLING', label: 'Thermal (Thermolicer)' },
  { value: 'MEKANISK_BEHANDLING', label: 'Mechanical (Hydrolicer/FLS)' },
  { value: 'FERSKVANN', label: 'Freshwater' },
  { value: 'SPYLING', label: 'Flushing' },
  { value: 'LASER', label: 'Laser' },
  { value: 'ANNET', label: 'Other' },
];

const ACTIVE_INGREDIENTS = [
  { value: 'AZAMETIFOS', label: 'Azamethiphos' },
  { value: 'CYPERMETHRIN', label: 'Cypermethrin' },
  { value: 'DELTAMETHRIN', label: 'Deltamethrin' },
  { value: 'HYDROGENPEROKSID', label: 'Hydrogen Peroxide' },
  { value: 'EMAMEKTIN_BENZOAT', label: 'Emamectin Benzoate' },
  { value: 'ANNET', label: 'Other' },
];

const DOSAGE_UNITS = [
  { value: 'mg/L', label: 'mg/L' },
  { value: 'mg/g', label: 'mg/g' },
  { value: 'g', label: 'g' },
  { value: 'kg', label: 'kg' },
  { value: 'L', label: 'L' },
  { value: 'mL', label: 'mL' },
  { value: '%', label: '%' },
];

// ============================================================================
// Helper Functions
// ============================================================================

function getWeekLabel(weekNumber: number, year: number): string {
  return `Week ${weekNumber}, ${year}`;
}

function getThresholdStatus(adultFemale: number): {
  level: 'normal' | 'alert' | 'treatment' | 'critical';
  label: string;
  color: string;
} {
  if (adultFemale >= SEA_LICE_THRESHOLDS.MAX_ALLOWED) {
    return { level: 'critical', label: 'CRITICAL', color: 'text-red-700 bg-red-100' };
  }
  if (adultFemale >= SEA_LICE_THRESHOLDS.TREATMENT_TRIGGER) {
    return { level: 'treatment', label: 'Treatment Required', color: 'text-orange-700 bg-orange-100' };
  }
  if (adultFemale >= SEA_LICE_THRESHOLDS.ALERT_LEVEL) {
    return { level: 'alert', label: 'Alert', color: 'text-yellow-700 bg-yellow-100' };
  }
  return { level: 'normal', label: 'Normal', color: 'text-green-700 bg-green-100' };
}

function getInitialFormData(): SeaLiceFormData {
  const now = new Date();
  const weekNumber = Math.ceil(
    ((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7
  );
  return {
    weekNumber,
    year: now.getFullYear(),
    waterTemperature3m: 0,
    siteCounts: { adultFemale: 0, mobile: 0, attached: 0, averagePerFish: 0 },
    cageCounts: [],
    treatmentEntries: [],
    cleanerFish: [],
    resistanceSuspicion: false,
    resistanceDetails: '',
    sensitivityTest: {
      performed: false,
      labName: '',
      testDate: '',
      ingredientTested: '',
      result: '',
    },
    treatments: [],
  };
}

// ============================================================================
// Wizard Step Components
// ============================================================================

interface BasicInfoStepProps {
  formData: SeaLiceFormData;
  onChange: (data: Partial<SeaLiceFormData>) => void;
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
          value={getWeekLabel(formData.weekNumber, formData.year)}
          disabled
          className="w-full px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-gray-700"
        />
      </div>
    </div>
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        Water Temperature at 3m Depth (°C) <span className="text-red-500">*</span>
      </label>
      <input
        type="number"
        step="0.1"
        value={formData.waterTemperature3m || ''}
        onChange={(e) => onChange({ waterTemperature3m: parseFloat(e.target.value) || 0 })}
        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
        placeholder="Enter water temperature"
      />
      <p className="mt-1 text-xs text-gray-500">Standard measurement depth for Norwegian sea lice reporting</p>
    </div>
    {/* Sensor integration note */}
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
      <div className="flex items-start gap-2">
        <svg className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-xs text-blue-700">
          Water temperature at 3m depth should come from sensor readings when available.
          Currently manual entry is required until sensor integration is enabled.
        </p>
      </div>
    </div>
  </div>
);

interface LiceCountStepProps {
  formData: SeaLiceFormData;
  onChange: (data: Partial<SeaLiceFormData>) => void;
  tankOptions: TankOption[];
}

const LiceCountStep: React.FC<LiceCountStepProps> = ({ formData, onChange, tankOptions }) => {
  const [showCageBreakdown, setShowCageBreakdown] = useState(false);

  const updateSiteCounts = (field: keyof SeaLiceCounts, value: number) => {
    const newCounts = { ...formData.siteCounts, [field]: value };
    // Auto-calculate average per fish
    newCounts.averagePerFish = newCounts.adultFemale + newCounts.mobile + newCounts.attached;
    onChange({ siteCounts: newCounts });
  };

  const recalculateSiteAverages = (cageCounts: CageCountEntry[]) => {
    if (cageCounts.length === 0) return;

    const totalFishSampled = cageCounts.reduce((sum, c) => sum + c.fishSampled, 0);
    if (totalFishSampled === 0) return;

    const weightedAdultFemale = cageCounts.reduce((sum, c) => sum + (c.adultFemale * c.fishSampled), 0) / totalFishSampled;
    const weightedMobile = cageCounts.reduce((sum, c) => sum + (c.mobile * c.fishSampled), 0) / totalFishSampled;
    const weightedAttached = cageCounts.reduce((sum, c) => sum + (c.attached * c.fishSampled), 0) / totalFishSampled;

    const newCounts: SeaLiceCounts = {
      adultFemale: Math.round(weightedAdultFemale * 100) / 100,
      mobile: Math.round(weightedMobile * 100) / 100,
      attached: Math.round(weightedAttached * 100) / 100,
      averagePerFish: Math.round((weightedAdultFemale + weightedMobile + weightedAttached) * 100) / 100,
    };
    onChange({ siteCounts: newCounts });
  };

  const addCageCount = () => {
    const newEntry: CageCountEntry = {
      cageId: '',
      cageName: '',
      adultFemale: 0,
      mobile: 0,
      attached: 0,
      fishSampled: 20,
    };
    const updated = [...formData.cageCounts, newEntry];
    onChange({ cageCounts: updated });
    setShowCageBreakdown(true);
  };

  const updateCageCount = (index: number, updates: Partial<CageCountEntry>) => {
    const updated = formData.cageCounts.map((c, i) =>
      i === index ? { ...c, ...updates } : c
    );
    onChange({ cageCounts: updated });
    // Recalculate site averages from cage data
    recalculateSiteAverages(updated);
  };

  const removeCageCount = (index: number) => {
    const updated = formData.cageCounts.filter((_, i) => i !== index);
    onChange({ cageCounts: updated });
    if (updated.length > 0) {
      recalculateSiteAverages(updated);
    }
  };

  const handleCageSelect = (index: number, cageId: string) => {
    const selectedTank = tankOptions.find(t => t.id === cageId);
    updateCageCount(index, {
      cageId,
      cageName: selectedTank?.name || '',
    });
  };

  // Filter tank options to only show cage-type equipment
  const cageOptions = useMemo(() => {
    const usedIds = formData.cageCounts.map(c => c.cageId).filter(Boolean);
    return tankOptions.filter(t =>
      !usedIds.includes(t.id) ||
      formData.cageCounts.some(c => c.cageId === t.id)
    );
  }, [tankOptions, formData.cageCounts]);

  const thresholdStatus = getThresholdStatus(formData.siteCounts.adultFemale);

  return (
    <div className="space-y-6">
      {/* Threshold Warning */}
      {formData.siteCounts.adultFemale >= SEA_LICE_THRESHOLDS.ALERT_LEVEL && (
        <div className={`p-4 rounded-lg ${
          thresholdStatus.level === 'critical' ? 'bg-red-50 border border-red-200' :
          thresholdStatus.level === 'treatment' ? 'bg-orange-50 border border-orange-200' :
          'bg-yellow-50 border border-yellow-200'
        }`}>
          <div className="flex items-center">
            <svg className="w-5 h-5 text-orange-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="font-medium">{thresholdStatus.label}</span>
          </div>
          <p className="mt-1 text-sm">
            Adult female count ({formData.siteCounts.adultFemale.toFixed(2)}) exceeds threshold ({SEA_LICE_THRESHOLDS.ALERT_LEVEL}).
            {thresholdStatus.level === 'treatment' && ' Treatment action is required.'}
          </p>
        </div>
      )}

      {/* Site-Level Counts */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-3">
          Site-Level Average Counts (per fish)
          {formData.cageCounts.length > 0 && (
            <span className="ml-2 text-xs font-normal text-blue-600">
              Auto-calculated from per-cage data
            </span>
          )}
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Adult Female <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={formData.siteCounts.adultFemale || ''}
              onChange={(e) => updateSiteCounts('adultFemale', parseFloat(e.target.value) || 0)}
              disabled={formData.cageCounts.length > 0}
              className={`w-full px-3 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500 ${
                formData.siteCounts.adultFemale >= SEA_LICE_THRESHOLDS.ALERT_LEVEL
                  ? 'border-orange-300 bg-orange-50'
                  : formData.cageCounts.length > 0
                    ? 'border-gray-200 bg-gray-100 text-gray-700'
                    : 'border-gray-300'
              }`}
              placeholder="0.00"
            />
            <p className="mt-1 text-xs text-gray-400">Threshold: {SEA_LICE_THRESHOLDS.ALERT_LEVEL}</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Mobile <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={formData.siteCounts.mobile || ''}
              onChange={(e) => updateSiteCounts('mobile', parseFloat(e.target.value) || 0)}
              disabled={formData.cageCounts.length > 0}
              className={`w-full px-3 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500 ${
                formData.cageCounts.length > 0
                  ? 'border-gray-200 bg-gray-100 text-gray-700'
                  : 'border-gray-300'
              }`}
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Attached <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={formData.siteCounts.attached || ''}
              onChange={(e) => updateSiteCounts('attached', parseFloat(e.target.value) || 0)}
              disabled={formData.cageCounts.length > 0}
              className={`w-full px-3 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500 ${
                formData.cageCounts.length > 0
                  ? 'border-gray-200 bg-gray-100 text-gray-700'
                  : 'border-gray-300'
              }`}
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Total Avg/Fish</label>
            <input
              type="text"
              value={formData.siteCounts.averagePerFish.toFixed(2)}
              disabled
              className="w-full px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-gray-700"
            />
          </div>
        </div>
      </div>

      {/* Per-Cage Breakdown (Optional) */}
      <div className="border border-gray-200 rounded-lg">
        <button
          type="button"
          onClick={() => setShowCageBreakdown(!showCageBreakdown)}
          className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-50 rounded-lg"
        >
          <div>
            <span className="text-sm font-medium text-gray-700">Per-Cage Breakdown (Optional)</span>
            {formData.cageCounts.length > 0 && (
              <span className="ml-2 text-xs text-blue-600">{formData.cageCounts.length} cage(s) entered</span>
            )}
          </div>
          <svg
            className={`w-5 h-5 text-gray-400 transition-transform ${showCageBreakdown ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showCageBreakdown && (
          <div className="px-4 pb-4 space-y-3 border-t border-gray-200">
            <div className="pt-3 flex items-center justify-between">
              <p className="text-xs text-gray-500">
                Enter per-cage counts to auto-calculate weighted site averages.
              </p>
              <button
                type="button"
                onClick={addCageCount}
                className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
              >
                + Add Cage Count
              </button>
            </div>

            {formData.cageCounts.length === 0 ? (
              <div className="text-center py-6 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
                <p className="text-sm text-gray-500">No per-cage data entered</p>
                <p className="text-xs text-gray-400 mt-1">Site averages will be entered manually above</p>
              </div>
            ) : (
              <div className="space-y-3">
                {formData.cageCounts.map((cage, index) => (
                  <div key={index} className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                    <div className="flex items-start justify-between mb-2">
                      <span className="text-xs font-medium text-gray-600">Cage #{index + 1}</span>
                      <button
                        type="button"
                        onClick={() => removeCageCount(index)}
                        className="text-red-500 hover:text-red-700"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Cage</label>
                        {cageOptions.length > 0 ? (
                          <select
                            value={cage.cageId}
                            onChange={(e) => handleCageSelect(index, e.target.value)}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                          >
                            <option value="">Select cage...</option>
                            {cageOptions.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.name} ({opt.code})
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={cage.cageName}
                            onChange={(e) => updateCageCount(index, { cageName: e.target.value })}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                            placeholder="Cage name"
                          />
                        )}
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Adult Female</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={cage.adultFemale || ''}
                          onChange={(e) => updateCageCount(index, { adultFemale: parseFloat(e.target.value) || 0 })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Mobile</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={cage.mobile || ''}
                          onChange={(e) => updateCageCount(index, { mobile: parseFloat(e.target.value) || 0 })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Attached</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={cage.attached || ''}
                          onChange={(e) => updateCageCount(index, { attached: parseFloat(e.target.value) || 0 })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Fish Sampled</label>
                        <input
                          type="number"
                          min="1"
                          value={cage.fishSampled || ''}
                          onChange={(e) => updateCageCount(index, { fishSampled: parseInt(e.target.value) || 0 })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                          placeholder="20"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Threshold Reference */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-blue-800 mb-2">Norwegian Sea Lice Thresholds</h4>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-blue-600">Alert Level:</span>
            <span className="ml-1 font-medium">&gt; {SEA_LICE_THRESHOLDS.ALERT_LEVEL}</span>
          </div>
          <div>
            <span className="text-orange-600">Treatment Trigger:</span>
            <span className="ml-1 font-medium">&gt; {SEA_LICE_THRESHOLDS.TREATMENT_TRIGGER}</span>
          </div>
          <div>
            <span className="text-red-600">Critical Level:</span>
            <span className="ml-1 font-medium">&gt; {SEA_LICE_THRESHOLDS.MAX_ALLOWED}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

interface TreatmentStepProps {
  formData: SeaLiceFormData;
  onChange: (data: Partial<SeaLiceFormData>) => void;
}

const TreatmentStep: React.FC<TreatmentStepProps> = ({ formData, onChange }) => {
  const addTreatment = () => {
    const newTreatment: TreatmentEntry = {
      id: `trt-${Date.now()}`,
      category: 'non_medicated',
      nonMedicatedType: '',
      activeIngredient: '',
      dosage: undefined,
      dosageUnit: 'mg/L',
      date: new Date().toISOString().split('T')[0],
      beforeCounting: false,
      wholeSite: true,
      cagesTreated: undefined,
      notes: '',
    };
    onChange({ treatmentEntries: [...formData.treatmentEntries, newTreatment] });
  };

  const updateTreatment = (index: number, updates: Partial<TreatmentEntry>) => {
    const updated = formData.treatmentEntries.map((t, i) =>
      i === index ? { ...t, ...updates } : t
    );
    onChange({ treatmentEntries: updated });
  };

  const removeTreatment = (index: number) => {
    onChange({ treatmentEntries: formData.treatmentEntries.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700">Treatments Applied</h4>
          <p className="text-xs text-gray-500">Record any sea lice treatments during this reporting period (Mattilsynet format)</p>
        </div>
        <button
          type="button"
          onClick={addTreatment}
          className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
        >
          + Add Treatment
        </button>
      </div>

      {formData.treatmentEntries.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No treatments recorded</p>
          <p className="text-xs text-gray-400">Click "Add Treatment" if any treatments were applied this week</p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.treatmentEntries.map((treatment, index) => (
            <div key={treatment.id} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm font-medium text-gray-700">Treatment #{index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeTreatment(index)}
                  className="text-red-500 hover:text-red-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Treatment Category Radio */}
              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-500 mb-2">Treatment Category</label>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={`category-${treatment.id}`}
                      value="non_medicated"
                      checked={treatment.category === 'non_medicated'}
                      onChange={() => updateTreatment(index, { category: 'non_medicated', activeIngredient: '', dosage: undefined })}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">Non-Medicated</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={`category-${treatment.id}`}
                      value="medicated"
                      checked={treatment.category === 'medicated'}
                      onChange={() => updateTreatment(index, { category: 'medicated', nonMedicatedType: '' })}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">Medicated</span>
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* Non-medicated type selection */}
                {treatment.category === 'non_medicated' && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Type</label>
                    <select
                      value={treatment.nonMedicatedType || ''}
                      onChange={(e) => updateTreatment(index, { nonMedicatedType: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    >
                      <option value="">Select type...</option>
                      {NON_MEDICATED_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Medicated fields */}
                {treatment.category === 'medicated' && (
                  <>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Active Ingredient</label>
                      <select
                        value={treatment.activeIngredient || ''}
                        onChange={(e) => updateTreatment(index, { activeIngredient: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      >
                        <option value="">Select ingredient...</option>
                        {ACTIVE_INGREDIENTS.map((ai) => (
                          <option key={ai.value} value={ai.value}>{ai.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 mb-1">Dosage</label>
                        <input
                          type="number"
                          step="0.01"
                          value={treatment.dosage || ''}
                          onChange={(e) => updateTreatment(index, { dosage: parseFloat(e.target.value) || undefined })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                          placeholder="Amount"
                        />
                      </div>
                      <div className="w-24">
                        <label className="block text-xs text-gray-500 mb-1">Unit</label>
                        <select
                          value={treatment.dosageUnit || 'mg/L'}
                          onChange={(e) => updateTreatment(index, { dosageUnit: e.target.value })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                        >
                          {DOSAGE_UNITS.map((u) => (
                            <option key={u.value} value={u.value}>{u.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </>
                )}

                {/* Date */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Date</label>
                  <input
                    type="date"
                    value={treatment.date}
                    onChange={(e) => updateTreatment(index, { date: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>

                {/* Mattilsynet-specific fields */}
                <div className="col-span-2 grid grid-cols-2 gap-3 pt-2 border-t border-gray-200 mt-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`beforeCounting-${treatment.id}`}
                      checked={treatment.beforeCounting}
                      onChange={(e) => updateTreatment(index, { beforeCounting: e.target.checked })}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <label htmlFor={`beforeCounting-${treatment.id}`} className="text-xs text-gray-700">
                      Treatment applied before lice counting?
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`wholeSite-${treatment.id}`}
                      checked={treatment.wholeSite}
                      onChange={(e) => updateTreatment(index, { wholeSite: e.target.checked, cagesTreated: e.target.checked ? undefined : 1 })}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <label htmlFor={`wholeSite-${treatment.id}`} className="text-xs text-gray-700">
                      Whole site treated?
                    </label>
                  </div>
                </div>

                {/* Number of cages treated (if not whole site) */}
                {!treatment.wholeSite && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Number of cages treated</label>
                    <input
                      type="number"
                      min="1"
                      value={treatment.cagesTreated || ''}
                      onChange={(e) => updateTreatment(index, { cagesTreated: parseInt(e.target.value) || undefined })}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      placeholder="Number of cages"
                    />
                  </div>
                )}

                {/* Notes */}
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">Notes</label>
                  <textarea
                    value={treatment.notes}
                    onChange={(e) => updateTreatment(index, { notes: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    rows={2}
                    placeholder="Treatment details..."
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

interface ResistanceStepProps {
  formData: SeaLiceFormData;
  onChange: (data: Partial<SeaLiceFormData>) => void;
}

const ResistanceStep: React.FC<ResistanceStepProps> = ({ formData, onChange }) => {
  const updateSensitivityTest = (updates: Partial<SensitivityTestData>) => {
    onChange({ sensitivityTest: { ...formData.sensitivityTest, ...updates } });
  };

  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-1">Resistance Tracking</h4>
        <p className="text-xs text-gray-500">Optional - record any resistance suspicions or sensitivity test results</p>
      </div>

      {/* Resistance Suspicion */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="resistanceSuspicion"
            checked={formData.resistanceSuspicion}
            onChange={(e) => onChange({
              resistanceSuspicion: e.target.checked,
              resistanceDetails: e.target.checked ? formData.resistanceDetails : '',
            })}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <label htmlFor="resistanceSuspicion" className="text-sm font-medium text-gray-700">
            Any resistance suspicion?
          </label>
        </div>

        {formData.resistanceSuspicion && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Describe the resistance suspicion</label>
            <textarea
              value={formData.resistanceDetails}
              onChange={(e) => onChange({ resistanceDetails: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              rows={3}
              placeholder="Describe observations suggesting resistance (e.g., reduced treatment efficacy, repeat treatments needed)..."
            />
          </div>
        )}
      </div>

      {/* Sensitivity Test */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="sensitivityTest"
            checked={formData.sensitivityTest.performed}
            onChange={(e) => updateSensitivityTest({
              performed: e.target.checked,
              ...(e.target.checked ? {} : { labName: '', testDate: '', ingredientTested: '', result: '' }),
            })}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <label htmlFor="sensitivityTest" className="text-sm font-medium text-gray-700">
            Sensitivity test performed?
          </label>
        </div>

        {formData.sensitivityTest.performed && (
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-gray-100">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Laboratory Name</label>
              <input
                type="text"
                value={formData.sensitivityTest.labName}
                onChange={(e) => updateSensitivityTest({ labName: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                placeholder="e.g., PatoGen"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Test Date</label>
              <input
                type="date"
                value={formData.sensitivityTest.testDate}
                onChange={(e) => updateSensitivityTest({ testDate: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Active Ingredient Tested</label>
              <select
                value={formData.sensitivityTest.ingredientTested}
                onChange={(e) => updateSensitivityTest({ ingredientTested: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              >
                <option value="">Select ingredient...</option>
                {ACTIVE_INGREDIENTS.map((ai) => (
                  <option key={ai.value} value={ai.value}>{ai.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Result</label>
              <select
                value={formData.sensitivityTest.result}
                onChange={(e) => updateSensitivityTest({ result: e.target.value as SensitivityTestData['result'] })}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
              >
                <option value="">Select result...</option>
                <option value="sensitive">Sensitive (Folsom)</option>
                <option value="reduced">Reduced Sensitivity (Nedsatt folsomhet)</option>
                <option value="resistant">Resistant (Resistent)</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Info box */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
        <div className="flex items-start gap-2">
          <svg className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-xs text-blue-700">
            Resistance data is reported to Mattilsynet to track treatment efficacy across Norwegian aquaculture sites.
            Sensitivity tests (folsomhetsundersokelser) follow the standard bioassay protocol.
          </p>
        </div>
      </div>
    </div>
  );
};

interface ReviewStepProps {
  formData: SeaLiceFormData;
  siteName: string;
}

const ReviewStep: React.FC<ReviewStepProps> = ({ formData, siteName }) => {
  const thresholdStatus = getThresholdStatus(formData.siteCounts.adultFemale);

  const getIngredientLabel = (value: string) => {
    return ACTIVE_INGREDIENTS.find(ai => ai.value === value)?.label || value;
  };

  const getNonMedicatedLabel = (value: string) => {
    return NON_MEDICATED_TYPES.find(t => t.value === value)?.label || value;
  };

  return (
    <div className="space-y-6">
      {/* Summary Header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-blue-800">Report Summary</h4>
        <p className="text-sm text-blue-600 mt-1">
          {siteName} - {getWeekLabel(formData.weekNumber, formData.year)}
        </p>
      </div>

      {/* Threshold Warning */}
      {formData.siteCounts.adultFemale >= SEA_LICE_THRESHOLDS.ALERT_LEVEL && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
          <div className="flex items-center">
            <svg className="w-5 h-5 text-orange-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="font-medium text-orange-800">{thresholdStatus.label}</span>
          </div>
          <p className="mt-1 text-sm text-orange-700">
            This report indicates elevated lice levels that may require attention.
          </p>
        </div>
      )}

      {/* Data Summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-2">Water Temperature</h5>
          <p className="text-2xl font-bold text-gray-900">{formData.waterTemperature3m}°C</p>
          <p className="text-xs text-gray-500">at 3m depth</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-2">Adult Female Lice</h5>
          <p className={`text-2xl font-bold ${thresholdStatus.level !== 'normal' ? 'text-orange-600' : 'text-gray-900'}`}>
            {formData.siteCounts.adultFemale.toFixed(2)}
          </p>
          <p className="text-xs text-gray-500">per fish (avg)</p>
        </div>
      </div>

      {/* Lice Counts */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Sea Lice Counts (per fish)</h5>
        <div className="grid grid-cols-4 gap-4 text-center">
          <div>
            <div className="text-lg font-bold text-gray-900">{formData.siteCounts.adultFemale.toFixed(2)}</div>
            <div className="text-xs text-gray-500">Adult Female</div>
          </div>
          <div>
            <div className="text-lg font-bold text-gray-900">{formData.siteCounts.mobile.toFixed(2)}</div>
            <div className="text-xs text-gray-500">Mobile</div>
          </div>
          <div>
            <div className="text-lg font-bold text-gray-900">{formData.siteCounts.attached.toFixed(2)}</div>
            <div className="text-xs text-gray-500">Attached</div>
          </div>
          <div>
            <div className="text-lg font-bold text-blue-600">{formData.siteCounts.averagePerFish.toFixed(2)}</div>
            <div className="text-xs text-gray-500">Total Avg</div>
          </div>
        </div>
      </div>

      {/* Per-Cage Breakdown */}
      {formData.cageCounts.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Per-Cage Breakdown ({formData.cageCounts.length} cages)</h5>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-100">
                  <th className="text-left pb-2 pr-3">Cage</th>
                  <th className="text-right pb-2 px-2">Adult Female</th>
                  <th className="text-right pb-2 px-2">Mobile</th>
                  <th className="text-right pb-2 px-2">Attached</th>
                  <th className="text-right pb-2 pl-2">Fish Sampled</th>
                </tr>
              </thead>
              <tbody>
                {formData.cageCounts.map((cage, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="py-1.5 pr-3 font-medium text-gray-700">{cage.cageName || `Cage ${i + 1}`}</td>
                    <td className="py-1.5 px-2 text-right">{cage.adultFemale.toFixed(2)}</td>
                    <td className="py-1.5 px-2 text-right">{cage.mobile.toFixed(2)}</td>
                    <td className="py-1.5 px-2 text-right">{cage.attached.toFixed(2)}</td>
                    <td className="py-1.5 pl-2 text-right">{cage.fishSampled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Treatments */}
      {formData.treatmentEntries.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Treatments ({formData.treatmentEntries.length})</h5>
          <ul className="space-y-3">
            {formData.treatmentEntries.map((t, i) => (
              <li key={i} className="text-sm border-b border-gray-50 pb-2 last:border-0 last:pb-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2 h-2 bg-orange-400 rounded-full flex-shrink-0" />
                  <span className="font-medium text-gray-700">
                    {t.category === 'medicated'
                      ? `Medicated - ${getIngredientLabel(t.activeIngredient || '')}`
                      : `Non-Medicated - ${getNonMedicatedLabel(t.nonMedicatedType || '')}`
                    }
                  </span>
                  <span className="text-gray-400">|</span>
                  <span className="text-gray-500">{t.date}</span>
                </div>
                <div className="ml-4 text-xs text-gray-500 space-x-3">
                  {t.category === 'medicated' && t.dosage && (
                    <span>Dosage: {t.dosage} {t.dosageUnit}</span>
                  )}
                  <span>{t.beforeCounting ? 'Before counting' : 'After counting'}</span>
                  <span>{t.wholeSite ? 'Whole site' : `${t.cagesTreated || '?'} cage(s)`}</span>
                </div>
                {t.notes && (
                  <p className="ml-4 mt-1 text-xs text-gray-400 italic">{t.notes}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Resistance / Sensitivity */}
      {(formData.resistanceSuspicion || formData.sensitivityTest.performed) && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Resistance Tracking</h5>
          {formData.resistanceSuspicion && (
            <div className="mb-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="w-2 h-2 bg-red-400 rounded-full" />
                <span className="font-medium text-red-700">Resistance Suspicion</span>
              </div>
              {formData.resistanceDetails && (
                <p className="ml-4 mt-1 text-xs text-gray-600">{formData.resistanceDetails}</p>
              )}
            </div>
          )}
          {formData.sensitivityTest.performed && (
            <div>
              <div className="flex items-center gap-2 text-sm mb-2">
                <span className="w-2 h-2 bg-blue-400 rounded-full" />
                <span className="font-medium text-gray-700">Sensitivity Test</span>
              </div>
              <div className="ml-4 grid grid-cols-2 gap-2 text-xs text-gray-600">
                <div>Lab: {formData.sensitivityTest.labName || '-'}</div>
                <div>Date: {formData.sensitivityTest.testDate || '-'}</div>
                <div>Ingredient: {getIngredientLabel(formData.sensitivityTest.ingredientTested)}</div>
                <div>
                  Result:{' '}
                  <span className={
                    formData.sensitivityTest.result === 'sensitive' ? 'text-green-600 font-medium' :
                    formData.sensitivityTest.result === 'reduced' ? 'text-yellow-600 font-medium' :
                    formData.sensitivityTest.result === 'resistant' ? 'text-red-600 font-medium' :
                    ''
                  }>
                    {formData.sensitivityTest.result === 'sensitive' ? 'Sensitive' :
                     formData.sensitivityTest.result === 'reduced' ? 'Reduced Sensitivity' :
                     formData.sensitivityTest.result === 'resistant' ? 'Resistant' :
                     '-'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Submission Notice */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <p className="text-sm text-gray-600">
          By submitting this report, you confirm that the data is accurate and complete.
          This report will be submitted to the Norwegian Food Safety Authority (Mattilsynet).
        </p>
        <p className="text-xs text-gray-500 mt-2">
          Contact: {REGULATORY_CONTACTS.MATTILSYNET_EMAIL}
        </p>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const SeaLiceReportTab: React.FC<SeaLiceReportTabProps> = ({ siteId }) => {
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [formData, setFormData] = useState<SeaLiceFormData>(getInitialFormData());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch tanks/cages for per-cage breakdown
  const { data: tanksData } = useTanksList({ isActive: true });
  const tanks = tanksData?.items || [];
  const tankOptions = useMemo(() => tanks.map(t => ({ id: t.id, name: t.name, code: t.code })), [tanks]);

  // Regulatory settings & submit mutation
  const { data: regulatorySettings } = useRegulatorySettings();
  const submitSeaLiceMutation = useSubmitSeaLiceReport();
  const clientRef = useStableClientReference();
  const { effectiveSiteId, siteMappings, setSelectedSiteId, showSelector } =
    useEffectiveReportSite(siteId);
  const [submissionResult, setSubmissionResult] = useState<ReportSubmissionResult | null>(null);

  // Derive site name from tanks data if available
  const derivedSiteName = useMemo(() => {
    const firstTankWithSite = tanks.find(t => t.department?.site?.name);
    if (firstTankWithSite?.department?.site?.name) return firstTankWithSite.department.site.name;
    return 'Current Site';
  }, [tanks]);

  // Form handlers
  const handleFormChange = useCallback((updates: Partial<SeaLiceFormData>) => {
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
      // Map frontend non-medicated type values to Mattilsynet enum values
      const nonMedTypeMap: Record<string, string> = {
        TERMISK_BEHANDLING: 'TERMISK_BEHANDLING',
        MEKANISK_BEHANDLING: 'MEKANISK_BEHANDLING',
        FERSKVANN: 'FERSKVANNSBEHANDLING',
        SPYLING: 'ANNEN_BEHANDLING',
        LASER: 'ANNEN_BEHANDLING',
        ANNET: 'ANNEN_BEHANDLING',
      };
      // Map frontend active ingredient values to Mattilsynet enum values
      const ingredientMap: Record<string, string> = {
        AZAMETIFOS: 'AZAMETHIPHOS',
        CYPERMETHRIN: 'CYPERMETHRIN',
        DELTAMETHRIN: 'DELTAMETHRIN',
        HYDROGENPEROKSID: 'HYDROGENPEROKSID',
        EMAMEKTIN_BENZOAT: 'EMAMECTIN_BENZOAT',
        ANNET: 'ANNET_VIRKESTOFF',
      };
      // Build Mattilsynet-aligned input from form data
      // FARM-HIGH-128: fail-closed identity — never ship a silent lokalitetsnummer 0.
      const identity = buildRegulatoryIdentity(regulatorySettings, effectiveSiteId ?? '');
      const input: SubmitSeaLiceReportInput = {
        klientReferanse: clientRef.get(),
        organisasjonsnummer: identity.organisasjonsnummer,
        lokalitetsnummer: identity.lokalitetsnummer,
        kontaktperson: identity.kontaktperson,
        rapporteringsaar: formData.year,
        rapporteringsuke: formData.weekNumber,
        sjotemperatur: formData.waterTemperature3m,
        lusetelling: {
          voksneHunnlus: formData.siteCounts.adultFemale,
          bevegeligeLus: formData.siteCounts.mobile,
          fastsittendeLus: formData.siteCounts.attached,
        },
        ikkeMedikamentelleBehandlinger: formData.treatmentEntries
          .filter(t => t.category === 'non_medicated')
          .map(t => ({
            type: nonMedTypeMap[t.nonMedicatedType || ''] || 'ANNEN_BEHANDLING',
            gjennomfortForTelling: t.beforeCounting,
            heleLokaliteten: t.wholeSite,
            antallMerder: t.cagesTreated,
            beskrivelse: t.notes || undefined,
          })),
        medikamentelleBehandlinger: formData.treatmentEntries
          .filter(t => t.category === 'medicated')
          .map(t => ({
            type: 'BADEBEHANDLING',
            gjennomfortForTelling: t.beforeCounting,
            heleLokaliteten: t.wholeSite,
            antallMerder: t.cagesTreated,
            virkestoff: {
              type: ingredientMap[t.activeIngredient || ''] || 'ANNET_VIRKESTOFF',
              mengde: t.dosage ? { verdi: t.dosage, enhet: 'GRAM' } : undefined,
            },
            beskrivelse: t.notes || undefined,
          })),
        resistensMistanker: formData.resistanceSuspicion ? [{
          resistens: 'ANNEN_RESISTENS',
          aarsak: 'NEDSATT_BEHANDLINGSEFFEKT',
          annenResistens: formData.resistanceDetails || undefined,
        }] : undefined,
        folsomhetsundersokelser: formData.sensitivityTest.performed ? [{
          utfortDato: formData.sensitivityTest.testDate,
          laboratorium: formData.sensitivityTest.labName,
          resistens: (formData.sensitivityTest.ingredientTested || 'ANNEN_RESISTENS') as string,
          testresultat: formData.sensitivityTest.result === 'sensitive' ? 'FOLSOM'
            : formData.sensitivityTest.result === 'reduced' ? 'NEDSATT_FOLSOMHET'
            : formData.sensitivityTest.result === 'resistant' ? 'RESISTENS'
            : 'FOLSOM',
        }] : undefined,
      };

      // Remove empty arrays
      if (input.ikkeMedikamentelleBehandlinger?.length === 0) delete input.ikkeMedikamentelleBehandlinger;
      if (input.medikamentelleBehandlinger?.length === 0) delete input.medikamentelleBehandlinger;

      const result = await submitSeaLiceMutation.mutateAsync(input);
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
      console.error('Sea lice report submission error:', err);
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, regulatorySettings, effectiveSiteId, clientRef, submitSeaLiceMutation]);

  // Wizard steps
  const steps: ReportWizardStep[] = useMemo(
    () => [
      {
        id: 'basic',
        title: 'Basic Info',
        description: 'Report period and conditions',
        content: (
          <BasicInfoStep
            formData={formData}
            onChange={handleFormChange}
            siteName={derivedSiteName}
          />
        ),
        isValid: () => formData.waterTemperature3m > 0,
      },
      {
        id: 'lice-counts',
        title: 'Lice Counts',
        description: 'Site-level and per-cage sea lice data',
        content: (
          <LiceCountStep
            formData={formData}
            onChange={handleFormChange}
            tankOptions={tankOptions}
          />
        ),
        isValid: () =>
          formData.siteCounts.adultFemale >= 0 &&
          formData.siteCounts.mobile >= 0 &&
          formData.siteCounts.attached >= 0,
      },
      {
        id: 'treatments',
        title: 'Treatments',
        description: 'Record treatments (Mattilsynet format)',
        content: <TreatmentStep formData={formData} onChange={handleFormChange} />,
        optional: true,
      },
      {
        id: 'resistance',
        title: 'Resistance',
        description: 'Resistance tracking (optional)',
        content: <ResistanceStep formData={formData} onChange={handleFormChange} />,
        optional: true,
      },
      {
        id: 'review',
        title: 'Review & Submit',
        description: 'Verify and submit report',
        content: <ReviewStep formData={formData} siteName={derivedSiteName} />,
      },
    ],
    [formData, handleFormChange, derivedSiteName, tankOptions]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Sea Lice Reports</h2>
          <p className="text-sm text-gray-500">Weekly lakselus monitoring - Due every Tuesday</p>
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
      <SubmissionHistorySection reportType="SEA_LICE" siteId={effectiveSiteId} />

      {/* Wizard Modal */}
      <ReportWizard
        isOpen={isWizardOpen}
        onClose={() => {
          setIsWizardOpen(false);
          setFormData(getInitialFormData());
        }}
        onSubmit={handleSubmit}
        title="Sea Lice Report"
        subtitle={`Weekly report - ${getWeekLabel(formData.weekNumber, formData.year)}`}
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

export default SeaLiceReportTab;
