/**
 * Smolt Report Tab
 * Monthly settefisk reports for smolt facilities
 * Due 7th of each month
 */
import React, { useState, useMemo, useCallback } from 'react';
import { mockSmoltReports } from '../mock/smoltData';
import {
  SmoltReport,
  SmoltUnitCount,
  SmoltStageWeight,
  SmoltMortalityUnit,
  TransferRecord,
  ReportStatus,
} from '../types/reports.types';
import { ReportStatusBadge, DeadlineIndicator } from '../components/common';
import { ReportWizard, ReportWizardStep } from '../components/wizard/ReportWizard';

// ============================================================================
// Types
// ============================================================================

interface SmoltReportTabProps {
  siteId?: string;
}

interface SmoltFormData {
  month: number;
  year: number;
  facilityType: 'freshwater' | 'land_based';
  fishCounts: {
    byUnit: SmoltUnitCount[];
    total: number;
  };
  averageWeights: {
    overall: number;
    byStage: SmoltStageWeight[];
  };
  mortalityRates: {
    overall: number;
    byUnit: SmoltMortalityUnit[];
  };
  transfers: {
    outgoing: TransferRecord[];
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

function getMonthLabel(month: number, year: number): string {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
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

const STAGES = ['fry', 'parr', 'smolt'] as const;

// ============================================================================
// Report Card Component
// ============================================================================

interface SmoltReportCardProps {
  report: SmoltReport;
  onView: () => void;
  onEdit?: () => void;
}

const SmoltReportCard: React.FC<SmoltReportCardProps> = ({ report, onView, onEdit }) => {
  const isPending = report.status === 'pending' || report.status === 'overdue';

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cyan-100 rounded-lg">
              <svg className="w-5 h-5 text-cyan-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <div>
              <h3 className="font-medium text-gray-900">{getMonthLabel(report.month, report.year)}</h3>
              <p className="text-sm text-gray-500">{report.siteName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 text-xs font-medium rounded ${
              report.facilityType === 'land_based'
                ? 'bg-blue-100 text-blue-700'
                : 'bg-cyan-100 text-cyan-700'
            }`}>
              {report.facilityType === 'land_based' ? 'Land Based' : 'Freshwater'}
            </span>
            <ReportStatusBadge status={report.status} size="sm" />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        {/* Key Metrics */}
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="text-center p-2 bg-blue-50 rounded">
            <div className="text-lg font-bold text-blue-700">{formatNumber(report.fishCounts.total)}</div>
            <div className="text-xs text-gray-500">Total Fish</div>
          </div>
          <div className="text-center p-2 bg-green-50 rounded">
            <div className="text-lg font-bold text-green-700">{report.averageWeights.overall.toFixed(1)}g</div>
            <div className="text-xs text-gray-500">Avg Weight</div>
          </div>
          <div className="text-center p-2 bg-red-50 rounded">
            <div className="text-lg font-bold text-red-700">{report.mortalityRates.overall.toFixed(2)}%</div>
            <div className="text-xs text-gray-500">Mortality</div>
          </div>
        </div>

        {/* Stage Breakdown */}
        {report.averageWeights.byStage.length > 0 && (
          <div className="flex items-center gap-2 text-sm pt-3 border-t border-gray-100">
            {report.averageWeights.byStage.map((stage) => (
              <span key={stage.stage} className="px-2 py-1 bg-gray-100 rounded text-gray-600">
                {stage.stage}: {formatNumber(stage.quantity)}
              </span>
            ))}
          </div>
        )}

        {/* Transfers */}
        {report.transfers?.outgoing && report.transfers.outgoing.length > 0 && (
          <div className="mt-2 text-sm">
            <span className="text-gray-500">Transfers:</span>
            <span className="ml-1 font-medium text-cyan-600">
              {report.transfers.outgoing.length} ({formatNumber(report.transfers.outgoing.reduce((sum, t) => sum + t.quantity, 0))} fish)
            </span>
          </div>
        )}

        {/* Deadline for pending */}
        {isPending && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <DeadlineIndicator deadline={report.deadline} status={report.status} reportType="Smolt" />
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
}

const FishCountsStep: React.FC<FishCountsStepProps> = ({ formData, onChange }) => {
  const addUnit = () => {
    const newUnit: SmoltUnitCount = {
      unitId: `unit-${Date.now()}`,
      unitName: '',
      unitType: 'tank',
      quantity: 0,
      avgWeightG: 0,
      stage: 'fry',
    };
    const byUnit = [...formData.fishCounts.byUnit, newUnit];
    onChange({
      fishCounts: {
        byUnit,
        total: byUnit.reduce((sum, u) => sum + u.quantity, 0),
      },
    });
  };

  const updateUnit = (index: number, updates: Partial<SmoltUnitCount>) => {
    const byUnit = formData.fishCounts.byUnit.map((u, i) =>
      i === index ? { ...u, ...updates } : u
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-700">Fish Counts by Unit</h4>
          <p className="text-xs text-gray-500">Record fish in each production unit</p>
        </div>
        <button
          type="button"
          onClick={addUnit}
          className="px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50"
        >
          + Add Unit
        </button>
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
          <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
          </svg>
          <p className="mt-2 text-sm text-gray-500">No units added</p>
          <p className="text-xs text-gray-400">Click "Add Unit" to record fish in tanks/raceways</p>
        </div>
      ) : (
        <div className="space-y-3">
          {formData.fishCounts.byUnit.map((unit, index) => (
            <div key={unit.unitId} className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-start justify-between mb-3">
                <span className="text-sm font-medium text-gray-700">Unit #{index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeUnit(index)}
                  className="text-red-500 hover:text-red-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Unit Name</label>
                  <input
                    type="text"
                    value={unit.unitName}
                    onChange={(e) => updateUnit(index, { unitName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                    placeholder="Tank A1"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Type</label>
                  <select
                    value={unit.unitType}
                    onChange={(e) => updateUnit(index, { unitType: e.target.value as 'tank' | 'raceway' | 'pond' })}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  >
                    <option value="tank">Tank</option>
                    <option value="raceway">Raceway</option>
                    <option value="pond">Pond</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Stage</label>
                  <select
                    value={unit.stage}
                    onChange={(e) => updateUnit(index, { stage: e.target.value as 'fry' | 'parr' | 'smolt' })}
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
                    onChange={(e) => updateUnit(index, { quantity: parseInt(e.target.value) || 0 })}
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
                    onChange={(e) => updateUnit(index, { avgWeightG: parseFloat(e.target.value) || 0 })}
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

interface MortalityStepProps {
  formData: SmoltFormData;
  onChange: (data: Partial<SmoltFormData>) => void;
}

const MortalityStep: React.FC<MortalityStepProps> = ({ formData, onChange }) => {
  // Calculate from unit data
  const calculateMortality = () => {
    if (formData.fishCounts.byUnit.length === 0) return;

    const byUnit: SmoltMortalityUnit[] = formData.fishCounts.byUnit.map((unit) => ({
      unitId: unit.unitId,
      unitName: unit.unitName,
      rate: 0,
      count: 0,
    }));

    onChange({
      mortalityRates: {
        byUnit,
        overall: 0,
      },
    });
  };

  const updateMortality = (index: number, updates: Partial<SmoltMortalityUnit>) => {
    const byUnit = formData.mortalityRates.byUnit.map((m, i) =>
      i === index ? { ...m, ...updates } : m
    );
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

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-700">Mortality Rates by Unit</h4>
        <p className="text-xs text-gray-500">Record mortality for each production unit</p>
      </div>

      {/* Overall Summary */}
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-red-800">Overall Mortality Rate</span>
          <span className="text-2xl font-bold text-red-700">
            {formData.mortalityRates.overall.toFixed(2)}%
          </span>
        </div>
      </div>

      {formData.mortalityRates.byUnit.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <p className="text-sm text-gray-500">Add fish counts first to record mortality by unit</p>
        </div>
      ) : (
        <div className="space-y-2">
          {formData.mortalityRates.byUnit.map((mort, index) => (
            <div key={mort.unitId} className="flex items-center gap-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex-1">
                <span className="text-sm font-medium text-gray-700">
                  {mort.unitName || `Unit ${index + 1}`}
                </span>
              </div>
              <div className="w-32">
                <label className="block text-xs text-gray-500 mb-1">Dead Fish</label>
                <input
                  type="number"
                  min="0"
                  value={mort.count || ''}
                  onChange={(e) => updateMortality(index, { count: parseInt(e.target.value) || 0 })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                  placeholder="0"
                />
              </div>
              <div className="w-24 text-right">
                <span className="text-sm text-gray-500">Rate:</span>
                <span className="ml-1 font-medium text-red-600">{mort.rate.toFixed(2)}%</span>
              </div>
            </div>
          ))}
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

  return (
    <div className="space-y-6">
      {/* Summary Header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-blue-800">Report Summary</h4>
        <p className="text-sm text-blue-600 mt-1">
          {siteName} - {getMonthLabel(formData.month, formData.year)}
        </p>
        <span className={`inline-block mt-2 px-2 py-0.5 text-xs font-medium rounded ${
          formData.facilityType === 'land_based'
            ? 'bg-blue-100 text-blue-700'
            : 'bg-cyan-100 text-cyan-700'
        }`}>
          {formData.facilityType === 'land_based' ? 'Land Based Facility' : 'Freshwater Facility'}
        </span>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{formatNumber(formData.fishCounts.total)}</div>
          <div className="text-xs text-gray-500">Total Fish</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{formData.averageWeights.overall.toFixed(1)}g</div>
          <div className="text-xs text-gray-500">Avg Weight</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
          <div className="text-2xl font-bold text-red-600">{formData.mortalityRates.overall.toFixed(2)}%</div>
          <div className="text-xs text-gray-500">Mortality Rate</div>
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

      {/* Unit Summary */}
      {formData.fishCounts.byUnit.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h5 className="text-xs font-medium text-gray-500 uppercase mb-3">
            Production Units ({formData.fishCounts.byUnit.length})
          </h5>
          <div className="space-y-2 max-h-40 overflow-y-auto">
            {formData.fishCounts.byUnit.map((unit, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">{unit.unitName || `Unit ${i + 1}`}</span>
                <div className="text-right">
                  <span className="font-medium text-gray-900">{formatNumber(unit.quantity)}</span>
                  <span className="text-gray-500 ml-2">({unit.avgWeightG.toFixed(1)}g)</span>
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
          This report will be submitted to the Norwegian Food Safety Authority.
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
  const [selectedReport, setSelectedReport] = useState<SmoltReport | null>(null);
  const [formData, setFormData] = useState<SmoltFormData>(getInitialFormData());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'all'>('all');

  // Filter reports
  const reports = useMemo(() => {
    let filtered = siteId
      ? mockSmoltReports.filter((r) => r.siteId === siteId)
      : mockSmoltReports;

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
    const totalFish = mockSmoltReports.reduce((sum, r) => sum + r.fishCounts.total, 0);
    const pending = mockSmoltReports.filter((r) => r.status === 'pending' || r.status === 'overdue').length;
    const landBased = mockSmoltReports.filter((r) => r.facilityType === 'land_based').length;
    return { totalFish, pending, landBased, total: mockSmoltReports.length };
  }, []);

  // Form handlers
  const handleFormChange = useCallback((updates: Partial<SmoltFormData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleOpenWizard = useCallback((report?: SmoltReport) => {
    if (report) {
      setFormData({
        month: report.month,
        year: report.year,
        facilityType: report.facilityType,
        fishCounts: { ...report.fishCounts },
        averageWeights: { ...report.averageWeights },
        mortalityRates: { ...report.mortalityRates },
        transfers: { outgoing: report.transfers?.outgoing || [] },
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
      console.log('Submitting smolt report:', formData);
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
        title: 'Facility Info',
        description: 'Period and facility type',
        content: (
          <BasicInfoStep
            formData={formData}
            onChange={handleFormChange}
            siteName={selectedReport?.siteName || 'Default Smolt Facility'}
          />
        ),
      },
      {
        id: 'fish-counts',
        title: 'Fish Counts',
        description: 'Fish by production unit',
        content: <FishCountsStep formData={formData} onChange={handleFormChange} />,
        isValid: () => formData.fishCounts.byUnit.length > 0 && formData.fishCounts.total > 0,
      },
      {
        id: 'mortality',
        title: 'Mortality',
        description: 'Mortality rates',
        content: <MortalityStep formData={formData} onChange={handleFormChange} />,
      },
      {
        id: 'review',
        title: 'Review',
        description: 'Verify and submit',
        content: <ReviewStep formData={formData} siteName={selectedReport?.siteName || 'Default Smolt Facility'} />,
      },
    ],
    [formData, handleFormChange, selectedReport]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Smolt Reports</h2>
          <p className="text-sm text-gray-500">Monthly settefisk reports - Due 7th of each month</p>
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
          <div className="text-2xl font-bold text-blue-600">{formatNumber(stats.totalFish)}</div>
          <div className="text-sm text-gray-500">Total Fish</div>
        </div>
        <div className="bg-white rounded-lg border border-cyan-200 p-4">
          <div className="text-2xl font-bold text-cyan-600">{stats.landBased}</div>
          <div className="text-sm text-gray-500">Land Based</div>
        </div>
        <div className="bg-white rounded-lg border border-yellow-200 p-4">
          <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
          <div className="text-sm text-gray-500">Pending</div>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500">Filter:</span>
        {(['all', 'pending', 'draft', 'approved'] as const).map((status) => (
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
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
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
            <SmoltReportCard
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
