/**
 * Protocols Tab Component
 *
 * Manages species-specific feeding protocols with temperature ranges,
 * weight-based growth stages, feeding schedules, and default protocol assignment.
 *
 * Connects to the backend FeedingProtocol resolver (feed module).
 */
import React, { useState, useCallback } from 'react';
import { Modal, useAuth, useToast } from '@aquaculture/shared-ui';
import { useActiveSpecies } from '../../../hooks/useSpecies';
import {
  useFeedingProtocols,
  useCreateFeedingProtocol,
  useUpdateFeedingProtocol,
  useDeleteFeedingProtocol,
  useSetDefaultFeedingProtocol,
  feedStageLabels,
  feedStageColors,
  FEED_STAGE_OPTIONS,
  type FeedingProtocol,
  type CreateFeedingProtocolInput,
  type UpdateFeedingProtocolInput,
  type FeedingProtocolFilter,
  type FeedStage,
  type TemperatureRange,
  type GrowthStageProtocol,
  type FeedingScheduleEntry,
} from '../../../hooks/useFeedingProtocols';

// ============================================================================
// Types
// ============================================================================

interface ProtocolsTabProps {
  siteId?: string;
}

interface ProtocolFormData {
  name: string;
  description: string;
  species: string;
  stage: FeedStage;
  targetFcr: string;
  minDissolvedOxygen: string;
  optimalTempMin: string;
  optimalTempMax: string;
  notes: string;
  isDefault: boolean;
  temperatureRanges: TemperatureRange[];
  growthStageProtocols: GrowthStageProtocol[];
  mealTimes: FeedingScheduleEntry[];
  totalMealsPerDay: number;
}

/** Per-field validation error messages for the protocol form */
interface ProtocolFormErrors {
  name?: string;
  species?: string;
}

const emptyForm: ProtocolFormData = {
  name: '',
  description: '',
  species: '',
  stage: 'grower',
  targetFcr: '',
  minDissolvedOxygen: '',
  optimalTempMin: '',
  optimalTempMax: '',
  notes: '',
  isDefault: false,
  temperatureRanges: [],
  growthStageProtocols: [],
  mealTimes: [],
  totalMealsPerDay: 3,
};

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Delete Confirmation Dialog
 */
const DeleteConfirmDialog: React.FC<{
  protocol: FeedingProtocol;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting: boolean;
}> = ({ protocol, onConfirm, onCancel, isDeleting }) => (
  <Modal isOpen onClose={onCancel} size="md" showCloseButton={false}>
    <div className="sm:flex sm:items-start">
      <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
        <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>
      <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
        <h3 className="text-lg leading-6 font-medium text-gray-900" id="delete-dialog-title">
          Delete Protocol
        </h3>
        <div className="mt-2">
          <p className="text-sm text-gray-500">
            Are you sure you want to delete the protocol <strong>"{protocol.name}"</strong>? This
            action cannot be undone.
          </p>
        </div>
      </div>
    </div>
    <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse gap-3">
      <button
        type="button"
        disabled={isDeleting}
        onClick={onConfirm}
        className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500 sm:w-auto sm:text-sm disabled:opacity-50"
      >
        {isDeleting ? 'Deleting...' : 'Delete'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:mt-0 sm:w-auto sm:text-sm"
      >
        Cancel
      </button>
    </div>
  </Modal>
);

/**
 * Protocol Detail Drawer
 */
const ProtocolDetailDrawer: React.FC<{
  protocol: FeedingProtocol;
  onClose: () => void;
  onEdit: () => void;
  onSetDefault: () => void;
  isSettingDefault: boolean;
}> = ({ protocol, onClose, onEdit, onSetDefault, isSettingDefault }) => (
  <div
    className="fixed inset-0 z-40 overflow-hidden"
    aria-labelledby="detail-title"
    role="dialog"
    aria-modal="true"
  >
    <div className="absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-gray-500/75 transition-opacity" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 pl-10 max-w-full flex">
        <div className="w-screen max-w-lg">
          <div className="h-full flex flex-col bg-white shadow-xl overflow-y-scroll">
            {/* Header */}
            <div className="px-4 py-6 bg-blue-600 sm:px-6">
              <div className="flex items-start justify-between">
                <div>
                  <h2 id="detail-title" className="text-lg font-medium text-white">
                    {protocol.name}
                  </h2>
                  <p className="mt-1 text-sm text-blue-200">
                    {protocol.species} - {feedStageLabels[protocol.stage] || protocol.stage}
                  </p>
                </div>
                <button onClick={onClose} className="text-blue-200 hover:text-white">
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
              <div className="mt-2 flex gap-2">
                {protocol.isDefault && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-400 text-yellow-900">
                    Default
                  </span>
                )}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${protocol.isActive ? 'bg-green-400 text-green-900' : 'bg-gray-400 text-gray-900'}`}
                >
                  {protocol.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 px-4 py-6 sm:px-6 space-y-6">
              {/* Description */}
              {protocol.description && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500">Description</h3>
                  <p className="mt-1 text-sm text-gray-900">{protocol.description}</p>
                </div>
              )}

              {/* Key Metrics */}
              <div className="grid grid-cols-2 gap-4">
                {protocol.targetFcr != null && (
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-500">Target FCR</p>
                    <p className="text-lg font-semibold text-gray-900">{protocol.targetFcr}</p>
                  </div>
                )}
                {protocol.minDissolvedOxygen != null && (
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-500">Min DO (mg/L)</p>
                    <p className="text-lg font-semibold text-gray-900">
                      {protocol.minDissolvedOxygen}
                    </p>
                  </div>
                )}
              </div>

              {/* Optimal Temperature */}
              {protocol.optimalTemperature && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500">Optimal Temperature</h3>
                  <p className="mt-1 text-sm text-gray-900">
                    {protocol.optimalTemperature.min} - {protocol.optimalTemperature.max}{' '}
                    {protocol.optimalTemperature.unit === 'celsius' ? '\u00B0C' : '\u00B0F'}
                  </p>
                </div>
              )}

              {/* Temperature Ranges */}
              {protocol.temperatureRanges && protocol.temperatureRanges.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Temperature Ranges</h3>
                  <div className="space-y-2">
                    {protocol.temperatureRanges.map((range, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2"
                      >
                        <span className="text-sm text-gray-900">
                          {range.min} - {range.max}{' '}
                          {range.unit === 'celsius' ? '\u00B0C' : '\u00B0F'}
                        </span>
                        <span
                          className={`text-sm font-medium ${range.feedingMultiplier >= 1 ? 'text-green-600' : 'text-orange-600'}`}
                        >
                          {range.feedingMultiplier}x
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Growth Stage Protocols */}
              {protocol.growthStageProtocols && protocol.growthStageProtocols.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Growth Stage Protocols</h3>
                  <div className="space-y-3">
                    {protocol.growthStageProtocols.map((gsp, idx) => (
                      <div key={idx} className="bg-gray-50 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-gray-900">
                            {gsp.minWeight} - {gsp.maxWeight} {gsp.weightUnit}
                          </span>
                          <span className="text-sm text-blue-600 font-medium">
                            {gsp.feedPercent}% BW
                          </span>
                        </div>
                        {gsp.schedule && (
                          <p className="text-xs text-gray-500">
                            {gsp.schedule.totalMealsPerDay} meals/day
                            {gsp.schedule.schedule?.length > 0 && (
                              <> at {gsp.schedule.schedule.map((s) => s.time).join(', ')}</>
                            )}
                          </p>
                        )}
                        {gsp.notes && <p className="text-xs text-gray-400 mt-1">{gsp.notes}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Default Schedule */}
              {protocol.defaultSchedule && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Default Schedule</h3>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-sm text-gray-900 mb-2">
                      {protocol.defaultSchedule.totalMealsPerDay} meals per day
                    </p>
                    {protocol.defaultSchedule.schedule?.length > 0 && (
                      <div className="space-y-1">
                        {protocol.defaultSchedule.schedule.map((entry, idx) => (
                          <div key={idx} className="flex items-center justify-between text-sm">
                            <span className="text-gray-600">{entry.time}</span>
                            <span className="text-gray-900">{entry.percentOfDaily}%</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {protocol.defaultSchedule.adjustments && (
                      <div className="mt-2 pt-2 border-t border-gray-200 text-xs text-gray-500">
                        {protocol.defaultSchedule.adjustments.lowOxygenReduction != null && (
                          <p>
                            Low O2 reduction:{' '}
                            {protocol.defaultSchedule.adjustments.lowOxygenReduction}%
                          </p>
                        )}
                        {protocol.defaultSchedule.adjustments.postStressReduction != null && (
                          <p>
                            Post-stress reduction:{' '}
                            {protocol.defaultSchedule.adjustments.postStressReduction}%
                          </p>
                        )}
                        {protocol.defaultSchedule.adjustments.preMedicationFasting != null && (
                          <p>
                            Pre-medication fasting:{' '}
                            {protocol.defaultSchedule.adjustments.preMedicationFasting}h
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Special Conditions */}
              {protocol.specialConditions && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500 mb-2">Special Conditions</h3>
                  <div className="space-y-2 text-sm">
                    {protocol.specialConditions.spawningPeriod && (
                      <div>
                        <span className="font-medium text-gray-700">Spawning:</span>{' '}
                        {protocol.specialConditions.spawningPeriod}
                      </div>
                    )}
                    {protocol.specialConditions.winterFeeding && (
                      <div>
                        <span className="font-medium text-gray-700">Winter:</span>{' '}
                        {protocol.specialConditions.winterFeeding}
                      </div>
                    )}
                    {protocol.specialConditions.diseaseOutbreak && (
                      <div>
                        <span className="font-medium text-gray-700">Disease:</span>{' '}
                        {protocol.specialConditions.diseaseOutbreak}
                      </div>
                    )}
                    {protocol.specialConditions.waterQualityIssues && (
                      <div>
                        <span className="font-medium text-gray-700">Water Quality:</span>{' '}
                        {protocol.specialConditions.waterQualityIssues}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Notes */}
              {protocol.notes && (
                <div>
                  <h3 className="text-sm font-medium text-gray-500">Notes</h3>
                  <p className="mt-1 text-sm text-gray-900">{protocol.notes}</p>
                </div>
              )}

              {/* Metadata */}
              <div className="pt-4 border-t border-gray-200 text-xs text-gray-400">
                <p>Created: {new Date(protocol.createdAt).toLocaleDateString('tr-TR')}</p>
                <p>Updated: {new Date(protocol.updatedAt).toLocaleDateString('tr-TR')}</p>
                <p>Version: {protocol.version}</p>
              </div>
            </div>

            {/* Footer Actions */}
            <div className="flex-shrink-0 px-4 py-4 flex justify-end gap-3 border-t border-gray-200">
              {!protocol.isDefault && protocol.isActive && (
                <button
                  onClick={onSetDefault}
                  disabled={isSettingDefault}
                  className="inline-flex items-center px-3 py-2 border border-yellow-300 shadow-sm text-sm font-medium rounded-md text-yellow-700 bg-yellow-50 hover:bg-yellow-100 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500 disabled:opacity-50"
                >
                  {isSettingDefault ? 'Setting...' : 'Set as Default'}
                </button>
              )}
              <button
                onClick={onEdit}
                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Edit Protocol
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
);

// ============================================================================
// Protocol Form Modal
// ============================================================================

const ProtocolFormModal: React.FC<{
  protocol?: FeedingProtocol | null;
  speciesList: { commonName: string; code: string }[];
  onSave: (input: CreateFeedingProtocolInput | UpdateFeedingProtocolInput) => void;
  onClose: () => void;
  isSaving: boolean;
}> = ({ protocol, speciesList, onSave, onClose, isSaving }) => {
  const isEdit = !!protocol;

  const [formErrors, setFormErrors] = useState<ProtocolFormErrors>({});
  const [form, setForm] = useState<ProtocolFormData>(() => {
    if (protocol) {
      return {
        name: protocol.name,
        description: protocol.description || '',
        species: protocol.species,
        stage: protocol.stage,
        targetFcr: protocol.targetFcr?.toString() || '',
        minDissolvedOxygen: protocol.minDissolvedOxygen?.toString() || '',
        optimalTempMin: protocol.optimalTemperature?.min?.toString() || '',
        optimalTempMax: protocol.optimalTemperature?.max?.toString() || '',
        notes: protocol.notes || '',
        isDefault: protocol.isDefault,
        temperatureRanges: protocol.temperatureRanges || [],
        growthStageProtocols: protocol.growthStageProtocols || [],
        mealTimes: protocol.defaultSchedule?.schedule || [],
        totalMealsPerDay: protocol.defaultSchedule?.totalMealsPerDay || 3,
      };
    }
    return { ...emptyForm };
  });

  const updateField = <K extends keyof ProtocolFormData>(key: K, value: ProtocolFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Temperature ranges management
  const addTemperatureRange = () => {
    updateField('temperatureRanges', [
      ...form.temperatureRanges,
      { min: 0, max: 0, unit: 'celsius', feedingMultiplier: 1.0 },
    ]);
  };

  const updateTemperatureRange = (
    index: number,
    field: keyof TemperatureRange,
    value: number | string,
  ) => {
    const updated = [...form.temperatureRanges];
    updated[index] = { ...updated[index], [field]: typeof value === 'string' ? value : value };
    updateField('temperatureRanges', updated);
  };

  const removeTemperatureRange = (index: number) => {
    updateField(
      'temperatureRanges',
      form.temperatureRanges.filter((_, i) => i !== index),
    );
  };

  // Growth stage protocols management
  const addGrowthStage = () => {
    updateField('growthStageProtocols', [
      ...form.growthStageProtocols,
      {
        minWeight: 0,
        maxWeight: 0,
        weightUnit: 'gram',
        feedPercent: 0,
        schedule: {
          totalMealsPerDay: 3,
          schedule: [
            { time: '08:00', percentOfDaily: 33.3 },
            { time: '12:00', percentOfDaily: 33.3 },
            { time: '17:00', percentOfDaily: 33.4 },
          ],
        },
      },
    ]);
  };

  const updateGrowthStage = (index: number, field: string, value: number | string) => {
    const updated = [...form.growthStageProtocols];
    updated[index] = { ...updated[index], [field]: value };
    updateField('growthStageProtocols', updated);
  };

  const removeGrowthStage = (index: number) => {
    updateField(
      'growthStageProtocols',
      form.growthStageProtocols.filter((_, i) => i !== index),
    );
  };

  // Meal times management
  const addMealTime = () => {
    updateField('mealTimes', [...form.mealTimes, { time: '08:00', percentOfDaily: 0 }]);
  };

  const updateMealTime = (
    index: number,
    field: keyof FeedingScheduleEntry,
    value: string | number,
  ) => {
    const updated = [...form.mealTimes];
    updated[index] = { ...updated[index], [field]: value };
    updateField('mealTimes', updated);
  };

  const removeMealTime = (index: number) => {
    updateField(
      'mealTimes',
      form.mealTimes.filter((_, i) => i !== index),
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate required fields and show inline error messages
    const errors: ProtocolFormErrors = {};
    if (!form.name.trim()) errors.name = 'Name is required.';
    if (!form.species) errors.species = 'Please select a species.';
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }
    setFormErrors({});

    const input: CreateFeedingProtocolInput = {
      name: form.name,
      species: form.species,
      stage: form.stage,
      isDefault: form.isDefault,
    };

    if (form.description) input.description = form.description;
    if (form.notes) input.notes = form.notes;
    if (form.targetFcr) input.targetFcr = parseFloat(form.targetFcr);
    if (form.minDissolvedOxygen) input.minDissolvedOxygen = parseFloat(form.minDissolvedOxygen);

    if (form.optimalTempMin && form.optimalTempMax) {
      input.optimalTemperature = {
        min: parseFloat(form.optimalTempMin),
        max: parseFloat(form.optimalTempMax),
        unit: 'celsius',
      };
    }

    if (form.temperatureRanges.length > 0) {
      input.temperatureRanges = form.temperatureRanges.map((tr) => ({
        min: tr.min,
        max: tr.max,
        feedingMultiplier: tr.feedingMultiplier,
      }));
    }

    if (form.growthStageProtocols.length > 0) {
      input.growthStageProtocols = form.growthStageProtocols;
    }

    if (form.mealTimes.length > 0) {
      input.defaultSchedule = {
        totalMealsPerDay: form.totalMealsPerDay,
        schedule: form.mealTimes,
      };
    }

    if (isEdit && protocol) {
      onSave({ ...input, id: protocol.id } as UpdateFeedingProtocolInput);
    } else {
      onSave(input);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isEdit ? 'Edit Feeding Protocol' : 'Create Feeding Protocol'}
      size="lg"
      showCloseButton={false}
    >
      <form onSubmit={handleSubmit}>
        <div className="bg-white px-4 pt-5 pb-4 sm:p-6">
          <div className="space-y-6">
            {/* Basic Info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700">
                  Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => {
                    updateField('name', e.target.value);
                    if (formErrors.name && e.target.value.trim())
                      setFormErrors((prev) => ({ ...prev, name: undefined }));
                  }}
                  className={`mt-1 block w-full rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm ${formErrors.name ? 'border-red-500' : 'border-gray-300'}`}
                  placeholder="e.g., Atlantic Salmon - Grower Phase"
                />
                {formErrors.name && <p className="mt-1 text-sm text-red-600">{formErrors.name}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Species <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  value={form.species}
                  onChange={(e) => {
                    updateField('species', e.target.value);
                    if (formErrors.species && e.target.value)
                      setFormErrors((prev) => ({ ...prev, species: undefined }));
                  }}
                  className={`mt-1 block w-full rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm ${formErrors.species ? 'border-red-500' : 'border-gray-300'}`}
                >
                  <option value="">Select species...</option>
                  {speciesList.map((sp) => (
                    <option key={sp.code} value={sp.commonName}>
                      {sp.commonName}
                    </option>
                  ))}
                  {/* Allow custom species name if not in list */}
                  {form.species && !speciesList.find((s) => s.commonName === form.species) && (
                    <option value={form.species}>{form.species}</option>
                  )}
                </select>
                {formErrors.species && (
                  <p className="mt-1 text-sm text-red-600">{formErrors.species}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Stage</label>
                <select
                  value={form.stage}
                  onChange={(e) => updateField('stage', e.target.value as FeedStage)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                >
                  {FEED_STAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => updateField('description', e.target.value)}
                  rows={2}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                  placeholder="Protocol description..."
                />
              </div>
            </div>

            {/* Key Parameters */}
            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-3">Key Parameters</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500">Target FCR</label>
                  <input
                    type="number"
                    step="0.01"
                    value={form.targetFcr}
                    onChange={(e) => updateField('targetFcr', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    placeholder="1.20"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500">Min DO (mg/L)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={form.minDissolvedOxygen}
                    onChange={(e) => updateField('minDissolvedOxygen', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    placeholder="6.0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500">Opt. Temp Min</label>
                  <input
                    type="number"
                    step="0.5"
                    value={form.optimalTempMin}
                    onChange={(e) => updateField('optimalTempMin', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    placeholder="12"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500">Opt. Temp Max</label>
                  <input
                    type="number"
                    step="0.5"
                    value={form.optimalTempMax}
                    onChange={(e) => updateField('optimalTempMax', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    placeholder="18"
                  />
                </div>
              </div>
            </div>

            {/* Temperature Ranges */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-medium text-gray-900">Temperature Ranges</h4>
                <button
                  type="button"
                  onClick={addTemperatureRange}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  + Add Range
                </button>
              </div>
              {form.temperatureRanges.length === 0 && (
                <p className="text-xs text-gray-400 italic">
                  No temperature ranges defined. Click "Add Range" to add one.
                </p>
              )}
              <div className="space-y-2">
                {form.temperatureRanges.map((range, idx) => (
                  <div key={idx} className="flex items-center gap-2 bg-gray-50 rounded-lg p-2">
                    <input
                      type="number"
                      step="0.5"
                      value={range.min}
                      onChange={(e) =>
                        updateTemperatureRange(idx, 'min', parseFloat(e.target.value) || 0)
                      }
                      className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                      placeholder="Min"
                    />
                    <span className="text-gray-400">-</span>
                    <input
                      type="number"
                      step="0.5"
                      value={range.max}
                      onChange={(e) =>
                        updateTemperatureRange(idx, 'max', parseFloat(e.target.value) || 0)
                      }
                      className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                      placeholder="Max"
                    />
                    <span className="text-xs text-gray-500">{'\u00B0C'}</span>
                    <div className="flex-1" />
                    <label className="text-xs text-gray-500 whitespace-nowrap">Multiplier:</label>
                    <input
                      type="number"
                      step="0.05"
                      value={range.feedingMultiplier}
                      onChange={(e) =>
                        updateTemperatureRange(
                          idx,
                          'feedingMultiplier',
                          parseFloat(e.target.value) || 0,
                        )
                      }
                      className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => removeTemperatureRange(idx)}
                      className="text-red-400 hover:text-red-600"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Growth Stage Protocols */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-medium text-gray-900">Weight-Based Feeding Rates</h4>
                <button
                  type="button"
                  onClick={addGrowthStage}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  + Add Weight Range
                </button>
              </div>
              {form.growthStageProtocols.length === 0 && (
                <p className="text-xs text-gray-400 italic">
                  No weight ranges defined. Click "Add Weight Range" to add one.
                </p>
              )}
              <div className="space-y-3">
                {form.growthStageProtocols.map((gsp, idx) => (
                  <div key={idx} className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="number"
                        value={gsp.minWeight}
                        onChange={(e) =>
                          updateGrowthStage(idx, 'minWeight', parseFloat(e.target.value) || 0)
                        }
                        className="w-24 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                        placeholder="Min wt"
                      />
                      <span className="text-gray-400">-</span>
                      <input
                        type="number"
                        value={gsp.maxWeight}
                        onChange={(e) =>
                          updateGrowthStage(idx, 'maxWeight', parseFloat(e.target.value) || 0)
                        }
                        className="w-24 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                        placeholder="Max wt"
                      />
                      <select
                        value={gsp.weightUnit}
                        onChange={(e) => updateGrowthStage(idx, 'weightUnit', e.target.value)}
                        className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                      >
                        <option value="gram">g</option>
                        <option value="kg">kg</option>
                      </select>
                      <div className="flex-1" />
                      <label className="text-xs text-gray-500 whitespace-nowrap">Feed %BW:</label>
                      <input
                        type="number"
                        step="0.1"
                        value={gsp.feedPercent}
                        onChange={(e) =>
                          updateGrowthStage(idx, 'feedPercent', parseFloat(e.target.value) || 0)
                        }
                        className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => removeGrowthStage(idx)}
                        className="text-red-400 hover:text-red-600"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Default Meal Schedule */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-medium text-gray-900">Default Meal Schedule</h4>
                <button
                  type="button"
                  onClick={addMealTime}
                  className="text-sm text-blue-600 hover:text-blue-800"
                >
                  + Add Meal
                </button>
              </div>
              {form.mealTimes.length > 0 && (
                <div className="mb-3">
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    Total Meals/Day
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={form.totalMealsPerDay}
                    onChange={(e) => updateField('totalMealsPerDay', parseInt(e.target.value) || 3)}
                    className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                  />
                </div>
              )}
              {form.mealTimes.length === 0 && (
                <p className="text-xs text-gray-400 italic">
                  No meal times defined. Click "Add Meal" to add one.
                </p>
              )}
              <div className="space-y-2">
                {form.mealTimes.map((meal, idx) => (
                  <div key={idx} className="flex items-center gap-3 bg-gray-50 rounded-lg p-2">
                    <label className="text-xs text-gray-500">Time:</label>
                    <input
                      type="time"
                      value={meal.time}
                      onChange={(e) => updateMealTime(idx, 'time', e.target.value)}
                      className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                    <label className="text-xs text-gray-500">% of daily:</label>
                    <input
                      type="number"
                      step="0.1"
                      value={meal.percentOfDaily}
                      onChange={(e) =>
                        updateMealTime(idx, 'percentOfDaily', parseFloat(e.target.value) || 0)
                      }
                      className="w-20 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() => removeMealTime(idx)}
                      className="text-red-400 hover:text-red-600"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
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
            </div>

            {/* Notes & Default */}
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => updateField('notes', e.target.value)}
                  rows={2}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                  placeholder="Additional notes..."
                />
              </div>
              <div className="flex items-center">
                <input
                  id="isDefault"
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={(e) => updateField('isDefault', e.target.checked)}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
                <label htmlFor="isDefault" className="ml-2 block text-sm text-gray-700">
                  Set as default protocol for this species/stage
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Form Footer */}
        <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse gap-3">
          <button
            type="submit"
            disabled={isSaving || !form.name || !form.species}
            className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-blue-600 text-base font-medium text-white hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? 'Saving...' : isEdit ? 'Update Protocol' : 'Create Protocol'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:mt-0 sm:w-auto sm:text-sm"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const ProtocolsTab: React.FC<ProtocolsTabProps> = () => {
  const { token, tenantId } = useAuth();
  const { toast } = useToast();

  // State
  const [speciesFilter, setSpeciesFilter] = useState<string>('');
  const [stageFilter, setStageFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedProtocol, setSelectedProtocol] = useState<FeedingProtocol | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingProtocol, setEditingProtocol] = useState<FeedingProtocol | null>(null);
  const [deletingProtocol, setDeletingProtocol] = useState<FeedingProtocol | null>(null);

  // Build filter
  const filter: FeedingProtocolFilter = {};
  if (speciesFilter) filter.species = speciesFilter;
  if (stageFilter) filter.stage = stageFilter as FeedStage;
  if (searchQuery) filter.search = searchQuery;

  // Queries
  const { data, isLoading, error } = useFeedingProtocols(filter);
  const { data: speciesData } = useActiveSpecies();

  // Mutations
  const createMutation = useCreateFeedingProtocol();
  const updateMutation = useUpdateFeedingProtocol();
  const deleteMutation = useDeleteFeedingProtocol();
  const setDefaultMutation = useSetDefaultFeedingProtocol();

  const speciesList =
    speciesData?.map((s) => ({
      commonName: s.commonName,
      code: s.code,
    })) || [];

  // Derive unique species from results for the filter dropdown
  const protocols = data?.items ?? [];
  const uniqueSpecies = Array.from(new Set(protocols.map((p) => p.species))).sort();

  // Handlers
  const handleCreate = () => {
    setEditingProtocol(null);
    setShowForm(true);
  };

  const handleEdit = (protocol: FeedingProtocol) => {
    setEditingProtocol(protocol);
    setSelectedProtocol(null);
    setShowForm(true);
  };

  const handleSave = useCallback(
    async (input: CreateFeedingProtocolInput | UpdateFeedingProtocolInput) => {
      try {
        if ('id' in input && input.id) {
          await updateMutation.mutateAsync(input as UpdateFeedingProtocolInput);
          toast({ title: 'Success', description: 'Protocol updated successfully.' });
        } else {
          await createMutation.mutateAsync(input as CreateFeedingProtocolInput);
          toast({ title: 'Success', description: 'Protocol created successfully.' });
        }
        setShowForm(false);
        setEditingProtocol(null);
      } catch (err) {
        if (import.meta.env.DEV) console.error('Failed to save protocol:', err);
        toast({
          title: 'Error',
          description: 'Failed to save protocol. Please try again.',
          variant: 'error',
        });
      }
    },
    [createMutation, updateMutation, toast],
  );

  const handleDelete = useCallback(async () => {
    if (!deletingProtocol) return;
    try {
      await deleteMutation.mutateAsync(deletingProtocol.id);
      toast({ title: 'Success', description: 'Protocol deleted successfully.' });
      setDeletingProtocol(null);
      setSelectedProtocol(null);
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to delete protocol:', err);
      toast({
        title: 'Error',
        description: 'Failed to delete protocol. Please try again.',
        variant: 'error',
      });
    }
  }, [deletingProtocol, deleteMutation, toast]);

  const handleSetDefault = useCallback(
    async (protocol: FeedingProtocol) => {
      try {
        await setDefaultMutation.mutateAsync(protocol.id);
        toast({
          title: 'Success',
          description: `"${protocol.name}" set as default for ${protocol.species}.`,
        });
      } catch (err) {
        if (import.meta.env.DEV) console.error('Failed to set default:', err);
        toast({
          title: 'Error',
          description: 'Failed to set default protocol. Please try again.',
          variant: 'error',
        });
      }
    },
    [setDefaultMutation, toast],
  );

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-wrap gap-3">
          {/* Species Filter */}
          <select
            value={speciesFilter}
            onChange={(e) => setSpeciesFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          >
            <option value="">All Species</option>
            {/* Show species from loaded protocols + from tenant species list */}
            {Array.from(new Set([...uniqueSpecies, ...speciesList.map((s) => s.commonName)]))
              .sort()
              .map((sp) => (
                <option key={sp} value={sp}>
                  {sp}
                </option>
              ))}
          </select>

          {/* Stage Filter */}
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          >
            <option value="">All Stages</option>
            {FEED_STAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* Search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search protocols..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            />
            <svg
              className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
        </div>

        <button
          onClick={handleCreate}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors text-sm"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 6v6m0 0v6m0-6h6m-6 0H6"
            />
          </svg>
          Create Protocol
        </button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load feeding protocols. Please try again.</p>
        </div>
      )}

      {/* Protocols Grid */}
      {!isLoading && !error && protocols.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {protocols.map((protocol) => {
            const stageColor = feedStageColors[protocol.stage] || 'bg-gray-100 text-gray-800';
            return (
              <div
                key={protocol.id}
                className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => setSelectedProtocol(protocol)}
              >
                <div className="p-4">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-gray-900 truncate">
                        {protocol.name}
                      </h3>
                      <p className="text-xs text-gray-500 mt-0.5">{protocol.species}</p>
                    </div>
                    <div className="flex gap-1.5 ml-2 flex-shrink-0">
                      {protocol.isDefault && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                          Default
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${stageColor}`}
                      >
                        {feedStageLabels[protocol.stage] || protocol.stage}
                      </span>
                    </div>
                  </div>

                  {/* Description */}
                  {protocol.description && (
                    <p className="text-xs text-gray-500 mb-3 line-clamp-2">
                      {protocol.description}
                    </p>
                  )}

                  {/* Key Metrics */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 mb-3">
                    {protocol.targetFcr != null && (
                      <span>
                        FCR: <strong>{protocol.targetFcr}</strong>
                      </span>
                    )}
                    {protocol.optimalTemperature && (
                      <span>
                        Temp:{' '}
                        <strong>
                          {protocol.optimalTemperature.min}-{protocol.optimalTemperature.max}
                          {'\u00B0C'}
                        </strong>
                      </span>
                    )}
                    {protocol.growthStageProtocols && protocol.growthStageProtocols.length > 0 && (
                      <span>
                        {protocol.growthStageProtocols.length} weight range
                        {protocol.growthStageProtocols.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {protocol.defaultSchedule && (
                      <span>{protocol.defaultSchedule.totalMealsPerDay} meals/day</span>
                    )}
                  </div>

                  {/* Temperature Ranges Summary */}
                  {protocol.temperatureRanges && protocol.temperatureRanges.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {protocol.temperatureRanges.slice(0, 3).map((tr, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-xs"
                        >
                          {tr.min}-{tr.max}
                          {'\u00B0'} ({tr.feedingMultiplier}x)
                        </span>
                      ))}
                      {protocol.temperatureRanges.length > 3 && (
                        <span className="text-xs text-gray-400">
                          +{protocol.temperatureRanges.length - 3} more
                        </span>
                      )}
                    </div>
                  )}

                  {/* Footer */}
                  <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                    <span
                      className={`text-xs ${protocol.isActive ? 'text-green-600' : 'text-gray-400'}`}
                    >
                      {protocol.isActive ? 'Active' : 'Inactive'}
                    </span>
                    <div className="flex gap-1">
                      {!protocol.isDefault && protocol.isActive && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSetDefault(protocol);
                          }}
                          className="p-1 text-yellow-500 hover:text-yellow-700 hover:bg-yellow-50 rounded"
                          title="Set as default"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                            />
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEdit(protocol);
                        }}
                        className="p-1 text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded"
                        title="Edit"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingProtocol(protocol);
                        }}
                        className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                        title="Delete"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && protocols.length === 0 && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">No feeding protocols found</h3>
          <p className="mt-1 text-sm text-gray-500">
            {speciesFilter || stageFilter || searchQuery
              ? 'Try adjusting your filters.'
              : 'Get started by creating a species-specific feeding protocol.'}
          </p>
          {!speciesFilter && !stageFilter && !searchQuery && (
            <div className="mt-6">
              <button
                onClick={handleCreate}
                className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
              >
                <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
                Create Protocol
              </button>
            </div>
          )}
        </div>
      )}

      {/* Pagination Info */}
      {data && data.total > 0 && (
        <div className="mt-4 text-sm text-gray-500 text-center">
          Showing {protocols.length} of {data.total} protocol{data.total !== 1 ? 's' : ''}
        </div>
      )}

      {/* Detail Drawer */}
      {selectedProtocol && (
        <ProtocolDetailDrawer
          protocol={selectedProtocol}
          onClose={() => setSelectedProtocol(null)}
          onEdit={() => handleEdit(selectedProtocol)}
          onSetDefault={() => handleSetDefault(selectedProtocol)}
          isSettingDefault={setDefaultMutation.isPending}
        />
      )}

      {/* Create/Edit Form Modal */}
      {showForm && (
        <ProtocolFormModal
          protocol={editingProtocol}
          speciesList={speciesList}
          onSave={handleSave}
          onClose={() => {
            setShowForm(false);
            setEditingProtocol(null);
          }}
          isSaving={createMutation.isPending || updateMutation.isPending}
        />
      )}

      {/* Delete Confirmation */}
      {deletingProtocol && (
        <DeleteConfirmDialog
          protocol={deletingProtocol}
          onConfirm={handleDelete}
          onCancel={() => setDeletingProtocol(null)}
          isDeleting={deleteMutation.isPending}
        />
      )}
    </div>
  );
};

export default ProtocolsTab;
