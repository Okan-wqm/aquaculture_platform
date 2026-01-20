/**
 * Welfare Event Modal
 * Quick report modal for immediate welfare event reporting
 * Contact: varsling.akva@mattilsynet.no
 */
import React, { useState, useCallback } from 'react';
import { WelfareEventReport, WelfareEventType, WelfareEventSeverity } from '../../types/reports.types';
import { REGULATORY_CONTACTS, MORTALITY_THRESHOLDS } from '../../utils/thresholds';

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
  failureType: string;
  injuredFishCount: string;
  immediateActions: string[];
  newAction: string;
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
  failureType: '',
  injuredFishCount: '',
  immediateActions: [],
  newAction: '',
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
    [errors]
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

  const removeAction = useCallback((index: number) => {
    setFormData((prev) => ({
      ...prev,
      immediateActions: prev.immediateActions.filter((_, i) => i !== index),
    }));
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
        report.mortalityData = {
          period: formData.mortalityPeriod,
          threshold: MORTALITY_THRESHOLDS.DAILY.HIGH,
          actualRate: parseFloat(formData.mortalityRate),
          affectedBatches: [],
        };
      } else if (formData.eventType === 'equipment_failure') {
        report.equipmentData = {
          equipmentId: formData.equipmentId,
          equipmentName: formData.equipmentName,
          equipmentType: formData.failureType,
          failureType: formData.failureType,
          injuredFishCount: formData.injuredFishCount
            ? parseInt(formData.injuredFishCount)
            : undefined,
          mortalityCount: formData.mortalityCount
            ? parseInt(formData.mortalityCount)
            : undefined,
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
      onClose();
    } catch (error) {
      console.error('Failed to submit welfare event:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, siteId, siteName, onSubmit, onClose, validateForm]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-end justify-center px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
          onClick={onClose}
        />

        {/* Modal */}
        <div className="inline-block w-full max-w-2xl transform overflow-hidden rounded-lg bg-white text-left align-bottom shadow-xl transition-all sm:my-8 sm:align-middle">
          {/* Header */}
          <div className="bg-red-50 px-6 py-4 border-b border-red-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0 rounded-full bg-red-100 p-2">
                  <svg
                    className="h-6 w-6 text-red-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    Report Welfare Event
                  </h3>
                  <p className="text-sm text-gray-600">
                    Immediate report to {REGULATORY_CONTACTS.MATTILSYNET_EMAIL}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md text-gray-400 hover:text-gray-500 focus:outline-none"
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
            <div className="space-y-6">
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
                        <span className="block text-sm font-medium text-gray-900">
                          {option.label}
                        </span>
                        <span className="block text-xs text-gray-500">{option.description}</span>
                      </div>
                    </label>
                  ))}
                </div>
                {errors.eventType && (
                  <p className="mt-1 text-sm text-red-600">{errors.eventType}</p>
                )}
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
                      <span className={`ml-2 text-sm font-medium ${option.color}`}>
                        {option.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Type-specific fields */}
              {formData.eventType === 'mortality_threshold' && (
                <div className="space-y-4 p-4 bg-orange-50 rounded-md border border-orange-200">
                  <h4 className="text-sm font-medium text-gray-900">Mortality Data</h4>
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
                </div>
              )}

              {formData.eventType === 'equipment_failure' && (
                <div className="space-y-4 p-4 bg-yellow-50 rounded-md border border-yellow-200">
                  <h4 className="text-sm font-medium text-gray-900">Equipment Details</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-700 mb-1">
                        Equipment Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={formData.equipmentName}
                        onChange={(e) => handleChange('equipmentName', e.target.value)}
                        className={`
                          block w-full rounded-md shadow-sm text-sm
                          ${errors.equipmentName ? 'border-red-300' : 'border-gray-300'}
                          focus:ring-blue-500 focus:border-blue-500
                        `}
                        placeholder="e.g., Main Circulation Pump"
                      />
                      {errors.equipmentName && (
                        <p className="mt-1 text-xs text-red-600">{errors.equipmentName}</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm text-gray-700 mb-1">
                        Failure Type <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={formData.failureType}
                        onChange={(e) => handleChange('failureType', e.target.value)}
                        className={`
                          block w-full rounded-md shadow-sm text-sm
                          ${errors.failureType ? 'border-red-300' : 'border-gray-300'}
                          focus:ring-blue-500 focus:border-blue-500
                        `}
                        placeholder="e.g., Mechanical failure"
                      />
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
                      <label className="block text-sm text-gray-700 mb-1">
                        Affected Percentage (%)
                      </label>
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
                </div>
              )}

              {/* Immediate Actions */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Immediate Actions Taken <span className="text-red-500">*</span>
                </label>
                <div className="space-y-2">
                  {formData.immediateActions.map((action, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-md"
                    >
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
          </div>

          {/* Footer */}
          <div className="bg-gray-50 px-6 py-4 border-t border-gray-200 flex items-center justify-between">
            <p className="text-xs text-gray-500">
              This report will be sent to Mattilsynet immediately upon submission.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 flex items-center gap-2"
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
        </div>
      </div>
    </div>
  );
};

export default WelfareEventModal;
