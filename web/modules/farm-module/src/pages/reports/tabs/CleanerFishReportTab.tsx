/**
 * Cleaner Fish Report Tab
 * Monthly rensefisk reports
 * Due 7th of each month
 */
import React, { useState, useMemo, useCallback } from 'react';
import { mockCleanerFishReports } from '../mock/cleanerFishData';
import {
  CleanerFishReport,
  CleanerFishSpecies,
  CleanerFishSpeciesCount,
  CleanerFishMortality,
  CleanerFishDeployment,
  ReportStatus,
} from '../types/reports.types';
import { ReportStatusBadge, DeadlineIndicator } from '../components/common';
import { ReportWizard, ReportWizardStep } from '../components/wizard/ReportWizard';

// ============================================================================
// Types
// ============================================================================

interface CleanerFishReportTabProps {
  siteId?: string;
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
}

// ============================================================================
// Constants
// ============================================================================

const CLEANER_FISH_SPECIES: { value: CleanerFishSpecies; label: string; norwegian: string }[] = [
  { value: 'lumpfish', label: 'Lumpfish', norwegian: 'Rognkjeks' },
  { value: 'ballan_wrasse', label: 'Ballan Wrasse', norwegian: 'Berggylt' },
  { value: 'corkwing_wrasse', label: 'Corkwing Wrasse', norwegian: 'Grønngylt' },
  { value: 'goldsinny_wrasse', label: 'Goldsinny Wrasse', norwegian: 'Bergnebb' },
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

function getSpeciesLabel(species: CleanerFishSpecies): string {
  return CLEANER_FISH_SPECIES.find((s) => s.value === species)?.label || species;
}

function getSpeciesNorwegian(species: CleanerFishSpecies): string {
  return CLEANER_FISH_SPECIES.find((s) => s.value === species)?.norwegian || '';
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
  };
}

// ============================================================================
// Report Card Component
// ============================================================================

interface CleanerFishReportCardProps {
  report: CleanerFishReport;
  onView: () => void;
  onEdit?: () => void;
}

const CleanerFishReportCard: React.FC<CleanerFishReportCardProps> = ({ report, onView, onEdit }) => {
  const isPending = report.status === 'pending' || report.status === 'overdue';

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-teal-100 rounded-lg">
              <svg className="w-5 h-5 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
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
          <div className="text-center p-2 bg-teal-50 rounded">
            <div className="text-lg font-bold text-teal-700">{formatNumber(report.totalCount)}</div>
            <div className="text-xs text-gray-500">Total Fish</div>
          </div>
          <div className="text-center p-2 bg-red-50 rounded">
            <div className="text-lg font-bold text-red-700">{report.mortality.overallRate.toFixed(1)}%</div>
            <div className="text-xs text-gray-500">Mortality</div>
          </div>
          <div className="text-center p-2 bg-blue-50 rounded">
            <div className="text-lg font-bold text-blue-700">{report.deployments.length}</div>
            <div className="text-xs text-gray-500">Deployments</div>
          </div>
        </div>

        {/* Species Breakdown */}
        {report.fishBySpecies.length > 0 && (
          <div className="flex flex-wrap gap-1 text-xs pt-3 border-t border-gray-100">
            {report.fishBySpecies.map((fish) => (
              <span key={fish.species} className="px-2 py-1 bg-teal-50 text-teal-700 rounded">
                {getSpeciesLabel(fish.species)}: {formatNumber(fish.count)}
              </span>
            ))}
          </div>
        )}

        {/* Deadline for pending */}
        {isPending && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <DeadlineIndicator deadline={report.deadline} status={report.status} reportType="Cleaner Fish" />
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

interface InventoryStepProps {
  formData: CleanerFishFormData;
  onChange: (data: Partial<CleanerFishFormData>) => void;
}

const InventoryStep: React.FC<InventoryStepProps> = ({ formData, onChange }) => {
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
        {availableSpecies.length > 0 && (
          <div className="relative">
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
          </div>
        )}
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

interface MortalityStepProps {
  formData: CleanerFishFormData;
  onChange: (data: Partial<CleanerFishFormData>) => void;
}

const MortalityStep: React.FC<MortalityStepProps> = ({ formData, onChange }) => {
  const updateMortality = (species: CleanerFishSpecies, count: number) => {
    const fishCount = formData.fishBySpecies.find((f) => f.species === species)?.count || 0;
    const rate = fishCount > 0 ? (count / fishCount) * 100 : 0;

    let bySpecies = [...formData.mortality.bySpecies];
    const existingIndex = bySpecies.findIndex((m) => m.species === species);

    if (existingIndex >= 0) {
      bySpecies[existingIndex] = { species, count, rate };
    } else {
      bySpecies.push({ species, count, rate });
    }

    const totalCount = bySpecies.reduce((sum, m) => sum + m.count, 0);
    const overallRate = formData.totalCount > 0 ? (totalCount / formData.totalCount) * 100 : 0;

    onChange({
      mortality: { bySpecies, totalCount, overallRate },
    });
  };

  const getMortalityCount = (species: CleanerFishSpecies): number => {
    return formData.mortality.bySpecies.find((m) => m.species === species)?.count || 0;
  };

  const getMortalityRate = (species: CleanerFishSpecies): number => {
    return formData.mortality.bySpecies.find((m) => m.species === species)?.rate || 0;
  };

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-700">Mortality by Species</h4>
        <p className="text-xs text-gray-500">Record cleaner fish deaths during the reporting period</p>
      </div>

      {/* Overall Summary */}
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-medium text-red-800">Overall Mortality</span>
            <div className="text-xs text-red-600 mt-1">
              {formatNumber(formData.mortality.totalCount)} deaths
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
        <div className="space-y-2">
          {formData.fishBySpecies.map((fish) => (
            <div key={fish.species} className="flex items-center gap-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex-1">
                <div className="text-sm font-medium text-gray-700">{getSpeciesLabel(fish.species)}</div>
                <div className="text-xs text-gray-500">Inventory: {formatNumber(fish.count)}</div>
              </div>
              <div className="w-32">
                <label className="block text-xs text-gray-500 mb-1">Deaths</label>
                <input
                  type="number"
                  min="0"
                  value={getMortalityCount(fish.species) || ''}
                  onChange={(e) => updateMortality(fish.species, parseInt(e.target.value) || 0)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  placeholder="0"
                />
              </div>
              <div className="w-24 text-right">
                <span className="text-sm text-gray-500">Rate:</span>
                <span className="ml-1 font-medium text-red-600">
                  {getMortalityRate(fish.species).toFixed(1)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface DeploymentsStepProps {
  formData: CleanerFishFormData;
  onChange: (data: Partial<CleanerFishFormData>) => void;
}

const DeploymentsStep: React.FC<DeploymentsStepProps> = ({ formData, onChange }) => {
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
                  <label className="block text-xs text-gray-500 mb-1">Target Cage</label>
                  <input
                    type="text"
                    value={deployment.targetCageName}
                    onChange={(e) => updateDeployment(index, { targetCageName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="Cage 1"
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
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-teal-600">{formatNumber(formData.totalCount)}</div>
          <div className="text-xs text-gray-500">Total Inventory</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-red-600">{formData.mortality.overallRate.toFixed(1)}%</div>
          <div className="text-xs text-gray-500">Mortality Rate</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{formatNumber(totalDeployed)}</div>
          <div className="text-xs text-gray-500">Deployed</div>
        </div>
      </div>

      {/* Species Breakdown */}
      {formData.fishBySpecies.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">Inventory by Species</h5>
          <div className="space-y-2">
            {formData.fishBySpecies.map((fish) => (
              <div key={fish.species} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-gray-700">{getSpeciesLabel(fish.species)}</span>
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
          This report will be submitted to the Norwegian Food Safety Authority.
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
  const [selectedReport, setSelectedReport] = useState<CleanerFishReport | null>(null);
  const [formData, setFormData] = useState<CleanerFishFormData>(getInitialFormData());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'all'>('all');

  // Filter reports
  const reports = useMemo(() => {
    let filtered = siteId
      ? mockCleanerFishReports.filter((r) => r.siteId === siteId)
      : mockCleanerFishReports;

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
    const totalFish = mockCleanerFishReports.reduce((sum, r) => sum + r.totalCount, 0);
    const totalDeployments = mockCleanerFishReports.reduce((sum, r) => sum + r.deployments.length, 0);
    const pending = mockCleanerFishReports.filter((r) => r.status === 'pending' || r.status === 'overdue').length;
    return { totalFish, totalDeployments, pending, total: mockCleanerFishReports.length };
  }, []);

  // Form handlers
  const handleFormChange = useCallback((updates: Partial<CleanerFishFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleOpenWizard = useCallback((report?: CleanerFishReport) => {
    if (report) {
      setFormData({
        month: report.month,
        year: report.year,
        fishBySpecies: [...report.fishBySpecies],
        totalCount: report.totalCount,
        mortality: { ...report.mortality },
        deployments: [...report.deployments],
      });
    } else {
      setFormData(getInitialFormData());
    }
    setIsWizardOpen(true);
  }, []);

  const handleSubmit = useCallback(async () => {
    setIsSubmitting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      console.log('Submitting cleaner fish report:', formData);
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
        id: 'inventory',
        title: 'Inventory',
        description: 'Current stock by species',
        content: <InventoryStep formData={formData} onChange={handleFormChange} />,
        isValid: () => formData.fishBySpecies.length > 0 && formData.totalCount > 0,
      },
      {
        id: 'mortality',
        title: 'Mortality',
        description: 'Deaths by species',
        content: <MortalityStep formData={formData} onChange={handleFormChange} />,
      },
      {
        id: 'deployments',
        title: 'Deployments',
        description: 'Transfers to salmon cages',
        content: <DeploymentsStep formData={formData} onChange={handleFormChange} />,
        optional: true,
      },
      {
        id: 'review',
        title: 'Review',
        description: 'Verify and submit',
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
          <h2 className="text-lg font-semibold text-gray-900">Cleaner Fish Reports</h2>
          <p className="text-sm text-gray-500">Monthly rensefisk reports - Due 7th of each month</p>
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
        <div className="bg-white rounded-lg border border-teal-200 p-4">
          <div className="text-2xl font-bold text-teal-600">{formatNumber(stats.totalFish)}</div>
          <div className="text-sm text-gray-500">Total Fish</div>
        </div>
        <div className="bg-white rounded-lg border border-blue-200 p-4">
          <div className="text-2xl font-bold text-blue-600">{stats.totalDeployments}</div>
          <div className="text-sm text-gray-500">Deployments</div>
        </div>
        <div className="bg-white rounded-lg border border-yellow-200 p-4">
          <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
          <div className="text-sm text-gray-500">Pending</div>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500">Filter:</span>
        {(['all', 'pending', 'draft', 'submitted', 'approved'] as const).map((status) => (
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
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
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
            <CleanerFishReportCard
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
