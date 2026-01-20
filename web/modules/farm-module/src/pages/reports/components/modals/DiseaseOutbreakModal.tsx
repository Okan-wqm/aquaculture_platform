/**
 * Disease Outbreak Modal
 * Quick report modal for immediate disease outbreak reporting
 * Contact: varsling.akva@mattilsynet.no
 */
import React, { useState, useCallback } from 'react';
import { DiseaseOutbreakReport } from '../../types/reports.types';
import { REGULATORY_CONTACTS, DISEASE_LISTS, getDiseaseList } from '../../utils/thresholds';

interface DiseaseOutbreakModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (report: Partial<DiseaseOutbreakReport>) => Promise<void>;
  siteId: string;
  siteName: string;
  siteCode?: string;
  gpsCoordinates?: { lat: number; lng: number };
}

interface FormData {
  diseaseCategory: 'A' | 'C' | 'F';
  diseaseCode: string;
  suspectedOrConfirmed: 'suspected' | 'lab_confirmed';
  estimatedAffected: string;
  affectedPercentage: string;
  clinicalSigns: string[];
  newSign: string;
  immediateActions: string[];
  newAction: string;
  quarantineMeasures: string[];
  newQuarantine: string;
  veterinarianNotified: boolean;
  veterinarianName: string;
  veterinarianContact: string;
}

const initialFormData: FormData = {
  diseaseCategory: 'C',
  diseaseCode: '',
  suspectedOrConfirmed: 'suspected',
  estimatedAffected: '',
  affectedPercentage: '',
  clinicalSigns: [],
  newSign: '',
  immediateActions: [],
  newAction: '',
  quarantineMeasures: [],
  newQuarantine: '',
  veterinarianNotified: false,
  veterinarianName: '',
  veterinarianContact: '',
};

const categoryDescriptions: Record<'A' | 'C' | 'F', { label: string; urgency: string; color: string }> = {
  A: {
    label: 'Liste A - Exotic Diseases',
    urgency: 'IMMEDIATE REPORT REQUIRED',
    color: 'bg-red-100 border-red-300 text-red-800',
  },
  C: {
    label: 'Liste C - Non-exotic Notifiable',
    urgency: 'IMMEDIATE REPORT REQUIRED',
    color: 'bg-orange-100 border-orange-300 text-orange-800',
  },
  F: {
    label: 'Liste F - Other Notifiable',
    urgency: 'Report within 24 hours',
    color: 'bg-yellow-100 border-yellow-300 text-yellow-800',
  },
};

export const DiseaseOutbreakModal: React.FC<DiseaseOutbreakModalProps> = ({
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
    (listField: 'clinicalSigns' | 'immediateActions' | 'quarantineMeasures', inputField: 'newSign' | 'newAction' | 'newQuarantine') => {
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
    (listField: 'clinicalSigns' | 'immediateActions' | 'quarantineMeasures', index: number) => {
      setFormData((prev) => ({
        ...prev,
        [listField]: prev[listField].filter((_, i) => i !== index),
      }));
    },
    []
  );

  const getDiseaseOptions = useCallback((category: 'A' | 'C' | 'F') => {
    return DISEASE_LISTS[category].diseases;
  }, []);

  const getSelectedDiseaseName = useCallback(() => {
    if (!formData.diseaseCode) return null;
    const diseases = getDiseaseOptions(formData.diseaseCategory);
    return diseases.find((d) => d.code === formData.diseaseCode);
  }, [formData.diseaseCategory, formData.diseaseCode, getDiseaseOptions]);

  const validateForm = useCallback((): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.diseaseCode) {
      newErrors.diseaseCode = 'Disease selection is required';
    }

    if (!formData.estimatedAffected || parseInt(formData.estimatedAffected) <= 0) {
      newErrors.estimatedAffected = 'Estimated affected count is required';
    }

    if (formData.clinicalSigns.length === 0) {
      newErrors.clinicalSigns = 'At least one clinical sign is required';
    }

    if (formData.immediateActions.length === 0) {
      newErrors.immediateActions = 'At least one immediate action is required';
    }

    if (formData.veterinarianNotified && !formData.veterinarianName.trim()) {
      newErrors.veterinarianName = 'Veterinarian name is required when notified';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData]);

  const handleSubmit = useCallback(async () => {
    if (!validateForm()) return;

    setIsSubmitting(true);
    try {
      const now = new Date();
      const selectedDisease = getSelectedDiseaseName();

      const report: Partial<DiseaseOutbreakReport> = {
        siteId,
        siteName,
        reportType: 'disease',
        status: 'pending',
        diseaseStatus: 'detected',
        detectedAt: now,
        contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
        createdAt: now,
        updatedAt: now,
        disease: {
          category: formData.diseaseCategory,
          name: selectedDisease?.name || formData.diseaseCode,
          norwegianName: selectedDisease?.norwegianName || '',
          code: formData.diseaseCode,
          suspectedOrConfirmed: formData.suspectedOrConfirmed,
        },
        affectedPopulation: {
          estimatedCount: parseInt(formData.estimatedAffected),
          percentage: formData.affectedPercentage
            ? parseFloat(formData.affectedPercentage)
            : 0,
          batches: [],
          tanks: [],
        },
        facility: {
          siteId,
          siteName,
          siteCode: siteCode || '',
          gpsCoordinates,
        },
        clinicalSigns: formData.clinicalSigns,
        labResults: [],
        immediateActions: formData.immediateActions,
        quarantineMeasures: formData.quarantineMeasures.length > 0
          ? formData.quarantineMeasures
          : undefined,
        veterinarianNotified: formData.veterinarianNotified,
        veterinarianName: formData.veterinarianName || undefined,
        veterinarianContact: formData.veterinarianContact || undefined,
      };

      await onSubmit(report);
      setFormData(initialFormData);
      onClose();
    } catch (error) {
      console.error('Failed to submit disease outbreak:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    formData,
    siteId,
    siteName,
    siteCode,
    gpsCoordinates,
    onSubmit,
    onClose,
    validateForm,
    getSelectedDiseaseName,
  ]);

  if (!isOpen) return null;

  const categoryInfo = categoryDescriptions[formData.diseaseCategory];

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
                      d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
                    />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    Report Disease Outbreak
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
                {siteCode && (
                  <span className="text-sm text-gray-500 ml-2">({siteCode})</span>
                )}
              </div>

              {/* Disease Category */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Disease Category <span className="text-red-500">*</span>
                </label>
                <div className="space-y-2">
                  {(['A', 'C', 'F'] as const).map((cat) => {
                    const info = categoryDescriptions[cat];
                    return (
                      <label
                        key={cat}
                        className={`
                          flex items-center p-3 rounded-md border cursor-pointer
                          ${
                            formData.diseaseCategory === cat
                              ? `${info.color} border-2`
                              : 'border-gray-200 hover:border-gray-300'
                          }
                        `}
                      >
                        <input
                          type="radio"
                          name="diseaseCategory"
                          value={cat}
                          checked={formData.diseaseCategory === cat}
                          onChange={(e) => {
                            handleChange('diseaseCategory', e.target.value as 'A' | 'C' | 'F');
                            handleChange('diseaseCode', '');
                          }}
                          className="h-4 w-4 text-blue-600 border-gray-300"
                        />
                        <div className="ml-3">
                          <span className="block text-sm font-medium">{info.label}</span>
                          <span className="block text-xs">{info.urgency}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Disease Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Disease <span className="text-red-500">*</span>
                </label>
                <select
                  value={formData.diseaseCode}
                  onChange={(e) => handleChange('diseaseCode', e.target.value)}
                  className={`
                    block w-full rounded-md shadow-sm text-sm
                    ${errors.diseaseCode ? 'border-red-300' : 'border-gray-300'}
                    focus:ring-blue-500 focus:border-blue-500
                  `}
                >
                  <option value="">Select disease...</option>
                  {getDiseaseOptions(formData.diseaseCategory).map((disease) => (
                    <option key={disease.code} value={disease.code}>
                      {disease.code} - {disease.name} ({disease.norwegianName})
                    </option>
                  ))}
                </select>
                {errors.diseaseCode && (
                  <p className="mt-1 text-sm text-red-600">{errors.diseaseCode}</p>
                )}
              </div>

              {/* Suspected/Confirmed */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Status
                </label>
                <div className="flex gap-4">
                  {[
                    { value: 'suspected', label: 'Suspected' },
                    { value: 'lab_confirmed', label: 'Lab Confirmed' },
                  ].map((option) => (
                    <label
                      key={option.value}
                      className={`
                        flex items-center px-4 py-2 rounded-md border cursor-pointer
                        ${
                          formData.suspectedOrConfirmed === option.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }
                      `}
                    >
                      <input
                        type="radio"
                        name="suspectedOrConfirmed"
                        value={option.value}
                        checked={formData.suspectedOrConfirmed === option.value}
                        onChange={(e) =>
                          handleChange('suspectedOrConfirmed', e.target.value as 'suspected' | 'lab_confirmed')
                        }
                        className="h-4 w-4 text-blue-600 border-gray-300"
                      />
                      <span className="ml-2 text-sm">{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Affected Population */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Estimated Affected <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    value={formData.estimatedAffected}
                    onChange={(e) => handleChange('estimatedAffected', e.target.value)}
                    className={`
                      block w-full rounded-md shadow-sm text-sm
                      ${errors.estimatedAffected ? 'border-red-300' : 'border-gray-300'}
                      focus:ring-blue-500 focus:border-blue-500
                    `}
                    placeholder="Number of fish"
                  />
                  {errors.estimatedAffected && (
                    <p className="mt-1 text-xs text-red-600">{errors.estimatedAffected}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Percentage (%)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.affectedPercentage}
                    onChange={(e) => handleChange('affectedPercentage', e.target.value)}
                    className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., 5"
                  />
                </div>
              </div>

              {/* Clinical Signs */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Clinical Signs <span className="text-red-500">*</span>
                </label>
                <div className="space-y-2">
                  {formData.clinicalSigns.map((sign, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-md"
                    >
                      <span className="flex-1 text-sm text-gray-700">{sign}</span>
                      <button
                        type="button"
                        onClick={() => removeItem('clinicalSigns', index)}
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
                    value={formData.newSign}
                    onChange={(e) => handleChange('newSign', e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addItem('clinicalSigns', 'newSign');
                      }
                    }}
                    className="flex-1 rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., Reduced appetite, abnormal swimming..."
                  />
                  <button
                    type="button"
                    onClick={() => addItem('clinicalSigns', 'newSign')}
                    className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm"
                  >
                    Add
                  </button>
                </div>
                {errors.clinicalSigns && (
                  <p className="mt-1 text-sm text-red-600">{errors.clinicalSigns}</p>
                )}
              </div>

              {/* Immediate Actions */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Immediate Actions <span className="text-red-500">*</span>
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
                        onClick={() => removeItem('immediateActions', index)}
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
                    value={formData.newAction}
                    onChange={(e) => handleChange('newAction', e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addItem('immediateActions', 'newAction');
                      }
                    }}
                    className="flex-1 rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., Isolated affected cages..."
                  />
                  <button
                    type="button"
                    onClick={() => addItem('immediateActions', 'newAction')}
                    className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm"
                  >
                    Add
                  </button>
                </div>
                {errors.immediateActions && (
                  <p className="mt-1 text-sm text-red-600">{errors.immediateActions}</p>
                )}
              </div>

              {/* Quarantine Measures */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Quarantine Measures
                </label>
                <div className="space-y-2">
                  {formData.quarantineMeasures.map((measure, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2 bg-yellow-50 px-3 py-2 rounded-md border border-yellow-200"
                    >
                      <span className="flex-1 text-sm text-gray-700">{measure}</span>
                      <button
                        type="button"
                        onClick={() => removeItem('quarantineMeasures', index)}
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
                    value={formData.newQuarantine}
                    onChange={(e) => handleChange('newQuarantine', e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addItem('quarantineMeasures', 'newQuarantine');
                      }
                    }}
                    className="flex-1 rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., Movement restrictions..."
                  />
                  <button
                    type="button"
                    onClick={() => addItem('quarantineMeasures', 'newQuarantine')}
                    className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm"
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Veterinarian */}
              <div className="space-y-3 p-4 bg-blue-50 rounded-md border border-blue-200">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.veterinarianNotified}
                    onChange={(e) => handleChange('veterinarianNotified', e.target.checked)}
                    className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                  />
                  <span className="text-sm font-medium text-gray-700">Veterinarian Notified</span>
                </label>
                {formData.veterinarianNotified && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-700 mb-1">
                        Veterinarian Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={formData.veterinarianName}
                        onChange={(e) => handleChange('veterinarianName', e.target.value)}
                        className={`
                          block w-full rounded-md shadow-sm text-sm
                          ${errors.veterinarianName ? 'border-red-300' : 'border-gray-300'}
                          focus:ring-blue-500 focus:border-blue-500
                        `}
                        placeholder="Dr. Name"
                      />
                      {errors.veterinarianName && (
                        <p className="mt-1 text-xs text-red-600">{errors.veterinarianName}</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm text-gray-700 mb-1">Contact</label>
                      <input
                        type="text"
                        value={formData.veterinarianContact}
                        onChange={(e) => handleChange('veterinarianContact', e.target.value)}
                        className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                        placeholder="+47 XXX XX XXX"
                      />
                    </div>
                  </div>
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

export default DiseaseOutbreakModal;
