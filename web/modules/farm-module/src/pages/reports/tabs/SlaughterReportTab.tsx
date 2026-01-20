/**
 * Slaughter Report Tab
 * Planned and completed slaughter (kesim) reports
 */
import React, { useState, useMemo, useCallback } from 'react';
import { mockSlaughterReports } from '../mock/slaughterData';
import {
  SlaughterReport,
  PlannedSlaughter,
  CompletedSlaughter,
  ReportStatus,
  SlaughterReportType,
} from '../types/reports.types';
import { ReportStatusBadge, DeadlineIndicator } from '../components/common';
import { ReportWizard, ReportWizardStep } from '../components/wizard/ReportWizard';

// ============================================================================
// Types
// ============================================================================

interface SlaughterReportTabProps {
  siteId?: string;
}

interface SlaughterFormData {
  reportType: SlaughterReportType;
  plannedSlaughters: PlannedSlaughter[];
  completedSlaughters: CompletedSlaughter[];
  summary: {
    totalPlanned: number;
    totalCompleted: number;
    plannedBiomassKg: number;
    completedBiomassKg: number;
  };
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

function getInitialFormData(): SlaughterFormData {
  return {
    reportType: 'planned',
    plannedSlaughters: [],
    completedSlaughters: [],
    summary: {
      totalPlanned: 0,
      totalCompleted: 0,
      plannedBiomassKg: 0,
      completedBiomassKg: 0,
    },
  };
}

function calculateSummary(planned: PlannedSlaughter[], completed: CompletedSlaughter[]) {
  return {
    totalPlanned: planned.reduce((sum, p) => sum + p.estimatedQuantity, 0),
    totalCompleted: completed.reduce((sum, c) => sum + c.actualQuantity, 0),
    plannedBiomassKg: planned.reduce((sum, p) => sum + p.estimatedBiomassKg, 0),
    completedBiomassKg: completed.reduce((sum, c) => sum + c.actualBiomassKg, 0),
  };
}

// ============================================================================
// Report Card Component
// ============================================================================

interface SlaughterReportCardProps {
  report: SlaughterReport;
  onView: () => void;
  onEdit?: () => void;
}

const SlaughterReportCard: React.FC<SlaughterReportCardProps> = ({ report, onView, onEdit }) => {
  const isPending = report.status === 'pending' || report.status === 'draft';
  const hasVariance = report.summary.totalCompleted > 0 &&
    Math.abs(report.summary.totalCompleted - report.summary.totalPlanned) > 0;

  const variance = report.summary.totalPlanned > 0
    ? ((report.summary.totalCompleted - report.summary.totalPlanned) / report.summary.totalPlanned * 100)
    : 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-100 rounded-lg">
              <svg className="w-5 h-5 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            </div>
            <div>
              <h3 className="font-medium text-gray-900">{report.id}</h3>
              <p className="text-sm text-gray-500">{report.siteName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 text-xs font-medium rounded ${
              report.reportPeriodType === 'planned'
                ? 'bg-blue-100 text-blue-700'
                : 'bg-green-100 text-green-700'
            }`}>
              {report.reportPeriodType === 'planned' ? 'Planned' : 'Completed'}
            </span>
            <ReportStatusBadge status={report.status} size="sm" />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        {/* Key Metrics */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="text-center p-2 bg-blue-50 rounded">
            <div className="text-lg font-bold text-blue-700">{formatNumber(report.summary.totalPlanned)}</div>
            <div className="text-xs text-gray-500">Planned</div>
            <div className="text-xs text-blue-600">{formatWeight(report.summary.plannedBiomassKg)}</div>
          </div>
          <div className="text-center p-2 bg-green-50 rounded">
            <div className="text-lg font-bold text-green-700">{formatNumber(report.summary.totalCompleted)}</div>
            <div className="text-xs text-gray-500">Completed</div>
            <div className="text-xs text-green-600">{formatWeight(report.summary.completedBiomassKg)}</div>
          </div>
        </div>

        {/* Variance */}
        {hasVariance && (
          <div className={`text-center p-2 mb-3 rounded ${
            variance >= 0 ? 'bg-green-50' : 'bg-red-50'
          }`}>
            <span className={`text-sm font-medium ${variance >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              Variance: {variance > 0 ? '+' : ''}{variance.toFixed(1)}%
            </span>
          </div>
        )}

        {/* Slaughter Records Summary */}
        <div className="grid grid-cols-2 gap-2 text-sm pt-3 border-t border-gray-100">
          <div>
            <span className="text-gray-500">Planned Events:</span>
            <span className="ml-1 font-medium">{report.plannedSlaughters.length}</span>
          </div>
          <div>
            <span className="text-gray-500">Completed Events:</span>
            <span className="ml-1 font-medium">{report.completedSlaughters.length}</span>
          </div>
        </div>

        {/* Deadline for pending/draft */}
        {isPending && report.plannedSlaughters.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="text-sm text-gray-500">
              Next planned: {formatDate(report.plannedSlaughters[0].plannedDate)}
            </div>
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
            Update Report
          </button>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Wizard Step Components
// ============================================================================

interface ReportTypeStepProps {
  formData: SlaughterFormData;
  onChange: (data: Partial<SlaughterFormData>) => void;
  siteName: string;
}

const ReportTypeStep: React.FC<ReportTypeStepProps> = ({ formData, onChange, siteName }) => (
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
            <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="font-medium text-gray-900">Planned Slaughter</div>
          <div className="text-sm text-gray-500">Upcoming harvest schedule</div>
        </button>
        <button
          type="button"
          onClick={() => onChange({ reportType: 'completed' })}
          className={`p-4 border-2 rounded-lg text-center ${
            formData.reportType === 'completed'
              ? 'border-green-500 bg-green-50'
              : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <div className="p-3 bg-green-100 rounded-lg inline-block mb-2">
            <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="font-medium text-gray-900">Completed Slaughter</div>
          <div className="text-sm text-gray-500">Record actual harvests</div>
        </button>
      </div>
    </div>
  </div>
);

interface PlannedSlaughterStepProps {
  formData: SlaughterFormData;
  onChange: (data: Partial<SlaughterFormData>) => void;
}

const PlannedSlaughterStep: React.FC<PlannedSlaughterStepProps> = ({ formData, onChange }) => {
  const addPlanned = () => {
    const newPlan: PlannedSlaughter = {
      planId: `plan-${Date.now()}`,
      batchId: '',
      batchNumber: '',
      speciesName: 'Atlantic Salmon',
      plannedDate: new Date(),
      estimatedQuantity: 0,
      estimatedBiomassKg: 0,
      estimatedAvgWeightKg: 0,
      slaughterHouse: '',
      status: 'planned',
    };
    const plannedSlaughters = [...formData.plannedSlaughters, newPlan];
    onChange({
      plannedSlaughters,
      summary: calculateSummary(plannedSlaughters, formData.completedSlaughters),
    });
  };

  const updatePlanned = (index: number, updates: Partial<PlannedSlaughter>) => {
    const plannedSlaughters = formData.plannedSlaughters.map((p, i) => {
      if (i !== index) return p;
      const updated = { ...p, ...updates };
      // Auto-calculate avg weight
      if (updated.estimatedQuantity > 0 && updated.estimatedBiomassKg > 0) {
        updated.estimatedAvgWeightKg = updated.estimatedBiomassKg / updated.estimatedQuantity;
      }
      return updated;
    });
    onChange({
      plannedSlaughters,
      summary: calculateSummary(plannedSlaughters, formData.completedSlaughters),
    });
  };

  const removePlanned = (index: number) => {
    const plannedSlaughters = formData.plannedSlaughters.filter((_, i) => i !== index);
    onChange({
      plannedSlaughters,
      summary: calculateSummary(plannedSlaughters, formData.completedSlaughters),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700">Planned Slaughters</h4>
          <p className="text-xs text-gray-500">Schedule upcoming harvest events</p>
        </div>
        <button
          type="button"
          onClick={addPlanned}
          className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
        >
          + Add Planned
        </button>
      </div>

      {/* Summary */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-sm text-blue-800">Total Planned Fish</span>
            <div className="text-2xl font-bold text-blue-700">{formatNumber(formData.summary.totalPlanned)}</div>
          </div>
          <div>
            <span className="text-sm text-blue-800">Total Planned Biomass</span>
            <div className="text-2xl font-bold text-blue-700">{formatWeight(formData.summary.plannedBiomassKg)}</div>
          </div>
        </div>
      </div>

      {formData.plannedSlaughters.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No planned slaughters</p>
          <p className="text-xs text-gray-400">Click "Add Planned" to schedule a harvest</p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.plannedSlaughters.map((plan, index) => (
            <div key={plan.planId} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm font-medium text-gray-700">Planned #{index + 1}</span>
                <button
                  type="button"
                  onClick={() => removePlanned(index)}
                  className="text-red-500 hover:text-red-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Batch Number</label>
                  <input
                    type="text"
                    value={plan.batchNumber}
                    onChange={(e) => updatePlanned(index, { batchNumber: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="NF-2024-001"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Species</label>
                  <select
                    value={plan.speciesName}
                    onChange={(e) => updatePlanned(index, { speciesName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  >
                    <option value="Atlantic Salmon">Atlantic Salmon</option>
                    <option value="Rainbow Trout">Rainbow Trout</option>
                    <option value="Sea Trout">Sea Trout</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Planned Date</label>
                  <input
                    type="date"
                    value={plan.plannedDate.toISOString().split('T')[0]}
                    onChange={(e) => updatePlanned(index, { plannedDate: new Date(e.target.value) })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Est. Quantity</label>
                  <input
                    type="number"
                    min="0"
                    value={plan.estimatedQuantity || ''}
                    onChange={(e) => updatePlanned(index, { estimatedQuantity: parseInt(e.target.value) || 0 })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Est. Biomass (kg)</label>
                  <input
                    type="number"
                    min="0"
                    value={plan.estimatedBiomassKg || ''}
                    onChange={(e) => updatePlanned(index, { estimatedBiomassKg: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Slaughter House</label>
                  <input
                    type="text"
                    value={plan.slaughterHouse}
                    onChange={(e) => updatePlanned(index, { slaughterHouse: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="Processing facility"
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

interface CompletedSlaughterStepProps {
  formData: SlaughterFormData;
  onChange: (data: Partial<SlaughterFormData>) => void;
}

const CompletedSlaughterStep: React.FC<CompletedSlaughterStepProps> = ({ formData, onChange }) => {
  const addCompleted = () => {
    const newRecord: CompletedSlaughter = {
      recordId: `harv-${Date.now()}`,
      batchId: '',
      batchNumber: '',
      speciesName: 'Atlantic Salmon',
      harvestDate: new Date(),
      actualQuantity: 0,
      actualBiomassKg: 0,
      avgWeightKg: 0,
      slaughterHouse: '',
    };
    const completedSlaughters = [...formData.completedSlaughters, newRecord];
    onChange({
      completedSlaughters,
      summary: calculateSummary(formData.plannedSlaughters, completedSlaughters),
    });
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
      summary: calculateSummary(formData.plannedSlaughters, completedSlaughters),
    });
  };

  const removeCompleted = (index: number) => {
    const completedSlaughters = formData.completedSlaughters.filter((_, i) => i !== index);
    onChange({
      completedSlaughters,
      summary: calculateSummary(formData.plannedSlaughters, completedSlaughters),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700">Completed Slaughters</h4>
          <p className="text-xs text-gray-500">Record actual harvest results</p>
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
            <div className="text-2xl font-bold text-green-700">{formatNumber(formData.summary.totalCompleted)}</div>
          </div>
          <div>
            <span className="text-sm text-green-800">Total Harvested Biomass</span>
            <div className="text-2xl font-bold text-green-700">{formatWeight(formData.summary.completedBiomassKg)}</div>
          </div>
        </div>
      </div>

      {formData.completedSlaughters.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
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
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Batch Number</label>
                  <input
                    type="text"
                    value={record.batchNumber}
                    onChange={(e) => updateCompleted(index, { batchNumber: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="NF-2024-001"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Species</label>
                  <select
                    value={record.speciesName}
                    onChange={(e) => updateCompleted(index, { speciesName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  >
                    <option value="Atlantic Salmon">Atlantic Salmon</option>
                    <option value="Rainbow Trout">Rainbow Trout</option>
                    <option value="Sea Trout">Sea Trout</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Harvest Date</label>
                  <input
                    type="date"
                    value={record.harvestDate.toISOString().split('T')[0]}
                    onChange={(e) => updateCompleted(index, { harvestDate: new Date(e.target.value) })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Actual Quantity</label>
                  <input
                    type="number"
                    min="0"
                    value={record.actualQuantity || ''}
                    onChange={(e) => updateCompleted(index, { actualQuantity: parseInt(e.target.value) || 0 })}
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
                    onChange={(e) => updateCompleted(index, { actualBiomassKg: parseFloat(e.target.value) || 0 })}
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
                  <label className="block text-xs text-gray-500 mb-1">Slaughter House</label>
                  <input
                    type="text"
                    value={record.slaughterHouse}
                    onChange={(e) => updateCompleted(index, { slaughterHouse: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="Processing facility"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Quality Grade</label>
                  <select
                    value={record.qualityGrade || ''}
                    onChange={(e) => updateCompleted(index, { qualityGrade: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  >
                    <option value="">Select grade</option>
                    <option value="Superior">Superior</option>
                    <option value="Ordinary">Ordinary</option>
                    <option value="Production">Production</option>
                  </select>
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
    </div>
  );
};

interface ReviewStepProps {
  formData: SlaughterFormData;
  siteName: string;
}

const ReviewStep: React.FC<ReviewStepProps> = ({ formData, siteName }) => {
  const variance = formData.summary.totalPlanned > 0
    ? ((formData.summary.totalCompleted - formData.summary.totalPlanned) / formData.summary.totalPlanned * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Summary Header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-blue-800">Report Summary</h4>
        <p className="text-sm text-blue-600 mt-1">{siteName}</p>
        <span className={`inline-block mt-2 px-2 py-0.5 text-xs font-medium rounded ${
          formData.reportType === 'planned'
            ? 'bg-blue-100 text-blue-700'
            : 'bg-green-100 text-green-700'
        }`}>
          {formData.reportType === 'planned' ? 'Planned Slaughter Report' : 'Completed Slaughter Report'}
        </span>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{formatNumber(formData.summary.totalPlanned)}</div>
          <div className="text-xs text-gray-500">Planned Fish</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{formatWeight(formData.summary.plannedBiomassKg)}</div>
          <div className="text-xs text-gray-500">Planned Biomass</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{formatNumber(formData.summary.totalCompleted)}</div>
          <div className="text-xs text-gray-500">Completed Fish</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{formatWeight(formData.summary.completedBiomassKg)}</div>
          <div className="text-xs text-gray-500">Completed Biomass</div>
        </div>
      </div>

      {/* Variance */}
      {formData.summary.totalPlanned > 0 && formData.summary.totalCompleted > 0 && (
        <div className={`rounded-lg p-4 ${variance >= 0 ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
          <div className="flex items-center justify-between">
            <span className={`text-sm font-medium ${variance >= 0 ? 'text-green-800' : 'text-red-800'}`}>
              Plan vs Actual Variance
            </span>
            <span className={`text-xl font-bold ${variance >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              {variance > 0 ? '+' : ''}{variance.toFixed(1)}%
            </span>
          </div>
        </div>
      )}

      {/* Planned Slaughters */}
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
                  <span className="font-medium text-gray-900">{formatNumber(p.estimatedQuantity)}</span>
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
            Completed Slaughters ({formData.completedSlaughters.length})
          </h5>
          <div className="space-y-2">
            {formData.completedSlaughters.map((c, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">
                  {c.batchNumber} - {formatDate(c.harvestDate)}
                  {c.qualityGrade && (
                    <span className="ml-2 px-1.5 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">
                      {c.qualityGrade}
                    </span>
                  )}
                </span>
                <div className="text-right">
                  <span className="font-medium text-gray-900">{formatNumber(c.actualQuantity)}</span>
                  <span className="text-gray-500 ml-2">({formatWeight(c.actualBiomassKg)})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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

export const SlaughterReportTab: React.FC<SlaughterReportTabProps> = ({ siteId }) => {
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [selectedReport, setSelectedReport] = useState<SlaughterReport | null>(null);
  const [formData, setFormData] = useState<SlaughterFormData>(getInitialFormData());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<SlaughterReportType | 'all'>('all');

  // Filter reports
  const reports = useMemo(() => {
    let filtered = siteId
      ? mockSlaughterReports.filter((r) => r.siteId === siteId)
      : mockSlaughterReports;

    if (statusFilter !== 'all') {
      filtered = filtered.filter((r) => r.status === statusFilter);
    }

    if (typeFilter !== 'all') {
      filtered = filtered.filter((r) => r.reportPeriodType === typeFilter);
    }

    return filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }, [siteId, statusFilter, typeFilter]);

  // Stats
  const stats = useMemo(() => {
    const totalPlanned = mockSlaughterReports.reduce((sum, r) => sum + r.summary.totalPlanned, 0);
    const totalCompleted = mockSlaughterReports.reduce((sum, r) => sum + r.summary.totalCompleted, 0);
    const pending = mockSlaughterReports.filter((r) => r.status === 'pending' || r.status === 'draft').length;
    return { totalPlanned, totalCompleted, pending, total: mockSlaughterReports.length };
  }, []);

  // Form handlers
  const handleFormChange = useCallback((updates: Partial<SlaughterFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleOpenWizard = useCallback((report?: SlaughterReport) => {
    if (report) {
      setFormData({
        reportType: report.reportPeriodType,
        plannedSlaughters: [...report.plannedSlaughters],
        completedSlaughters: [...report.completedSlaughters],
        summary: { ...report.summary },
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
      console.log('Submitting slaughter report:', formData);
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
        id: 'type',
        title: 'Report Type',
        description: 'Planned or completed',
        content: (
          <ReportTypeStep
            formData={formData}
            onChange={handleFormChange}
            siteName={selectedReport?.siteName || 'Default Site'}
          />
        ),
      },
      {
        id: 'planned',
        title: 'Planned',
        description: 'Upcoming harvests',
        content: <PlannedSlaughterStep formData={formData} onChange={handleFormChange} />,
        optional: formData.reportType === 'completed',
      },
      {
        id: 'completed',
        title: 'Completed',
        description: 'Actual harvests',
        content: <CompletedSlaughterStep formData={formData} onChange={handleFormChange} />,
        optional: formData.reportType === 'planned',
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
          <h2 className="text-lg font-semibold text-gray-900">Slaughter Reports</h2>
          <p className="text-sm text-gray-500">Planned and completed harvest reports</p>
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
        <div className="bg-white rounded-lg border border-blue-200 p-4">
          <div className="text-2xl font-bold text-blue-600">{formatNumber(stats.totalPlanned)}</div>
          <div className="text-sm text-gray-500">Total Planned</div>
        </div>
        <div className="bg-white rounded-lg border border-green-200 p-4">
          <div className="text-2xl font-bold text-green-600">{formatNumber(stats.totalCompleted)}</div>
          <div className="text-sm text-gray-500">Total Completed</div>
        </div>
        <div className="bg-white rounded-lg border border-yellow-200 p-4">
          <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
          <div className="text-sm text-gray-500">Pending</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">Status:</span>
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
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">Type:</span>
          {(['all', 'planned', 'completed'] as const).map((type) => (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={`px-3 py-1.5 text-sm rounded-md ${
                typeFilter === type
                  ? 'bg-purple-100 text-purple-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Reports Grid */}
      {reports.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
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
            <SlaughterReportCard
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
        title="Slaughter Report"
        subtitle={formData.reportType === 'planned' ? 'Planned Harvest Schedule' : 'Completed Harvest Record'}
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
