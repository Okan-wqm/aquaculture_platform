/**
 * Welfare Event Modal
 * Quick report modal for immediate welfare event reporting
 * Contact: varsling.akva@mattilsynet.no
 */
import React, { useState, useCallback, useMemo } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import {
  WelfareEventReport,
  WelfareEventType,
  WelfareEventSeverity,
} from '../../types/reports.types';
import { REGULATORY_CONTACTS, MORTALITY_THRESHOLDS } from '../../utils/thresholds';
import { useTanksList, Tank } from '../../../../hooks/useTanks';
import { useBatchList, Batch } from '../../../../hooks/useBatches';

interface WelfareEventModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (report: Partial<WelfareEventReport>) => Promise<void>;
  siteId: string;
  siteName: string;
}

interface FormData {
  eventType: WelfareEventType;
  severity: WelfareEventSeverity;
  description: string;
  affectedFishEstimate: string;
  affectedPercentage: string;
  mortalityCount: string;
  mortalityRate: string;
  mortalityPeriod: '1_day' | '3_day' | '7_day';
  equipmentId: string;
  equipmentName: string;
  equipmentType: string;
  failureType: string;
  injuredFishCount: string;
  immediateActions: string[];
  newAction: string;
  affectedBatchIds: string[];
}

const initialFormData: FormData = {
  eventType: 'mortality_threshold',
  severity: 'high',
  description: '',
  affectedFishEstimate: '',
  affectedPercentage: '',
  mortalityCount: '',
  mortalityRate: '',
  mortalityPeriod: '3_day',
  equipmentId: '',
  equipmentName: '',
  equipmentType: '',
  failureType: '',
  injuredFishCount: '',
  immediateActions: [],
  newAction: '',
  affectedBatchIds: [],
};

const eventTypeOptions: { value: WelfareEventType; label: string; description: string }[] = [
  {
    value: 'mortality_threshold',
    label: 'Mortality Threshold Exceeded',
    description: 'Daily mortality rate exceeds regulatory limits',
  },
  {
    value: 'equipment_failure',
    label: 'Equipment Failure',
    description: 'Equipment malfunction affecting fish welfare',
  },
  {
    value: 'welfare_impact',
    label: 'Other Welfare Impact',
    description: 'Other event seriously affecting fish welfare',
  },
];

const severityOptions: { value: WelfareEventSeverity; label: string; color: string }[] = [
  { value: 'high', label: 'High', color: 'text-orange-600' },
  { value: 'critical', label: 'Critical', color: 'text-red-600' },
];

const EQUIPMENT_TYPE_OPTIONS = [
  'Pump',
  'Generator',
  'Net',
  'Feeder',
  'Oxygen System',
  'Camera',
  'Other',
];

const FAILURE_TYPE_OPTIONS = [
  { value: 'Mechanical Failure', label: 'Mechanical Failure' },
  { value: 'Electrical Failure', label: 'Electrical Failure' },
  { value: 'Structural Damage', label: 'Structural Damage' },
  { value: 'Software/Control', label: 'Software/Control' },
  { value: 'Other', label: 'Other' },
];

const SUGGESTED_ACTIONS: Record<WelfareEventType, string[]> = {
  mortality_threshold: [
    'Veterinarian consultation scheduled',
    'Increased monitoring',
    'Fish samples sent to lab',
    'Water quality testing',
  ],
  equipment_failure: [
    'Backup system activated',
    'Emergency repair initiated',
    'Manual operation started',
  ],
  welfare_impact: ['Reduced feeding', 'Increased aeration', 'Staff alert issued'],
};

export const WelfareEventModal: React.FC<WelfareEventModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  siteId,
  siteName,
}) => {
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [equipmentSearch, setEquipmentSearch] = useState('');
  // Submission-level error (e.g. Mattilsynet rejection). Surfaced in a
  // persistent role=alert region; the modal stays OPEN so the operator can
  // act on a legally-immediate report instead of the error being swallowed.
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Fetch tank data for context
  const { data: tanksData } = useTanksList({ siteId, isActive: true });
  const tanks = tanksData?.items || [];

  // Fetch active batches
  const { data: batchesData } = useBatchList({ isActive: true, siteId }, { fetchAll: true });
  const batches = batchesData?.items || [];

  // Tanks with high mortality (rate > threshold)
  const highMortalityTanks = useMemo(() => {
    return tanks.filter(
      (t) =>
        t.batchMetrics?.mortalityRate != null &&
        t.batchMetrics.mortalityRate >= MORTALITY_THRESHOLDS.DAILY.ELEVATED,
    );
  }, [tanks]);

  // Threshold comparison for the entered mortality rate
  const thresholdComparison = useMemo(() => {
    const rate = parseFloat(formData.mortalityRate);
    if (isNaN(rate) || rate <= 0) return null;
    const period = formData.mortalityPeriod;
    let threshold: number;
    let label: string;
    if (period === '1_day') {
      threshold = MORTALITY_THRESHOLDS.DAILY.ELEVATED;
      label = 'Daily threshold';
    } else if (period === '3_day') {
      threshold = MORTALITY_THRESHOLDS.MULTI_DAY.THREE_DAY_HIGH;
      label = '3-day threshold';
    } else {
      threshold = MORTALITY_THRESHOLDS.MULTI_DAY.SEVEN_DAY_CRITICAL;
      label = '7-day threshold';
    }
    return {
      rate,
      threshold,
      label,
      exceeded: rate >= threshold,
      ratio: ((rate / threshold) * 100).toFixed(0),
    };
  }, [formData.mortalityRate, formData.mortalityPeriod]);

  const handleChange = useCallback(
    (field: keyof FormData, value: string | string[]) => {
      setFormData((prev) => ({ ...prev, [field]: value }));
      if (errors[field]) {
        setErrors((prev) => {
          const next = { ...prev };
          delete next[field];
          return next;
        });
      }
    },
    [errors],
  );

  const addAction = useCallback(() => {
    if (formData.newAction.trim()) {
      setFormData((prev) => ({
        ...prev,
        immediateActions: [...prev.immediateActions, prev.newAction.trim()],
        newAction: '',
      }));
    }
  }, [formData.newAction]);

  const addSuggestedAction = useCallback((action: string) => {
    setFormData((prev) => {
      if (prev.immediateActions.includes(action)) return prev;
      return {
        ...prev,
        immediateActions: [...prev.immediateActions, action],
      };
    });
  }, []);

  const removeAction = useCallback((index: number) => {
    setFormData((prev) => ({
      ...prev,
      immediateActions: prev.immediateActions.filter((_, i) => i !== index),
    }));
  }, []);

  const toggleBatch = useCallback((batchId: string) => {
    setFormData((prev) => {
      const ids = prev.affectedBatchIds.includes(batchId)
        ? prev.affectedBatchIds.filter((id) => id !== batchId)
        : [...prev.affectedBatchIds, batchId];
      return { ...prev, affectedBatchIds: ids };
    });
  }, []);

  const validateForm = useCallback((): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.eventType) {
      newErrors.eventType = 'Event type is required';
    }

    if (!formData.severity) {
      newErrors.severity = 'Severity is required';
    }

    if (formData.eventType === 'mortality_threshold') {
      if (!formData.mortalityRate || parseFloat(formData.mortalityRate) <= 0) {
        newErrors.mortalityRate = 'Mortality rate is required';
      }
      if (!formData.mortalityCount || parseInt(formData.mortalityCount) <= 0) {
        newErrors.mortalityCount = 'Mortality count is required';
      }
    }

    if (formData.eventType === 'equipment_failure') {
      if (!formData.equipmentName.trim()) {
        newErrors.equipmentName = 'Equipment name is required';
      }
      if (!formData.failureType.trim()) {
        newErrors.failureType = 'Failure type is required';
      }
    }

    if (formData.eventType === 'welfare_impact') {
      if (!formData.description.trim()) {
        newErrors.description = 'Description is required';
      }
      if (!formData.affectedFishEstimate || parseInt(formData.affectedFishEstimate) <= 0) {
        newErrors.affectedFishEstimate = 'Affected fish estimate is required';
      }
    }

    if (formData.immediateActions.length === 0) {
      newErrors.immediateActions = 'At least one immediate action is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData]);

  const handleSubmit = useCallback(async () => {
    if (!validateForm()) return;

    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const now = new Date();
      const report: Partial<WelfareEventReport> = {
        siteId,
        siteName,
        reportType: 'welfare',
        status: 'pending',
        eventType: formData.eventType,
        severity: formData.severity,
        detectedAt: now,
        contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
        createdAt: now,
        updatedAt: now,
        immediateActions: formData.immediateActions,
      };

      // Add type-specific data
      if (formData.eventType === 'mortality_threshold') {
        const selectedBatches = batches
          .filter((b) => formData.affectedBatchIds.includes(b.id))
          .map((b) => ({
            batchId: b.id,
            batchNumber: b.batchNumber,
            speciesName: b.speciesId,
            mortalityCount: b.totalMortality || 0,
            mortalityRate: b.mortalityRate,
          }));

        report.mortalityData = {
          period: formData.mortalityPeriod,
          threshold: MORTALITY_THRESHOLDS.DAILY.HIGH,
          actualRate: parseFloat(formData.mortalityRate),
          affectedBatches: selectedBatches,
        };
      } else if (formData.eventType === 'equipment_failure') {
        report.equipmentData = {
          equipmentId: formData.equipmentId,
          equipmentName: formData.equipmentName,
          equipmentType: formData.equipmentType || 'Unknown',
          failureType: formData.failureType,
          injuredFishCount: formData.injuredFishCount
            ? parseInt(formData.injuredFishCount)
            : undefined,
          mortalityCount: formData.mortalityCount ? parseInt(formData.mortalityCount) : undefined,
          description: formData.description,
        };
      } else {
        report.welfareData = {
          description: formData.description,
          affectedFishEstimate: parseInt(formData.affectedFishEstimate),
          affectedPercentage: formData.affectedPercentage
            ? parseFloat(formData.affectedPercentage)
            : undefined,
          immediateActions: formData.immediateActions,
          ongoingRisks: [],
        };
      }

      await onSubmit(report);
      setFormData(initialFormData);
      setEquipmentSearch('');
      onClose();
    } catch (error) {
      // Keep the modal open and surface the failure — a swallowed error on a
      // legally-immediate report would leave the operator believing it was
      // filed when Mattilsynet rejected it.
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Failed to submit welfare event. Please review and retry.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, batches, siteId, siteName, onSubmit, onClose, validateForm]);

  const suggestedActions = SUGGESTED_ACTIONS[formData.eventType] || [];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Report Welfare Event"
      description={`Immediate report to ${REGULATORY_CONTACTS.MATTILSYNET_EMAIL}`}
      size="lg"
    >
      <div className="max-h-[60vh] overflow-y-auto space-y-6">
        {/* Submission error (persistent, screen-reader announced) */}
        {submitError && (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-md bg-red-50 border border-red-300 p-3 text-sm text-red-800"
          >
            {submitError}
          </div>
        )}

        {/* Site Info */}
        <div className="bg-gray-50 rounded-md p-3">
          <span className="text-sm text-gray-500">Site: </span>
          <span className="text-sm font-medium text-gray-900">{siteName}</span>
        </div>

        {/* Event Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Event Type <span className="text-red-500">*</span>
          </label>
          <div className="space-y-2">
            {eventTypeOptions.map((option) => (
              <label
                key={option.value}
                className={`
                        flex items-start p-3 rounded-md border cursor-pointer
                        ${
                          formData.eventType === option.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }
                      `}
              >
                <input
                  type="radio"
                  name="eventType"
                  value={option.value}
                  checked={formData.eventType === option.value}
                  onChange={(e) => handleChange('eventType', e.target.value as WelfareEventType)}
                  className="mt-0.5 h-4 w-4 text-blue-600 border-gray-300"
                />
                <div className="ml-3">
                  <span className="block text-sm font-medium text-gray-900">{option.label}</span>
                  <span className="block text-xs text-gray-500">{option.description}</span>
                </div>
              </label>
            ))}
          </div>
          {errors.eventType && <p className="mt-1 text-sm text-red-600">{errors.eventType}</p>}
        </div>

        {/* Severity */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Severity <span className="text-red-500">*</span>
          </label>
          <div className="flex gap-4">
            {severityOptions.map((option) => (
              <label
                key={option.value}
                className={`
                        flex items-center px-4 py-2 rounded-md border cursor-pointer
                        ${
                          formData.severity === option.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }
                      `}
              >
                <input
                  type="radio"
                  name="severity"
                  value={option.value}
                  checked={formData.severity === option.value}
                  onChange={(e) => handleChange('severity', e.target.value as WelfareEventSeverity)}
                  className="h-4 w-4 text-blue-600 border-gray-300"
                />
                <span className={`ml-2 text-sm font-medium ${option.color}`}>{option.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Type-specific fields */}
        {formData.eventType === 'mortality_threshold' && (
          <div className="space-y-4 p-4 bg-orange-50 rounded-md border border-orange-200">
            <h4 className="text-sm font-medium text-gray-900">Mortality Data</h4>

            {/* Tip note */}
            <div className="bg-white rounded-md p-3 border border-orange-100">
              <p className="text-xs text-orange-700">
                Tip: Check Tanks page for current mortality rates
              </p>
              {highMortalityTanks.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-orange-800 mb-1">
                    Tanks with elevated mortality:
                  </p>
                  <div className="space-y-1">
                    {highMortalityTanks.slice(0, 5).map((tank) => (
                      <div key={tank.id} className="flex items-center justify-between text-xs">
                        <span className="text-gray-700">
                          {tank.name} ({tank.code})
                        </span>
                        <span className="font-medium text-red-600">
                          {tank.batchMetrics?.mortalityRate?.toFixed(1)}% mortality
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  Mortality Rate (%) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.mortalityRate}
                  onChange={(e) => handleChange('mortalityRate', e.target.value)}
                  className={`
                          block w-full rounded-md shadow-sm text-sm
                          ${errors.mortalityRate ? 'border-red-300' : 'border-gray-300'}
                          focus:ring-blue-500 focus:border-blue-500
                        `}
                  placeholder="e.g., 2.5"
                />
                {errors.mortalityRate && (
                  <p className="mt-1 text-xs text-red-600">{errors.mortalityRate}</p>
                )}
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  Mortality Count <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  value={formData.mortalityCount}
                  onChange={(e) => handleChange('mortalityCount', e.target.value)}
                  className={`
                          block w-full rounded-md shadow-sm text-sm
                          ${errors.mortalityCount ? 'border-red-300' : 'border-gray-300'}
                          focus:ring-blue-500 focus:border-blue-500
                        `}
                  placeholder="Total dead fish"
                />
                {errors.mortalityCount && (
                  <p className="mt-1 text-xs text-red-600">{errors.mortalityCount}</p>
                )}
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-700 mb-1">Period</label>
              <select
                value={formData.mortalityPeriod}
                onChange={(e) =>
                  handleChange('mortalityPeriod', e.target.value as '1_day' | '3_day' | '7_day')
                }
                className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="1_day">1 Day</option>
                <option value="3_day">3 Days</option>
                <option value="7_day">7 Days</option>
              </select>
            </div>

            {/* Threshold comparison */}
            {thresholdComparison && (
              <div
                className={`rounded-md p-3 text-sm ${
                  thresholdComparison.exceeded
                    ? 'bg-red-100 border border-red-200 text-red-800'
                    : 'bg-green-100 border border-green-200 text-green-800'
                }`}
              >
                {thresholdComparison.exceeded ? (
                  <span>
                    Rate {thresholdComparison.rate}% exceeds {thresholdComparison.label} of{' '}
                    {thresholdComparison.threshold}% ({thresholdComparison.ratio}% of threshold) -
                    Reporting required
                  </span>
                ) : (
                  <span>
                    Rate {thresholdComparison.rate}% is below {thresholdComparison.label} of{' '}
                    {thresholdComparison.threshold}%
                  </span>
                )}
              </div>
            )}

            {/* Affected Batches */}
            {batches.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select Affected Batches
                </label>
                <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-md bg-white">
                  {batches.map((batch) => {
                    // Try to find the tank for this batch
                    const tank = tanks.find((t) => t.batchMetrics?.batchId === batch.id);
                    return (
                      <label
                        key={batch.id}
                        className={`flex items-center px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0 ${
                          formData.affectedBatchIds.includes(batch.id) ? 'bg-blue-50' : ''
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={formData.affectedBatchIds.includes(batch.id)}
                          onChange={() => toggleBatch(batch.id)}
                          className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                        />
                        <div className="ml-3 flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-gray-900 truncate">
                              {batch.batchNumber}
                              {batch.name ? ` - ${batch.name}` : ''}
                            </span>
                            <span className="text-xs text-gray-500 ml-2 flex-shrink-0">
                              {batch.currentQuantity?.toLocaleString()} fish
                            </span>
                          </div>
                          <div className="text-xs text-gray-500">
                            {tank ? `Tank: ${tank.name}` : ''}
                            {batch.mortalityRate != null && (
                              <span
                                className={`ml-2 ${
                                  batch.mortalityRate >= MORTALITY_THRESHOLDS.DAILY.ELEVATED
                                    ? 'text-red-600 font-medium'
                                    : ''
                                }`}
                              >
                                Mortality: {batch.mortalityRate.toFixed(1)}%
                              </span>
                            )}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Water Quality Context */}
            <div className="bg-blue-50 border border-blue-100 rounded-md p-3">
              <p className="text-xs text-blue-700">
                Water quality data will be attached from the most recent measurements when
                submitting to Mattilsynet.
              </p>
            </div>
          </div>
        )}

        {formData.eventType === 'equipment_failure' && (
          <div className="space-y-4 p-4 bg-yellow-50 rounded-md border border-yellow-200">
            <h4 className="text-sm font-medium text-gray-900">Equipment Details</h4>

            {/* Equipment Type Quick Select */}
            <div>
              <label className="block text-sm text-gray-700 mb-1">Equipment Type</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {EQUIPMENT_TYPE_OPTIONS.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      handleChange('equipmentType', type);
                      if (type !== 'Other') {
                        setEquipmentSearch(type);
                      } else {
                        setEquipmentSearch('');
                      }
                    }}
                    className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                      formData.equipmentType === type
                        ? 'bg-blue-100 border-blue-400 text-blue-800'
                        : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  Equipment Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={formData.equipmentName}
                  onChange={(e) => {
                    handleChange('equipmentName', e.target.value);
                    setEquipmentSearch(e.target.value);
                  }}
                  className={`
                          block w-full rounded-md shadow-sm text-sm
                          ${errors.equipmentName ? 'border-red-300' : 'border-gray-300'}
                          focus:ring-blue-500 focus:border-blue-500
                        `}
                  placeholder={
                    formData.equipmentType === 'Other'
                      ? 'Enter custom equipment name'
                      : 'e.g., Main Circulation Pump'
                  }
                />
                {errors.equipmentName && (
                  <p className="mt-1 text-xs text-red-600">{errors.equipmentName}</p>
                )}
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  Failure Type <span className="text-red-500">*</span>
                </label>
                <select
                  value={formData.failureType}
                  onChange={(e) => handleChange('failureType', e.target.value)}
                  className={`
                          block w-full rounded-md shadow-sm text-sm
                          ${errors.failureType ? 'border-red-300' : 'border-gray-300'}
                          focus:ring-blue-500 focus:border-blue-500
                        `}
                >
                  <option value="">Select failure type...</option>
                  {FAILURE_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {errors.failureType && (
                  <p className="mt-1 text-xs text-red-600">{errors.failureType}</p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Injured Fish</label>
                <input
                  type="number"
                  value={formData.injuredFishCount}
                  onChange={(e) => handleChange('injuredFishCount', e.target.value)}
                  className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Mortality Count</label>
                <input
                  type="number"
                  value={formData.mortalityCount}
                  onChange={(e) => handleChange('mortalityCount', e.target.value)}
                  className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="0"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-700 mb-1">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => handleChange('description', e.target.value)}
                rows={2}
                className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                placeholder="Describe the equipment failure and its impact..."
              />
            </div>
          </div>
        )}

        {formData.eventType === 'welfare_impact' && (
          <div className="space-y-4 p-4 bg-blue-50 rounded-md border border-blue-200">
            <h4 className="text-sm font-medium text-gray-900">Welfare Impact Details</h4>
            <div>
              <label className="block text-sm text-gray-700 mb-1">
                Description <span className="text-red-500">*</span>
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => handleChange('description', e.target.value)}
                rows={3}
                className={`
                        block w-full rounded-md shadow-sm text-sm
                        ${errors.description ? 'border-red-300' : 'border-gray-300'}
                        focus:ring-blue-500 focus:border-blue-500
                      `}
                placeholder="Describe the welfare event and its impact on fish..."
              />
              {errors.description && (
                <p className="mt-1 text-xs text-red-600">{errors.description}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  Affected Fish Estimate <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  value={formData.affectedFishEstimate}
                  onChange={(e) => handleChange('affectedFishEstimate', e.target.value)}
                  className={`
                          block w-full rounded-md shadow-sm text-sm
                          ${errors.affectedFishEstimate ? 'border-red-300' : 'border-gray-300'}
                          focus:ring-blue-500 focus:border-blue-500
                        `}
                  placeholder="Number of fish"
                />
                {errors.affectedFishEstimate && (
                  <p className="mt-1 text-xs text-red-600">{errors.affectedFishEstimate}</p>
                )}
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Affected Percentage (%)</label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.affectedPercentage}
                  onChange={(e) => handleChange('affectedPercentage', e.target.value)}
                  className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., 15"
                />
              </div>
            </div>

            {/* Water Quality Context */}
            <div className="bg-blue-100 border border-blue-200 rounded-md p-3">
              <p className="text-xs text-blue-700">
                Water quality data will be attached from the most recent measurements when
                submitting to Mattilsynet.
              </p>
            </div>
          </div>
        )}

        {/* Suggested Immediate Actions */}
        {suggestedActions.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Suggested Actions
            </label>
            <div className="flex flex-wrap gap-2">
              {suggestedActions.map((action) => {
                const isAdded = formData.immediateActions.includes(action);
                return (
                  <button
                    key={action}
                    type="button"
                    onClick={() => addSuggestedAction(action)}
                    disabled={isAdded}
                    className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
                      isAdded
                        ? 'bg-green-100 border-green-300 text-green-700 cursor-default'
                        : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50 hover:border-gray-400'
                    }`}
                  >
                    {isAdded ? (
                      <span className="flex items-center gap-1">
                        <svg
                          className="w-3 h-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                        {action}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <svg
                          className="w-3 h-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                          />
                        </svg>
                        {action}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Immediate Actions */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Immediate Actions Taken <span className="text-red-500">*</span>
          </label>
          <div className="space-y-2">
            {formData.immediateActions.map((action, index) => (
              <div key={index} className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-md">
                <span className="flex-1 text-sm text-gray-700">{action}</span>
                <button
                  type="button"
                  onClick={() => removeAction(index)}
                  className="text-gray-400 hover:text-red-500"
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
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={formData.newAction}
              onChange={(e) => handleChange('newAction', e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addAction();
                }
              }}
              className="flex-1 rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
              placeholder="Add an action taken..."
            />
            <button
              type="button"
              onClick={addAction}
              className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm"
            >
              Add
            </button>
          </div>
          {errors.immediateActions && (
            <p className="mt-1 text-sm text-red-600">{errors.immediateActions}</p>
          )}
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
        <p className="text-xs text-gray-500">
          This report will be sent to Mattilsynet immediately upon submission.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 flex items-center gap-2"
          >
            {isSubmitting ? (
              <>
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Submitting...
              </>
            ) : (
              'Submit Report'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default WelfareEventModal;
