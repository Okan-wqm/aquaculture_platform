/**
 * Equipment Mapping Panel
 *
 * Shows which equipment a given parameter is mapped to and allows
 * adding/removing mappings with frequency and alert configuration.
 */
import React, { useState, useMemo } from 'react';
import { Modal, DataTable, type DataTableColumn, Spinner, Button } from '@aquaculture/shared-ui';
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
import { Plus } from 'lucide-react';

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
  const mappingColumns: DataTableColumn<ParamEquipmentMapping>[] = [
    {
      key: 'name',
      header: 'Equipment Name',
      render: (_value, mapping) => (
        <span className="whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
          {mapping.equipment?.name ?? '-'}
        </span>
      ),
    },
    {
      key: 'code',
      header: 'Code',
      render: (_value, mapping) => (
        <span className="whitespace-nowrap font-mono text-gray-500 dark:text-gray-400">
          {mapping.equipment?.code ?? '-'}
        </span>
      ),
    },
    {
      key: 'monitoringFrequency',
      header: 'Frequency',
      render: (_value, mapping) => (
        <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">
          {getFrequencyLabel(mapping.monitoringFrequency)}
        </span>
      ),
    },
    {
      key: 'alertEnabled',
      header: 'Alert',
      align: 'center',
      render: (_value, mapping) => (
        <button
          onClick={() => void handleToggleAlert(mapping)}
          disabled={updateMutation.isPending}
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            mapping.alertEnabled
              ? 'bg-green-100 text-green-800 hover:bg-green-200'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
          }`}
        >
          {mapping.alertEnabled ? 'On' : 'Off'}
        </button>
      ),
    },
    {
      key: 'isActive',
      header: 'Active',
      align: 'center',
      render: (_value, mapping) => (
        <button
          onClick={() => void handleToggleActive(mapping)}
          disabled={updateMutation.isPending}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
            mapping.isActive ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'
          }`}
          role="switch"
          aria-checked={mapping.isActive}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-900 shadow ring-0 transition duration-200 ease-in-out ${
              mapping.isActive ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, mapping) => (
        <Button
          variant="ghost"
          onClick={() => void handleRemove(mapping.id)}
          disabled={deletingId === mapping.id}
        >
          {deletingId === mapping.id ? 'Removing...' : 'Remove'}
        </Button>
      ),
    },
  ];

  return (
    <Modal isOpen onClose={onClose} title="Equipment Monitoring Points" size="xl">
      <p className="-mt-2 mb-4 text-sm text-gray-500 dark:text-gray-400">
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
            <Spinner size="lg" />
          </div>
        )}

        {/* Mappings Table */}
        {!mappingsLoading && (
          <DataTable<ParamEquipmentMapping>
            data={mappings ?? []}
            columns={mappingColumns}
            keyExtractor={(mapping) => mapping.id}
            emptyMessage="No equipment mapped to this parameter yet."
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />
        )}

        {/* Add Equipment Form */}
        {showAddForm && (
          <div className="mt-4 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
              Add Equipment Mapping
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Category filter */}
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                  className="w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
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
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Equipment
                </label>
                <select
                  value={addForm.equipmentId}
                  onChange={(e) =>
                    setAddForm((prev) => ({
                      ...prev,
                      equipmentId: e.target.value,
                    }))
                  }
                  disabled={equipmentLoading}
                  className="w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
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
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                  className="w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
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
                    className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Enable Alerts</span>
                </label>
              </div>
            </div>

            {/* Form actions */}
            <div className="mt-4 flex justify-end space-x-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowAddForm(false);
                  setAddForm(INITIAL_ADD_FORM);
                  createMutation.reset();
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleAddMapping}
                disabled={!addForm.equipmentId || createMutation.isPending}
              >
                {createMutation.isPending ? 'Adding...' : 'Add Mapping'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-4">
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {mappings ? `${mappings.length} equipment mapped` : ''}
        </div>
        <div className="flex space-x-3">
          {!showAddForm && (
            <Button variant="primary" onClick={() => setShowAddForm(true)}>
              <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
              Add Equipment
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
};
