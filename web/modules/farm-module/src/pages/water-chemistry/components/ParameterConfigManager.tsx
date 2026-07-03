/**
 * Parameter Config Manager
 *
 * Admin UI for managing water quality parameter configurations.
 * Provides a table view with inline active toggle, create/edit modal,
 * delete confirmation, and template picker integration.
 */
import React, { useState, useMemo } from 'react';
import {
  useParameterConfigList,
  useCreateParameterConfig,
  useUpdateParameterConfig,
  useDeleteParameterConfig,
  useApplyParameterTemplate,
  ParameterConfig,
  ParameterConfigFilter,
  ParameterGroup,
  getGroupLabel,
  getGroupColor,
  GROUP_OPTIONS,
  CreateParameterConfigInput,
  UpdateParameterConfigInput,
} from '../../../hooks/useParameterConfigs';
import { useParamEquipmentMappings } from '../../../hooks/useParamEquipmentMapping';
import { isBlockingError } from '../../../utils/list-view-state';
import { TemplatePickerModal } from './TemplatePickerModal';
import { ConfigFormModal, ConfigFormData, EMPTY_FORM } from './ConfigFormModal';
import { EquipmentMappingPanel } from './EquipmentMappingPanel';

// ============================================================================
// TYPES
// ============================================================================

type ModalMode = 'create' | 'edit' | null;

// ============================================================================
// DELETE CONFIRMATION DIALOG
// ============================================================================

const DeleteConfirmDialog: React.FC<{
  config: ParameterConfig;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting: boolean;
}> = ({ config, onConfirm, onCancel, isDeleting }) => (
  <div className="fixed inset-0 z-50 overflow-y-auto">
    <div className="flex items-center justify-center min-h-screen px-4">
      <div className="fixed inset-0 bg-gray-500/75" onClick={onCancel} />
      <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6 z-10">
        <div className="flex items-start">
          <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
            <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="ml-4">
            <h3 className="text-lg font-medium text-gray-900">Delete Parameter</h3>
            <p className="mt-2 text-sm text-gray-500">
              Are you sure you want to delete <strong>&quot;{config.name}&quot;</strong> ({config.code})?
              This action cannot be undone.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end space-x-3">
          <button type="button" onClick={onCancel}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" disabled={isDeleting} onClick={onConfirm}
            className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50">
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  </div>
);

// ============================================================================
// HELPERS
// ============================================================================

function buildFormData(config: ParameterConfig | null): ConfigFormData {
  if (!config) return EMPTY_FORM;
  return {
    code: config.code,
    name: config.name,
    unit: config.unit,
    dataType: config.dataType,
    group: config.group,
    precision: String(config.precision ?? 2),
    optimalMin: config.optimalMin != null ? String(config.optimalMin) : '',
    optimalMax: config.optimalMax != null ? String(config.optimalMax) : '',
    warningMin: config.warningMin != null ? String(config.warningMin) : '',
    warningMax: config.warningMax != null ? String(config.warningMax) : '',
    criticalMin: config.criticalMin != null ? String(config.criticalMin) : '',
    criticalMax: config.criticalMax != null ? String(config.criticalMax) : '',
    chartColor: config.chartColor || '#3B82F6',
    chartAxisGroup: config.chartAxisGroup || 'left',
    isVisible: config.isVisible,
    isRequired: config.isRequired,
  };
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const ParameterConfigManager: React.FC = () => {
  const [groupFilter, setGroupFilter] = useState<ParameterGroup | ''>('');
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editingConfig, setEditingConfig] = useState<ParameterConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ParameterConfig | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [equipmentMappingTarget, setEquipmentMappingTarget] = useState<ParameterConfig | null>(null);

  const filter = useMemo<ParameterConfigFilter>(() => ({
    group: groupFilter || undefined,
  }), [groupFilter]);

  const { data: configs, isLoading, error, refetch } = useParameterConfigList(filter);
  const createMutation = useCreateParameterConfig();
  const updateMutation = useUpdateParameterConfig();
  const deleteMutation = useDeleteParameterConfig();
  const applyTemplateMutation = useApplyParameterTemplate();

  // Fetch all mappings (no filter) to count equipment per parameter
  const { data: allMappings } = useParamEquipmentMappings();

  // Build a lookup: parameterConfigId -> count of mapped equipment
  const equipmentCountMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!allMappings) return map;
    for (const m of allMappings) {
      map.set(m.parameterConfigId, (map.get(m.parameterConfigId) ?? 0) + 1);
    }
    return map;
  }, [allMappings]);

  const sortedConfigs = useMemo(() => {
    if (!configs) return [];
    const items = Array.isArray(configs) ? configs : [];
    return [...items].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
  }, [configs]);

  // ---- Handlers ----

  const handleCloseModal = () => {
    setModalMode(null);
    setEditingConfig(null);
    createMutation.reset();
    updateMutation.reset();
  };

  const handleFormSubmit = async (data: ConfigFormData) => {
    try {
      if (modalMode === 'create') {
        const input: CreateParameterConfigInput = {
          code: data.code, name: data.name, unit: data.unit,
          dataType: data.dataType, group: data.group,
          precision: Number(data.precision) || 2,
          optimalMin: data.optimalMin ? Number(data.optimalMin) : undefined,
          optimalMax: data.optimalMax ? Number(data.optimalMax) : undefined,
          warningMin: data.warningMin ? Number(data.warningMin) : undefined,
          warningMax: data.warningMax ? Number(data.warningMax) : undefined,
          criticalMin: data.criticalMin ? Number(data.criticalMin) : undefined,
          criticalMax: data.criticalMax ? Number(data.criticalMax) : undefined,
          chartColor: data.chartColor || undefined,
          chartAxisGroup: data.chartAxisGroup || undefined,
          isVisible: data.isVisible, isRequired: data.isRequired,
        };
        await createMutation.mutateAsync(input);
      } else if (modalMode === 'edit' && editingConfig) {
        const input: UpdateParameterConfigInput = {
          id: editingConfig.id, name: data.name, unit: data.unit,
          dataType: data.dataType, group: data.group,
          precision: Number(data.precision) || 2,
          optimalMin: data.optimalMin ? Number(data.optimalMin) : null,
          optimalMax: data.optimalMax ? Number(data.optimalMax) : null,
          warningMin: data.warningMin ? Number(data.warningMin) : null,
          warningMax: data.warningMax ? Number(data.warningMax) : null,
          criticalMin: data.criticalMin ? Number(data.criticalMin) : null,
          criticalMax: data.criticalMax ? Number(data.criticalMax) : null,
          chartColor: data.chartColor || undefined,
          chartAxisGroup: data.chartAxisGroup || undefined,
          isVisible: data.isVisible, isRequired: data.isRequired,
        };
        await updateMutation.mutateAsync(input);
      }
      handleCloseModal();
    } catch {
      // Error is displayed via mutation.error in the modal
    }
  };

  const handleToggleActive = async (config: ParameterConfig) => {
    try {
      await updateMutation.mutateAsync({ id: config.id, isActive: !config.isActive });
    } catch {
      // Silently handled; query invalidation will re-fetch
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch {
      // Error handled
    }
  };

  const handleApplyTemplate = async (templateId: string, overwrite: boolean) => {
    try {
      await applyTemplateMutation.mutateAsync({ templateId, overwrite });
      setShowTemplatePicker(false);
    } catch {
      // Error handled
    }
  };

  // ---- Render ----

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  // Blocking error — ONLY when the initial load failed and there is no cached
  // configs. A failed background refetch with cached configs keeps rendering the
  // list and surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, (configs?.length ?? 0) > 0)) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-800">Failed to load parameter configs: {(error as Error).message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Non-blocking refresh error — keeps the last-loaded configs visible. */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800">
            Couldn&apos;t refresh parameter configs — showing the last loaded data.{' '}
            <span className="text-amber-700">{(error as Error).message}</span>
          </p>
          <button
            onClick={() => refetch()}
            className="ml-3 shrink-0 rounded bg-amber-100 px-3 py-1 text-sm text-amber-800 hover:bg-amber-200"
          >
            Retry
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <select value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value as ParameterGroup | '')}
            className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm">
            <option value="">All Groups</option>
            {GROUP_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center space-x-3">
          <button onClick={() => setShowTemplatePicker(true)}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
            </svg>
            Apply Template
          </button>
          <button onClick={() => { setEditingConfig(null); setModalMode('create'); }}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-green-500">
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Parameter
          </button>
        </div>
      </div>

      {/* Parameter Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Order</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Unit</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Group</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Optimal Range</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Critical Range</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Equipment</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Color</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Active</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {sortedConfigs.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-gray-500">
                    No parameter configurations found. Click &quot;Add Parameter&quot; or &quot;Apply Template&quot; to get started.
                  </td>
                </tr>
              )}
              {sortedConfigs.map((config) => (
                <tr key={config.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                    {config.displayOrder ?? '-'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                    {config.name}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 font-mono">
                    {config.code}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                    {config.unit}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getGroupColor(config.group)}`}>
                      {getGroupLabel(config.group)}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                    {config.optimalMin != null && config.optimalMax != null
                      ? `${config.optimalMin} - ${config.optimalMax}` : '-'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                    {config.criticalMin != null && config.criticalMax != null
                      ? `${config.criticalMin} - ${config.criticalMax}` : '-'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-center">
                    <button
                      onClick={() => setEquipmentMappingTarget(config)}
                      className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-md text-blue-700 bg-blue-50 hover:bg-blue-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                      title="Map Equipment"
                    >
                      <svg className="w-3.5 h-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                      {equipmentCountMap.get(config.id) ?? 0}
                    </button>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-center">
                    {config.chartColor ? (
                      <div className="inline-block w-6 h-6 rounded border border-gray-300"
                        style={{ backgroundColor: config.chartColor }} title={config.chartColor} />
                    ) : (
                      <span className="text-xs text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-center">
                    <button onClick={() => handleToggleActive(config)}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                        config.isActive ? 'bg-blue-600' : 'bg-gray-200'
                      }`}
                      role="switch" aria-checked={config.isActive}>
                      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        config.isActive ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right text-sm space-x-2">
                    <button onClick={() => { setEditingConfig(config); setModalMode('edit'); }}
                      className="text-blue-600 hover:text-blue-900">Edit</button>
                    <button onClick={() => setDeleteTarget(config)}
                      className="text-red-600 hover:text-red-900">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modals */}
      {modalMode && (
        <ConfigFormModal
          mode={modalMode}
          initialData={buildFormData(editingConfig)}
          onSubmit={handleFormSubmit}
          onClose={handleCloseModal}
          isSubmitting={createMutation.isPending || updateMutation.isPending}
          error={(createMutation.error as Error | null) || (updateMutation.error as Error | null)}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmDialog
          config={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          isDeleting={deleteMutation.isPending}
        />
      )}

      {showTemplatePicker && (
        <TemplatePickerModal
          onApply={handleApplyTemplate}
          onClose={() => setShowTemplatePicker(false)}
          isSubmitting={applyTemplateMutation.isPending}
        />
      )}

      {equipmentMappingTarget && (
        <EquipmentMappingPanel
          parameterConfigId={equipmentMappingTarget.id}
          parameterName={equipmentMappingTarget.name}
          onClose={() => setEquipmentMappingTarget(null)}
        />
      )}
    </div>
  );
};
