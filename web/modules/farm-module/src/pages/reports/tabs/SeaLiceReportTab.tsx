/**
 * Sea Lice Report Tab
 * Weekly lakselus reports with wizard-based entry
 * Due every Tuesday
 */
import React, { useState, useMemo, useCallback } from 'react';
import { mockSeaLiceReports } from '../mock/seaLiceData';
import {
  SeaLiceReport,
  SeaLiceCounts,
  SeaLiceCageCount,
  CleanerFishEntry,
  SeaLiceTreatment,
  ReportStatus,
} from '../types/reports.types';
import { SEA_LICE_THRESHOLDS, REGULATORY_CONTACTS } from '../utils/thresholds';
import { ReportStatusBadge, DeadlineIndicator } from '../components/common';
import { ReportWizard, ReportWizardStep } from '../components/wizard/ReportWizard';

// ============================================================================
// Types
// ============================================================================

interface SeaLiceReportTabProps {
  siteId?: string;
}

interface SeaLiceFormData {
  weekNumber: number;
  year: number;
  waterTemperature3m: number;
  siteCounts: SeaLiceCounts;
  cageCounts: SeaLiceCageCount[];
  treatments: SeaLiceTreatment[];
  cleanerFish: CleanerFishEntry[];
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
    treatments: [],
    cleanerFish: [],
  };
}

// ============================================================================
// Report Card Component
// ============================================================================

interface SeaLiceReportCardProps {
  report: SeaLiceReport;
  onView: () => void;
  onEdit?: () => void;
}

const SeaLiceReportCard: React.FC<SeaLiceReportCardProps> = ({ report, onView, onEdit }) => {
  const thresholdStatus = getThresholdStatus(report.siteCounts.adultFemale);
  const isPending = report.status === 'pending' || report.status === 'overdue';

  return (
    <div
      className={`bg-white rounded-lg border shadow-sm hover:shadow-md transition-shadow ${
        report.thresholdExceeded ? 'border-orange-200' : 'border-gray-200'
      }`}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div>
              <h3 className="font-medium text-gray-900">{getWeekLabel(report.weekNumber, report.year)}</h3>
              <p className="text-sm text-gray-500">{report.siteName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ReportStatusBadge status={report.status} size="sm" />
            {report.thresholdExceeded && (
              <span className="px-2 py-0.5 text-xs font-semibold text-orange-700 bg-orange-100 rounded">
                Threshold Exceeded
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        {/* Lice Counts */}
        <div className="grid grid-cols-4 gap-3 mb-3">
          <div className="text-center">
            <div className={`text-lg font-bold ${thresholdStatus.level !== 'normal' ? 'text-orange-600' : 'text-gray-900'}`}>
              {report.siteCounts.adultFemale.toFixed(2)}
            </div>
            <div className="text-xs text-gray-500">Adult Female</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-gray-900">{report.siteCounts.mobile.toFixed(2)}</div>
            <div className="text-xs text-gray-500">Mobile</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-gray-900">{report.siteCounts.attached.toFixed(2)}</div>
            <div className="text-xs text-gray-500">Attached</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-blue-600">{report.siteCounts.averagePerFish.toFixed(2)}</div>
            <div className="text-xs text-gray-500">Avg/Fish</div>
          </div>
        </div>

        {/* Threshold Badge */}
        {report.siteCounts.adultFemale > 0 && (
          <div className="mb-3">
            <span className={`px-2 py-1 text-xs font-medium rounded ${thresholdStatus.color}`}>
              {thresholdStatus.label} (Threshold: {SEA_LICE_THRESHOLDS.ALERT_LEVEL})
            </span>
          </div>
        )}

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-2 text-sm pt-3 border-t border-gray-100">
          <div>
            <span className="text-gray-500">Water Temp:</span>
            <span className="ml-1 font-medium">{report.waterTemperature3m}°C</span>
          </div>
          <div>
            <span className="text-gray-500">Cages:</span>
            <span className="ml-1 font-medium">{report.cageCounts.length}</span>
          </div>
          {report.treatments.length > 0 && (
            <div className="col-span-2">
              <span className="text-gray-500">Treatments:</span>
              <span className="ml-1 font-medium text-orange-600">{report.treatments.length}</span>
            </div>
          )}
          {report.cleanerFish.length > 0 && (
            <div className="col-span-2">
              <span className="text-gray-500">Cleaner Fish:</span>
              <span className="ml-1 font-medium">
                {report.cleanerFish.reduce((sum, cf) => sum + cf.count, 0).toLocaleString()}
              </span>
            </div>
          )}
        </div>

        {/* Deadline for pending */}
        {isPending && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <DeadlineIndicator deadline={report.deadline} status={report.status} reportType="Sea Lice" />
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
  </div>
);

interface LiceCountStepProps {
  formData: SeaLiceFormData;
  onChange: (data: Partial<SeaLiceFormData>) => void;
}

const LiceCountStep: React.FC<LiceCountStepProps> = ({ formData, onChange }) => {
  const updateSiteCounts = (field: keyof SeaLiceCounts, value: number) => {
    const newCounts = { ...formData.siteCounts, [field]: value };
    // Auto-calculate average per fish
    newCounts.averagePerFish = newCounts.adultFemale + newCounts.mobile + newCounts.attached;
    onChange({ siteCounts: newCounts });
  };

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
        <h4 className="text-sm font-medium text-gray-700 mb-3">Site-Level Average Counts (per fish)</h4>
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
              className={`w-full px-3 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500 ${
                formData.siteCounts.adultFemale >= SEA_LICE_THRESHOLDS.ALERT_LEVEL
                  ? 'border-orange-300 bg-orange-50'
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
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
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
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
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
    const newTreatment: SeaLiceTreatment = {
      id: `trt-${Date.now()}`,
      type: 'non_medicated',
      date: new Date(),
      targetCages: [],
    };
    onChange({ treatments: [...formData.treatments, newTreatment] });
  };

  const updateTreatment = (index: number, updates: Partial<SeaLiceTreatment>) => {
    const updated = formData.treatments.map((t, i) =>
      i === index ? { ...t, ...updates } : t
    );
    onChange({ treatments: updated });
  };

  const removeTreatment = (index: number) => {
    onChange({ treatments: formData.treatments.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700">Treatments Applied</h4>
          <p className="text-xs text-gray-500">Record any sea lice treatments during this reporting period</p>
        </div>
        <button
          type="button"
          onClick={addTreatment}
          className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
        >
          + Add Treatment
        </button>
      </div>

      {formData.treatments.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No treatments recorded</p>
          <p className="text-xs text-gray-400">Click "Add Treatment" if any treatments were applied this week</p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.treatments.map((treatment, index) => (
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Type</label>
                  <select
                    value={treatment.type}
                    onChange={(e) => updateTreatment(index, { type: e.target.value as 'medicated' | 'non_medicated' })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  >
                    <option value="non_medicated">Non-Medicated (Thermal, Mechanical)</option>
                    <option value="medicated">Medicated (Chemical)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Date</label>
                  <input
                    type="date"
                    value={treatment.date.toISOString().split('T')[0]}
                    onChange={(e) => updateTreatment(index, { date: new Date(e.target.value) })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>
                {treatment.type === 'medicated' && (
                  <>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Active Ingredient</label>
                      <input
                        type="text"
                        value={treatment.activeIngredient || ''}
                        onChange={(e) => updateTreatment(index, { activeIngredient: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                        placeholder="e.g., Azamethiphos"
                      />
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 mb-1">Amount</label>
                        <input
                          type="number"
                          value={treatment.amount || ''}
                          onChange={(e) => updateTreatment(index, { amount: parseFloat(e.target.value) })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                        />
                      </div>
                      <div className="w-20">
                        <label className="block text-xs text-gray-500 mb-1">Unit</label>
                        <input
                          type="text"
                          value={treatment.unit || ''}
                          onChange={(e) => updateTreatment(index, { unit: e.target.value })}
                          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                          placeholder="mg/L"
                        />
                      </div>
                    </div>
                  </>
                )}
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">Notes</label>
                  <textarea
                    value={treatment.notes || ''}
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

interface ReviewStepProps {
  formData: SeaLiceFormData;
  siteName: string;
}

const ReviewStep: React.FC<ReviewStepProps> = ({ formData, siteName }) => {
  const thresholdStatus = getThresholdStatus(formData.siteCounts.adultFemale);

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

      {/* Treatments */}
      {formData.treatments.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Treatments ({formData.treatments.length})</h5>
          <ul className="space-y-2">
            {formData.treatments.map((t, i) => (
              <li key={i} className="flex items-center text-sm">
                <span className="w-2 h-2 bg-orange-400 rounded-full mr-2" />
                <span className="text-gray-700">
                  {t.type === 'medicated' ? `Medicated (${t.activeIngredient})` : 'Non-Medicated'} - {formatDate(t.date)}
                </span>
              </li>
            ))}
          </ul>
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
  const [selectedReport, setSelectedReport] = useState<SeaLiceReport | null>(null);
  const [formData, setFormData] = useState<SeaLiceFormData>(getInitialFormData());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'all'>('all');

  // Filter reports
  const reports = useMemo(() => {
    let filtered = siteId
      ? mockSeaLiceReports.filter((r) => r.siteId === siteId)
      : mockSeaLiceReports;

    if (statusFilter !== 'all') {
      filtered = filtered.filter((r) => r.status === statusFilter);
    }

    return filtered.sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.weekNumber - a.weekNumber;
    });
  }, [siteId, statusFilter]);

  // Stats
  const stats = useMemo(() => {
    const pending = mockSeaLiceReports.filter((r) => r.status === 'pending' || r.status === 'overdue').length;
    const overdue = mockSeaLiceReports.filter((r) => r.status === 'overdue').length;
    const thresholdExceeded = mockSeaLiceReports.filter((r) => r.thresholdExceeded).length;
    return { pending, overdue, thresholdExceeded, total: mockSeaLiceReports.length };
  }, []);

  // Form handlers
  const handleFormChange = useCallback((updates: Partial<SeaLiceFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleOpenWizard = useCallback((report?: SeaLiceReport) => {
    if (report) {
      setFormData({
        weekNumber: report.weekNumber,
        year: report.year,
        waterTemperature3m: report.waterTemperature3m,
        siteCounts: { ...report.siteCounts },
        cageCounts: [...report.cageCounts],
        treatments: [...report.treatments],
        cleanerFish: [...report.cleanerFish],
      });
    } else {
      setFormData(getInitialFormData());
    }
    setIsWizardOpen(true);
  }, []);

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    try {
      // Simulate API call
      await new Promise((resolve) => setTimeout(resolve, 1500));
      console.log('Submitting sea lice report:', formData);
      setIsWizardOpen(false);
      setFormData(getInitialFormData());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }, [formData]);

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
            siteName={selectedReport?.siteName || 'Default Site'}
          />
        ),
        isValid: () => formData.waterTemperature3m > 0,
      },
      {
        id: 'lice-counts',
        title: 'Lice Counts',
        description: 'Site-level sea lice data',
        content: <LiceCountStep formData={formData} onChange={handleFormChange} />,
        isValid: () =>
          formData.siteCounts.adultFemale >= 0 &&
          formData.siteCounts.mobile >= 0 &&
          formData.siteCounts.attached >= 0,
      },
      {
        id: 'treatments',
        title: 'Treatments',
        description: 'Record any treatments applied',
        content: <TreatmentStep formData={formData} onChange={handleFormChange} />,
        optional: true,
      },
      {
        id: 'review',
        title: 'Review & Submit',
        description: 'Verify and submit report',
        content: <ReviewStep formData={formData} siteName={selectedReport?.siteName || 'Default Site'} />,
      },
    ],
    [formData, handleFormChange, selectedReport]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Sea Lice Reports</h2>
          <p className="text-sm text-gray-500">Weekly lakselus monitoring - Due every Tuesday</p>
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
        <div className="bg-white rounded-lg border border-yellow-200 p-4">
          <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
          <div className="text-sm text-gray-500">Pending</div>
        </div>
        <div className="bg-white rounded-lg border border-red-200 p-4">
          <div className="text-2xl font-bold text-red-600">{stats.overdue}</div>
          <div className="text-sm text-gray-500">Overdue</div>
        </div>
        <div className="bg-white rounded-lg border border-orange-200 p-4">
          <div className="text-2xl font-bold text-orange-600">{stats.thresholdExceeded}</div>
          <div className="text-sm text-gray-500">Threshold Exceeded</div>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500">Filter:</span>
        {(['all', 'pending', 'overdue', 'submitted', 'approved'] as const).map((status) => (
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
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
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
            <SeaLiceReportCard
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
