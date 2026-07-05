/**
 * Equipment Mapping Panel
 *
 * Shows which equipment a given parameter is mapped to and allows
 * adding/removing mappings with frequency and alert configuration.
 */
import React, { useState, useMemo } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import {
  useParamEquipmentMappings,
  useCreateParamEquipmentMapping,
  useDeleteParamEquipmentMapping,
  useUpdateParamEquipmentMapping,
  ParamEquipmentMapping,
  MonitoringFrequency,
  MONITORING_FREQUENCY_OPTIONS,
  EQUIPMENT_CATEGORY_OPTIONS,
  getFrequencyLabel,
} from '../../../hooks/useParamEquipmentMapping';
import { useEquipmentList } from '../../../hooks/useEquipment';

// ============================================================================
// TYPES
// ============================================================================

interface EquipmentMappingPanelProps {
  parameterConfigId: string;
  parameterName: string;
  onClose: () => void;
}

interface AddFormState {
  equipmentId: string;
  monitoringFrequency: MonitoringFrequency;
  alertEnabled: boolean;
  categoryFilter: string;
}

const INITIAL_ADD_FORM: AddFormState = {
  equipmentId: '',
  monitoringFrequency: 'DAILY',
  alertEnabled: true,
  categoryFilter: '',
};

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

const MappingRow: React.FC<{
  mapping: ParamEquipmentMapping;
  onToggleActive: (mapping: ParamEquipmentMapping) => void;
  onToggleAlert: (mapping: ParamEquipmentMapping) => void;
  onRemove: (id: string) => void;
  isUpdating: boolean;
  isDeleting: boolean;
}> = ({ mapping, onToggleActive, onToggleAlert, onRemove, isUpdating, isDeleting }) => (
  <tr className="hover:bg-gray-50">
    <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
      {mapping.equipment?.name ?? '-'}
    </td>
    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 font-mono">
      {mapping.equipment?.code ?? '-'}
    </td>
    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
      {getFrequencyLabel(mapping.monitoringFrequency)}
    </td>
    <td className="px-4 py-3 whitespace-nowrap text-center">
      <button
        onClick={() => onToggleAlert(mapping)}
        disabled={isUpdating}
        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
          mapping.alertEnabled
            ? 'bg-green-100 text-green-800 hover:bg-green-200'
            : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
        }`}
      >
        {mapping.alertEnabled ? 'On' : 'Off'}
      </button>
    </td>
    <td className="px-4 py-3 whitespace-nowrap text-center">
      <button
        onClick={() => onToggleActive(mapping)}
        disabled={isUpdating}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
          mapping.isActive ? 'bg-blue-600' : 'bg-gray-200'
        }`}
        role="switch"
        aria-checked={mapping.isActive}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
            mapping.isActive ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </td>
    <td className="px-4 py-3 whitespace-nowrap text-right text-sm">
      <button
        onClick={() => onRemove(mapping.id)}
        disabled={isDeleting}
        className="text-red-600 hover:text-red-900 disabled:opacity-50"
      >
        {isDeleting ? 'Removing...' : 'Remove'}
      </button>
    </td>
  </tr>
);

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const EquipmentMappingPanel: React.FC<EquipmentMappingPanelProps> = ({
  parameterConfigId,
  parameterName,
  onClose,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<AddFormState>(INITIAL_ADD_FORM);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Data hooks
  const {
    data: mappings,
    isLoading: mappingsLoading,
    error: mappingsError,
  } = useParamEquipmentMappings({ parameterConfigId });

  const { data: equipmentData, isLoading: equipmentLoading } = useEquipmentList(
    showAddForm
      ? {
          isActive: true,
          ...(addForm.categoryFilter ? {} : {}),
        }
      : undefined,
  );

  // Mutation hooks
  const createMutation = useCreateParamEquipmentMapping();
  const updateMutation = useUpdateParamEquipmentMapping();
  const deleteMutation = useDeleteParamEquipmentMapping();

  // Filter equipment list: exclude already-mapped equipment and apply category filter
  const alreadyMappedIds = useMemo(() => {
    if (!mappings) return new Set<string>();
    return new Set(mappings.map((m) => m.equipmentId));
  }, [mappings]);

  const filteredEquipment = useMemo(() => {
    if (!equipmentData?.items) return [];
    return equipmentData.items.filter((eq) => {
      if (alreadyMappedIds.has(eq.id)) return false;
      if (addForm.categoryFilter && eq.equipmentType?.category !== addForm.categoryFilter) {
        return false;
      }
      return true;
    });
  }, [equipmentData, alreadyMappedIds, addForm.categoryFilter]);

  // Handlers
  const handleAddMapping = async () => {
    if (!addForm.equipmentId) return;
    try {
      await createMutation.mutateAsync({
        parameterConfigId,
        equipmentId: addForm.equipmentId,
        monitoringFrequency: addForm.monitoringFrequency,
        alertEnabled: addForm.alertEnabled,
      });
      setAddForm(INITIAL_ADD_FORM);
      setShowAddForm(false);
    } catch {
      // Error displayed via mutation state
    }
  };

  const handleToggleActive = async (mapping: ParamEquipmentMapping) => {
    try {
      await updateMutation.mutateAsync({
        id: mapping.id,
        isActive: !mapping.isActive,
      });
    } catch {
      // Silently handled; query invalidation re-fetches
    }
  };

  const handleToggleAlert = async (mapping: ParamEquipmentMapping) => {
    try {
      await updateMutation.mutateAsync({
        id: mapping.id,
        alertEnabled: !mapping.alertEnabled,
      });
    } catch {
      // Silently handled
    }
  };

  const handleRemove = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteMutation.mutateAsync(id);
    } catch {
      // Error handled
    } finally {
      setDeletingId(null);
    }
  };

  // Render
  return (
    <Modal isOpen onClose={onClose} title="Equipment Monitoring Points" size="xl">
      <p className="-mt-2 mb-4 text-sm text-gray-500">
        Parameter: <span className="font-medium">{parameterName}</span>
      </p>

      {/* Body */}
      <div className="max-h-[70vh] overflow-y-auto">
        {/* Error banner */}
        {mappingsError && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-800">
              Failed to load mappings: {(mappingsError as Error).message}
            </p>
          </div>
        )}

        {createMutation.error && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-800">
              Failed to create mapping: {(createMutation.error as Error).message}
            </p>
          </div>
        )}

        {/* Loading */}
        {mappingsLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        )}

        {/* Mappings Table */}
        {!mappingsLoading && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Equipment Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Code
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Frequency
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">
                    Alert
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">
                    Active
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {(!mappings || mappings.length === 0) && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">
                      No equipment mapped to this parameter yet.
                    </td>
                  </tr>
                )}
                {mappings?.map((mapping) => (
                  <MappingRow
                    key={mapping.id}
                    mapping={mapping}
                    onToggleActive={handleToggleActive}
                    onToggleAlert={handleToggleAlert}
                    onRemove={handleRemove}
                    isUpdating={updateMutation.isPending}
                    isDeleting={deletingId === mapping.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add Equipment Form */}
        {showAddForm && (
          <div className="mt-4 bg-gray-50 border border-gray-200 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-900 mb-3">Add Equipment Mapping</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Category filter */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Category Filter
                </label>
                <select
                  value={addForm.categoryFilter}
                  onChange={(e) =>
                    setAddForm((prev) => ({
                      ...prev,
                      categoryFilter: e.target.value,
                      equipmentId: '',
                    }))
                  }
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                >
                  <option value="">All Categories</option>
                  {EQUIPMENT_CATEGORY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Equipment selector */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Equipment</label>
                <select
                  value={addForm.equipmentId}
                  onChange={(e) =>
                    setAddForm((prev) => ({
                      ...prev,
                      equipmentId: e.target.value,
                    }))
                  }
                  disabled={equipmentLoading}
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                >
                  <option value="">{equipmentLoading ? 'Loading...' : 'Select equipment'}</option>
                  {filteredEquipment.map((eq) => (
                    <option key={eq.id} value={eq.id}>
                      {eq.name} ({eq.code}){eq.equipmentType ? ` - ${eq.equipmentType.name}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Frequency */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Monitoring Frequency
                </label>
                <select
                  value={addForm.monitoringFrequency}
                  onChange={(e) =>
                    setAddForm((prev) => ({
                      ...prev,
                      monitoringFrequency: e.target.value as MonitoringFrequency,
                    }))
                  }
                  className="w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                >
                  {MONITORING_FREQUENCY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Alert toggle */}
              <div className="flex items-end">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={addForm.alertEnabled}
                    onChange={(e) =>
                      setAddForm((prev) => ({
                        ...prev,
                        alertEnabled: e.target.checked,
                      }))
                    }
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Enable Alerts</span>
                </label>
              </div>
            </div>

            {/* Form actions */}
            <div className="mt-4 flex justify-end space-x-2">
              <button
                onClick={() => {
                  setShowAddForm(false);
                  setAddForm(INITIAL_ADD_FORM);
                  createMutation.reset();
                }}
                className="px-3 py-1.5 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAddMapping}
                disabled={!addForm.equipmentId || createMutation.isPending}
                className="px-3 py-1.5 border border-transparent rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {createMutation.isPending ? 'Adding...' : 'Add Mapping'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
        <div className="text-sm text-gray-500">
          {mappings ? `${mappings.length} equipment mapped` : ''}
        </div>
        <div className="flex space-x-3">
          {!showAddForm && (
            <button
              onClick={() => setShowAddForm(true)}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
            >
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Add Equipment
            </button>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
};
