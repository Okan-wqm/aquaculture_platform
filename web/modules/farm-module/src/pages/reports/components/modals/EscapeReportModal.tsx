/**
 * Escape Report Modal
 * Quick report modal for immediate escape reporting
 * Contact: varsling.akva@mattilsynet.no
 */
import React, { useState, useCallback } from 'react';
import { EscapeReport, EscapeCause } from '../../types/reports.types';
import { REGULATORY_CONTACTS, ESCAPE_CAUSES } from '../../utils/thresholds';

interface EscapeReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (report: Partial<EscapeReport>) => Promise<void>;
  siteId: string;
  siteName: string;
  siteCode?: string;
  gpsCoordinates?: { lat: number; lng: number };
}

interface FormData {
  estimatedCount: string;
  species: string;
  avgWeightG: string;
  cause: EscapeCause;
  causeDescription: string;
  affectedUnitId: string;
  affectedUnitName: string;
  batchNumber: string;
  originalCount: string;
  recapturedCount: string;
  recaptureMethod: string;
  ongoingEfforts: boolean;
  nearbyWildPopulations: boolean;
  riverSystems: string[];
  newRiver: string;
  preventiveMeasures: string[];
  newMeasure: string;
}

const initialFormData: FormData = {
  estimatedCount: '',
  species: 'Atlantic Salmon',
  avgWeightG: '',
  cause: 'unknown',
  causeDescription: '',
  affectedUnitId: '',
  affectedUnitName: '',
  batchNumber: '',
  originalCount: '',
  recapturedCount: '0',
  recaptureMethod: '',
  ongoingEfforts: true,
  nearbyWildPopulations: false,
  riverSystems: [],
  newRiver: '',
  preventiveMeasures: [],
  newMeasure: '',
};

const causeOptions = Object.values(ESCAPE_CAUSES);

export const EscapeReportModal: React.FC<EscapeReportModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  siteId,
  siteName,
  siteCode,
  gpsCoordinates,
}) => {
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = useCallback(
    (field: keyof FormData, value: string | boolean | string[]) => {
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

  const addItem = useCallback(
    (listField: 'riverSystems' | 'preventiveMeasures', inputField: 'newRiver' | 'newMeasure') => {
      const value = formData[inputField].trim();
      if (value) {
        setFormData((prev) => ({
          ...prev,
          [listField]: [...prev[listField], value],
          [inputField]: '',
        }));
      }
    },
    [formData]
  );

  const removeItem = useCallback(
    (listField: 'riverSystems' | 'preventiveMeasures', index: number) => {
      setFormData((prev) => ({
        ...prev,
        [listField]: prev[listField].filter((_, i) => i !== index),
      }));
    },
    []
  );

  const validateForm = useCallback((): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.estimatedCount || parseInt(formData.estimatedCount) <= 0) {
      newErrors.estimatedCount = 'Estimated count is required';
    }

    if (!formData.species.trim()) {
      newErrors.species = 'Species is required';
    }

    if (!formData.cause) {
      newErrors.cause = 'Cause is required';
    }

    if (!formData.causeDescription.trim()) {
      newErrors.causeDescription = 'Cause description is required';
    }

    if (!formData.affectedUnitName.trim()) {
      newErrors.affectedUnitName = 'Affected unit name is required';
    }

    if (formData.preventiveMeasures.length === 0) {
      newErrors.preventiveMeasures = 'At least one preventive measure is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData]);

  const handleSubmit = useCallback(async () => {
    if (!validateForm()) return;

    setIsSubmitting(true);
    try {
      const now = new Date();
      const estimatedCount = parseInt(formData.estimatedCount);
      const avgWeightG = formData.avgWeightG ? parseInt(formData.avgWeightG) : 3500;
      const totalBiomassKg = (estimatedCount * avgWeightG) / 1000;

      const report: Partial<EscapeReport> = {
        siteId,
        siteName,
        reportType: 'escape',
        status: 'pending',
        escapeStatus: 'detected',
        detectedAt: now,
        contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
        createdAt: now,
        updatedAt: now,
        escape: {
          estimatedCount,
          species: formData.species,
          speciesId: formData.species === 'Atlantic Salmon' ? 'SALMON' : 'OTHER',
          avgWeightG,
          totalBiomassKg,
          cause: formData.cause,
          causeDescription: formData.causeDescription,
        },
        affectedUnits: [
          {
            unitId: formData.affectedUnitId || 'unit-temp',
            unitName: formData.affectedUnitName,
            unitType: 'cage' as const,
            batchId: formData.batchNumber ? `batch-${formData.batchNumber}` : 'unknown',
            batchNumber: formData.batchNumber || 'unknown',
            originalCount: formData.originalCount ? parseInt(formData.originalCount) : 0,
            escapedCount: estimatedCount,
          },
        ],
        recovery: {
          recapturedCount: parseInt(formData.recapturedCount) || 0,
          recaptureMethod: formData.recaptureMethod || undefined,
          ongoingEfforts: formData.ongoingEfforts,
          estimatedRemaining: estimatedCount - (parseInt(formData.recapturedCount) || 0),
        },
        environmentalImpact: {
          nearbyWildPopulations: formData.nearbyWildPopulations,
          riverSystems: formData.riverSystems,
          assessmentRequired: formData.nearbyWildPopulations || formData.riverSystems.length > 0,
        },
        preventiveMeasures: formData.preventiveMeasures,
      };

      await onSubmit(report);
      setFormData(initialFormData);
      onClose();
    } catch (error) {
      console.error('Failed to submit escape report:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, siteId, siteName, siteCode, gpsCoordinates, onSubmit, onClose, validateForm]);

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
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Report Fish Escape</h3>
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
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
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
                {siteCode && <span className="text-sm text-gray-500 ml-2">({siteCode})</span>}
              </div>

              {/* Escape Details */}
              <div className="p-4 bg-red-50 rounded-md border border-red-200">
                <h4 className="text-sm font-medium text-gray-900 mb-3">Escape Details</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">
                      Estimated Count <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number"
                      value={formData.estimatedCount}
                      onChange={(e) => handleChange('estimatedCount', e.target.value)}
                      className={`
                        block w-full rounded-md shadow-sm text-sm
                        ${errors.estimatedCount ? 'border-red-300' : 'border-gray-300'}
                        focus:ring-blue-500 focus:border-blue-500
                      `}
                      placeholder="Number of escaped fish"
                    />
                    {errors.estimatedCount && (
                      <p className="mt-1 text-xs text-red-600">{errors.estimatedCount}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">
                      Species <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={formData.species}
                      onChange={(e) => handleChange('species', e.target.value)}
                      className={`
                        block w-full rounded-md shadow-sm text-sm
                        ${errors.species ? 'border-red-300' : 'border-gray-300'}
                        focus:ring-blue-500 focus:border-blue-500
                      `}
                    >
                      <option value="Atlantic Salmon">Atlantic Salmon</option>
                      <option value="Rainbow Trout">Rainbow Trout</option>
                      <option value="Brown Trout">Brown Trout</option>
                      <option value="Other">Other</option>
                    </select>
                    {errors.species && (
                      <p className="mt-1 text-xs text-red-600">{errors.species}</p>
                    )}
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm text-gray-700 mb-1">Average Weight (g)</label>
                  <input
                    type="number"
                    value={formData.avgWeightG}
                    onChange={(e) => handleChange('avgWeightG', e.target.value)}
                    className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., 3500"
                  />
                </div>
              </div>

              {/* Cause */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Escape Cause <span className="text-red-500">*</span>
                </label>
                <select
                  value={formData.cause}
                  onChange={(e) => handleChange('cause', e.target.value as EscapeCause)}
                  className={`
                    block w-full rounded-md shadow-sm text-sm
                    ${errors.cause ? 'border-red-300' : 'border-gray-300'}
                    focus:ring-blue-500 focus:border-blue-500
                  `}
                >
                  {causeOptions.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label} - {option.description}
                    </option>
                  ))}
                </select>
                {errors.cause && (
                  <p className="mt-1 text-sm text-red-600">{errors.cause}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Cause Description <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={formData.causeDescription}
                  onChange={(e) => handleChange('causeDescription', e.target.value)}
                  rows={2}
                  className={`
                    block w-full rounded-md shadow-sm text-sm
                    ${errors.causeDescription ? 'border-red-300' : 'border-gray-300'}
                    focus:ring-blue-500 focus:border-blue-500
                  `}
                  placeholder="Describe how the escape occurred..."
                />
                {errors.causeDescription && (
                  <p className="mt-1 text-sm text-red-600">{errors.causeDescription}</p>
                )}
              </div>

              {/* Affected Unit */}
              <div className="p-4 bg-yellow-50 rounded-md border border-yellow-200">
                <h4 className="text-sm font-medium text-gray-900 mb-3">Affected Unit</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">
                      Unit Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={formData.affectedUnitName}
                      onChange={(e) => handleChange('affectedUnitName', e.target.value)}
                      className={`
                        block w-full rounded-md shadow-sm text-sm
                        ${errors.affectedUnitName ? 'border-red-300' : 'border-gray-300'}
                        focus:ring-blue-500 focus:border-blue-500
                      `}
                      placeholder="e.g., Cage 3"
                    />
                    {errors.affectedUnitName && (
                      <p className="mt-1 text-xs text-red-600">{errors.affectedUnitName}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Batch Number</label>
                    <input
                      type="text"
                      value={formData.batchNumber}
                      onChange={(e) => handleChange('batchNumber', e.target.value)}
                      className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                      placeholder="e.g., NF-2025-001"
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm text-gray-700 mb-1">Original Stock Count</label>
                  <input
                    type="number"
                    value={formData.originalCount}
                    onChange={(e) => handleChange('originalCount', e.target.value)}
                    className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Number before escape"
                  />
                </div>
              </div>

              {/* Recovery Efforts */}
              <div className="p-4 bg-blue-50 rounded-md border border-blue-200">
                <h4 className="text-sm font-medium text-gray-900 mb-3">Recovery Efforts</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Recaptured Count</label>
                    <input
                      type="number"
                      value={formData.recapturedCount}
                      onChange={(e) => handleChange('recapturedCount', e.target.value)}
                      className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Recapture Method</label>
                    <input
                      type="text"
                      value={formData.recaptureMethod}
                      onChange={(e) => handleChange('recaptureMethod', e.target.value)}
                      className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                      placeholder="e.g., Seine netting"
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.ongoingEfforts}
                      onChange={(e) => handleChange('ongoingEfforts', e.target.checked)}
                      className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Recovery efforts ongoing</span>
                  </label>
                </div>
              </div>

              {/* Environmental Impact */}
              <div className="p-4 bg-green-50 rounded-md border border-green-200">
                <h4 className="text-sm font-medium text-gray-900 mb-3">Environmental Impact</h4>
                <div className="space-y-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.nearbyWildPopulations}
                      onChange={(e) => handleChange('nearbyWildPopulations', e.target.checked)}
                      className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                    />
                    <span className="text-sm text-gray-700">Nearby wild salmon populations</span>
                  </label>

                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Nearby River Systems</label>
                    <div className="space-y-2">
                      {formData.riverSystems.map((river, index) => (
                        <div
                          key={index}
                          className="flex items-center gap-2 bg-white px-3 py-2 rounded-md border"
                        >
                          <span className="flex-1 text-sm text-gray-700">{river}</span>
                          <button
                            type="button"
                            onClick={() => removeItem('riverSystems', index)}
                            className="text-gray-400 hover:text-red-500"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={formData.newRiver}
                        onChange={(e) => handleChange('newRiver', e.target.value)}
                        onKeyPress={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addItem('riverSystems', 'newRiver');
                          }
                        }}
                        className="flex-1 rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                        placeholder="Add river system..."
                      />
                      <button
                        type="button"
                        onClick={() => addItem('riverSystems', 'newRiver')}
                        className="px-3 py-2 bg-white text-gray-700 rounded-md hover:bg-gray-50 text-sm border"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Preventive Measures */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Preventive Measures Implemented <span className="text-red-500">*</span>
                </label>
                <div className="space-y-2">
                  {formData.preventiveMeasures.map((measure, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-md"
                    >
                      <span className="flex-1 text-sm text-gray-700">{measure}</span>
                      <button
                        type="button"
                        onClick={() => removeItem('preventiveMeasures', index)}
                        className="text-gray-400 hover:text-red-500"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    value={formData.newMeasure}
                    onChange={(e) => handleChange('newMeasure', e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addItem('preventiveMeasures', 'newMeasure');
                      }
                    }}
                    className="flex-1 rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., Emergency net repair completed..."
                  />
                  <button
                    type="button"
                    onClick={() => addItem('preventiveMeasures', 'newMeasure')}
                    className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm"
                  >
                    Add
                  </button>
                </div>
                {errors.preventiveMeasures && (
                  <p className="mt-1 text-sm text-red-600">{errors.preventiveMeasures}</p>
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
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
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

export default EscapeReportModal;
