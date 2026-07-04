/**
 * Disease Outbreak Modal
 * Quick report modal for immediate disease outbreak reporting
 * Connected to Health Events system with tank/batch selection
 * Contact: varsling.akva@mattilsynet.no
 */
import React, { useState, useCallback, useMemo } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import { DiseaseOutbreakReport, AffectedBatch } from '../../types/reports.types';
import { REGULATORY_CONTACTS, DISEASE_LISTS } from '../../utils/thresholds';
import { useTanksList, Tank } from '../../../../hooks/useTanks';

interface DiseaseOutbreakModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (report: Partial<DiseaseOutbreakReport>) => Promise<void>;
  siteId: string;
  siteName: string;
  siteCode?: string;
  gpsCoordinates?: { lat: number; lng: number };
  showHealthEventLink?: boolean;
}

interface LabResultForm {
  sampleType: 'Tissue' | 'Water' | 'Mucus' | 'Blood' | 'Other';
  sampleDate: string;
  labName: string;
  testType: string;
  result: string;
  conclusion: string;
}

const emptyLabResult: LabResultForm = {
  sampleType: 'Tissue',
  sampleDate: '',
  labName: '',
  testType: '',
  result: '',
  conclusion: '',
};

interface FormData {
  diseaseCategory: 'A' | 'C' | 'F';
  diseaseCode: string;
  suspectedOrConfirmed: 'suspected' | 'lab_confirmed';
  severity: 'minor' | 'moderate' | 'severe' | 'critical';
  estimatedAffected: string;
  affectedPercentage: string;
  selectedTankIds: string[];
  clinicalSigns: string[];
  newSign: string;
  immediateActions: string[];
  newAction: string;
  quarantineMeasures: string[];
  newQuarantine: string;
  veterinarianNotified: boolean;
  veterinarianName: string;
  veterinarianContact: string;
  healthEventRef: string;
  labResults: LabResultForm[];
  showLabSection: boolean;
}

const initialFormData: FormData = {
  diseaseCategory: 'C',
  diseaseCode: '',
  suspectedOrConfirmed: 'suspected',
  severity: 'moderate',
  estimatedAffected: '',
  affectedPercentage: '',
  selectedTankIds: [],
  clinicalSigns: [],
  newSign: '',
  immediateActions: [],
  newAction: '',
  quarantineMeasures: [],
  newQuarantine: '',
  veterinarianNotified: false,
  veterinarianName: '',
  veterinarianContact: '',
  healthEventRef: '',
  labResults: [],
  showLabSection: false,
};

const categoryDescriptions: Record<
  'A' | 'C' | 'F',
  { label: string; urgency: string; color: string }
> = {
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

// Predefined clinical sign suggestions by disease type
const CLINICAL_SIGN_SUGGESTIONS: Record<string, string[]> = {
  Bacterial: ['Lesions', 'Hemorrhage', 'Swollen abdomen', 'Loss of appetite', 'Lethargy'],
  Viral: ['Abnormal swimming', 'Darkening', 'Hemorrhage in organs', 'Sudden mortality'],
  Parasitic: ['Flashing', 'Gill damage', 'Mucus production', 'Skin damage'],
  Fungal: ['Cotton-like growth', 'White patches', 'Gill necrosis'],
};

// Map disease category to likely clinical sign type for suggestions
function getClinicalSignCategories(_category: 'A' | 'C' | 'F'): string[] {
  // All categories can show all clinical sign types
  return ['Bacterial', 'Viral', 'Parasitic', 'Fungal'];
}

const severityOptions: { value: FormData['severity']; label: string; color: string }[] = [
  { value: 'minor', label: 'Minor', color: 'bg-blue-50 border-blue-300 text-blue-800' },
  { value: 'moderate', label: 'Moderate', color: 'bg-yellow-50 border-yellow-300 text-yellow-800' },
  { value: 'severe', label: 'Severe', color: 'bg-orange-50 border-orange-300 text-orange-800' },
  { value: 'critical', label: 'Critical', color: 'bg-red-50 border-red-300 text-red-800' },
];

export const DiseaseOutbreakModal: React.FC<DiseaseOutbreakModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  siteId,
  siteName,
  siteCode,
  gpsCoordinates,
  showHealthEventLink = false,
}) => {
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [healthEventExpanded, setHealthEventExpanded] = useState(showHealthEventLink);
  // Submission-level error (e.g. Mattilsynet rejection). Surfaced in a
  // persistent role=alert region; the modal stays OPEN so the operator can
  // act on a legally-immediate report instead of the error being swallowed.
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Fetch tanks for selection
  const { data: tanksData } = useTanksList({ isActive: true });
  const tanks = useMemo(() => tanksData?.items || [], [tanksData]);

  // Get selected tanks with batch info
  const selectedTanks = useMemo(() => {
    return tanks.filter((t: Tank) => formData.selectedTankIds.includes(t.id));
  }, [tanks, formData.selectedTankIds]);

  const handleChange = useCallback(
    (
      field: keyof FormData,
      value: string | boolean | string[] | LabResultForm[] | FormData['severity'],
    ) => {
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

  const addItem = useCallback(
    (
      listField: 'clinicalSigns' | 'immediateActions' | 'quarantineMeasures',
      inputField: 'newSign' | 'newAction' | 'newQuarantine',
    ) => {
      const value = formData[inputField].trim();
      if (value) {
        setFormData((prev) => ({
          ...prev,
          [listField]: [...prev[listField], value],
          [inputField]: '',
        }));
      }
    },
    [formData],
  );

  const removeItem = useCallback(
    (listField: 'clinicalSigns' | 'immediateActions' | 'quarantineMeasures', index: number) => {
      setFormData((prev) => ({
        ...prev,
        [listField]: prev[listField].filter((_, i) => i !== index),
      }));
    },
    [],
  );

  const addClinicalSign = useCallback((sign: string) => {
    setFormData((prev) => {
      if (prev.clinicalSigns.includes(sign)) return prev;
      return { ...prev, clinicalSigns: [...prev.clinicalSigns, sign] };
    });
  }, []);

  const toggleTank = useCallback((tankId: string) => {
    setFormData((prev) => {
      const ids = prev.selectedTankIds.includes(tankId)
        ? prev.selectedTankIds.filter((id) => id !== tankId)
        : [...prev.selectedTankIds, tankId];
      return { ...prev, selectedTankIds: ids };
    });
  }, []);

  const addLabResult = useCallback(() => {
    setFormData((prev) => ({
      ...prev,
      labResults: [...prev.labResults, { ...emptyLabResult }],
      showLabSection: true,
    }));
  }, []);

  const updateLabResult = useCallback(
    (index: number, field: keyof LabResultForm, value: string) => {
      setFormData((prev) => {
        const updated = [...prev.labResults];
        updated[index] = { ...updated[index], [field]: value };
        return { ...prev, labResults: updated };
      });
    },
    [],
  );

  const removeLabResult = useCallback((index: number) => {
    setFormData((prev) => ({
      ...prev,
      labResults: prev.labResults.filter((_, i) => i !== index),
    }));
  }, []);

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

    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const now = new Date();
      const selectedDisease = getSelectedDiseaseName();

      // Build affected batches from selected tanks
      const affectedBatches: AffectedBatch[] = selectedTanks
        .filter((t: Tank) => t.batchMetrics?.batchId)
        .map((t: Tank) => ({
          batchId: t.batchMetrics!.batchId!,
          batchNumber: t.batchMetrics!.batchNumber || '',
          speciesName: t.batchMetrics!.speciesCode || undefined,
          mortalityCount: 0,
          mortalityRate: t.batchMetrics!.mortalityRate || undefined,
        }));

      const affectedTankNames = selectedTanks.map((t: Tank) => t.name);

      // Build lab results
      const labResults = formData.labResults
        .filter((lr) => lr.labName.trim() || lr.result.trim())
        .map((lr, idx) => ({
          id: `lab-${idx}`,
          labName: lr.labName,
          sampleDate: lr.sampleDate ? new Date(lr.sampleDate) : new Date(),
          testType: lr.testType,
          result: lr.result,
          interpretation: lr.conclusion || undefined,
        }));

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
          percentage: formData.affectedPercentage ? parseFloat(formData.affectedPercentage) : 0,
          batches: affectedBatches,
          tanks: affectedTankNames,
        },
        facility: {
          siteId,
          siteName,
          siteCode: siteCode || '',
          gpsCoordinates,
        },
        clinicalSigns: formData.clinicalSigns,
        labResults,
        immediateActions: formData.immediateActions,
        quarantineMeasures:
          formData.quarantineMeasures.length > 0 ? formData.quarantineMeasures : undefined,
        veterinarianNotified: formData.veterinarianNotified,
        veterinarianName: formData.veterinarianName || undefined,
        veterinarianContact: formData.veterinarianContact || undefined,
      };

      await onSubmit(report);
      setFormData(initialFormData);
      onClose();
    } catch (error) {
      // Keep the modal open and surface the failure — a swallowed error on a
      // legally-immediate report would leave the operator believing it was
      // filed when Mattilsynet rejected it.
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Failed to submit disease outbreak report. Please review and retry.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [
    formData,
    siteId,
    siteName,
    siteCode,
    gpsCoordinates,
    selectedTanks,
    onSubmit,
    onClose,
    validateForm,
    getSelectedDiseaseName,
  ]);

  const signCategories = getClinicalSignCategories(formData.diseaseCategory);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Report Disease Outbreak"
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

        {/* Link to Health Event (Optional) */}
        <div className="border border-gray-200 rounded-md">
          <button
            type="button"
            onClick={() => setHealthEventExpanded(!healthEventExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <div className="flex items-center gap-2">
              <svg
                className="w-4 h-4 text-blue-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                />
              </svg>
              <span>Link to existing Health Event (optional)</span>
            </div>
            <svg
              className={`w-4 h-4 text-gray-400 transition-transform ${healthEventExpanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          {healthEventExpanded && (
            <div className="px-4 pb-4 border-t border-gray-100">
              <p className="text-xs text-gray-500 mt-2 mb-2">
                Linking to a health event will auto-populate disease details.
              </p>
              <input
                type="text"
                value={formData.healthEventRef}
                onChange={(e) => handleChange('healthEventRef', e.target.value)}
                className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                placeholder="Enter Health Event ID or reference..."
              />
            </div>
          )}
        </div>

        {/* Site Info */}
        <div className="bg-gray-50 rounded-md p-3">
          <span className="text-sm text-gray-500">Site: </span>
          <span className="text-sm font-medium text-gray-900">{siteName}</span>
          {siteCode && <span className="text-sm text-gray-500 ml-2">({siteCode})</span>}
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
          {errors.diseaseCode && <p className="mt-1 text-sm text-red-600">{errors.diseaseCode}</p>}
        </div>

        {/* Suspected/Confirmed */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
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
                    handleChange(
                      'suspectedOrConfirmed',
                      e.target.value as 'suspected' | 'lab_confirmed',
                    )
                  }
                  className="h-4 w-4 text-blue-600 border-gray-300"
                />
                <span className="ml-2 text-sm">{option.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Severity */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Severity <span className="text-red-500">*</span>
          </label>
          <div className="grid grid-cols-4 gap-2">
            {severityOptions.map((opt) => (
              <label
                key={opt.value}
                className={`
                        flex items-center justify-center px-3 py-2 rounded-md border cursor-pointer text-sm font-medium
                        ${
                          formData.severity === opt.value
                            ? `${opt.color} border-2`
                            : 'border-gray-200 hover:border-gray-300 text-gray-700'
                        }
                      `}
              >
                <input
                  type="radio"
                  name="severity"
                  value={opt.value}
                  checked={formData.severity === opt.value}
                  onChange={(e) => handleChange('severity', e.target.value as FormData['severity'])}
                  className="sr-only"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        {/* Affected Tank(s) Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Affected Tank(s)</label>
          <div className="border border-gray-200 rounded-md max-h-40 overflow-y-auto">
            {tanks.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500">No tanks available</div>
            ) : (
              tanks.map((tank: Tank) => {
                const isSelected = formData.selectedTankIds.includes(tank.id);
                return (
                  <label
                    key={tank.id}
                    className={`flex items-center px-3 py-2 cursor-pointer border-b border-gray-100 last:border-b-0 ${
                      isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleTank(tank.id)}
                      className="h-4 w-4 text-blue-600 border-gray-300 rounded"
                    />
                    <div className="ml-3 flex-1">
                      <span className="text-sm font-medium text-gray-900">{tank.name}</span>
                      <span className="text-xs text-gray-500 ml-2">({tank.code})</span>
                      {tank.batchMetrics?.batchNumber && (
                        <span className="text-xs text-gray-500 ml-2">
                          - Batch: {tank.batchMetrics.batchNumber}
                        </span>
                      )}
                    </div>
                    {tank.batchMetrics?.pieces && (
                      <span className="text-xs text-gray-400">
                        {tank.batchMetrics.pieces.toLocaleString()} fish
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>
          {/* Show selected tank batch info */}
          {selectedTanks.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-xs font-medium text-gray-500 uppercase">
                Selected Tanks - Batch Info
              </div>
              {selectedTanks.map((tank: Tank) => (
                <div
                  key={tank.id}
                  className="flex items-center gap-2 bg-blue-50 px-3 py-1.5 rounded text-xs"
                >
                  <span className="font-medium text-gray-700">{tank.name}</span>
                  {tank.batchMetrics ? (
                    <>
                      <span className="text-gray-500">|</span>
                      <span className="text-gray-600">
                        Batch: {tank.batchMetrics.batchNumber || 'N/A'}
                      </span>
                      {tank.batchMetrics.speciesCode && (
                        <>
                          <span className="text-gray-500">|</span>
                          <span className="text-gray-600">
                            Species: {tank.batchMetrics.speciesCode}
                          </span>
                        </>
                      )}
                      {tank.batchMetrics.pieces && (
                        <>
                          <span className="text-gray-500">|</span>
                          <span className="text-gray-600">
                            {tank.batchMetrics.pieces.toLocaleString()} fish
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="text-gray-400">No batch data</span>
                  )}
                </div>
              ))}
            </div>
          )}
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Percentage (%)</label>
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

          {/* Predefined symptom suggestions */}
          <div className="mb-3">
            {signCategories.map((cat) => (
              <div key={cat} className="mb-2">
                <div className="text-xs font-medium text-gray-500 mb-1">{cat}:</div>
                <div className="flex flex-wrap gap-1">
                  {CLINICAL_SIGN_SUGGESTIONS[cat].map((sign) => {
                    const isAdded = formData.clinicalSigns.includes(sign);
                    return (
                      <button
                        key={sign}
                        type="button"
                        onClick={() => addClinicalSign(sign)}
                        disabled={isAdded}
                        className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                          isAdded
                            ? 'bg-blue-100 border-blue-300 text-blue-700 cursor-default'
                            : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-100 hover:border-gray-400 cursor-pointer'
                        }`}
                      >
                        {isAdded ? '+ ' : ''}
                        {sign}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Selected signs */}
          <div className="space-y-2">
            {formData.clinicalSigns.map((sign, index) => (
              <div key={index} className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-md">
                <span className="flex-1 text-sm text-gray-700">{sign}</span>
                <button
                  type="button"
                  onClick={() => removeItem('clinicalSigns', index)}
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
              value={formData.newSign}
              onChange={(e) => handleChange('newSign', e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addItem('clinicalSigns', 'newSign');
                }
              }}
              className="flex-1 rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
              placeholder="Add custom clinical sign..."
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
              <div key={index} className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-md">
                <span className="flex-1 text-sm text-gray-700">{action}</span>
                <button
                  type="button"
                  onClick={() => removeItem('immediateActions', index)}
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

        {/* Lab Results (Optional) */}
        <div className="border border-gray-200 rounded-md">
          <button
            type="button"
            onClick={() => {
              if (!formData.showLabSection) {
                addLabResult();
              } else {
                handleChange('showLabSection', false);
              }
            }}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <div className="flex items-center gap-2">
              <svg
                className="w-4 h-4 text-purple-500"
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
              <span>Lab Results (Optional)</span>
              {formData.labResults.length > 0 && (
                <span className="px-1.5 py-0.5 text-xs bg-purple-100 text-purple-700 rounded">
                  {formData.labResults.length}
                </span>
              )}
            </div>
            <svg
              className={`w-4 h-4 text-gray-400 transition-transform ${formData.showLabSection ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          {formData.showLabSection && (
            <div className="px-4 pb-4 border-t border-gray-100 space-y-4">
              {formData.labResults.map((lr, idx) => (
                <div
                  key={idx}
                  className="mt-3 p-3 bg-gray-50 rounded-md border border-gray-200 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-500 uppercase">
                      Lab Result #{idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeLabResult(idx)}
                      className="text-gray-400 hover:text-red-500 text-xs"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Sample Type</label>
                      <select
                        value={lr.sampleType}
                        onChange={(e) => updateLabResult(idx, 'sampleType', e.target.value)}
                        className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                      >
                        {['Tissue', 'Water', 'Mucus', 'Blood', 'Other'].map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Sample Date</label>
                      <input
                        type="date"
                        value={lr.sampleDate}
                        onChange={(e) => updateLabResult(idx, 'sampleDate', e.target.value)}
                        className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Lab Name</label>
                      <input
                        type="text"
                        value={lr.labName}
                        onChange={(e) => updateLabResult(idx, 'labName', e.target.value)}
                        className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                        placeholder="e.g., PatoGen AS"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Test Type</label>
                      <input
                        type="text"
                        value={lr.testType}
                        onChange={(e) => updateLabResult(idx, 'testType', e.target.value)}
                        className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                        placeholder="e.g., PCR, Histopathology"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Result</label>
                    <input
                      type="text"
                      value={lr.result}
                      onChange={(e) => updateLabResult(idx, 'result', e.target.value)}
                      className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                      placeholder="e.g., Positive for ISA virus"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Conclusion</label>
                    <textarea
                      value={lr.conclusion}
                      onChange={(e) => updateLabResult(idx, 'conclusion', e.target.value)}
                      rows={2}
                      className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Lab conclusion or interpretation..."
                    />
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={addLabResult}
                className="mt-2 inline-flex items-center px-3 py-1.5 text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded-md hover:bg-purple-100"
              >
                <svg className="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
                Add Lab Result
              </button>
            </div>
          )}
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

export default DiseaseOutbreakModal;
