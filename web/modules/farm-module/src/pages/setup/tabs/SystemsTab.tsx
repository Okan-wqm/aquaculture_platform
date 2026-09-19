/**
 * Systems Tab Component
 * Displays list of systems with CRUD operations
 * Supports hierarchical parent-child relationships
 */
import React, { useState, useMemo } from 'react';
import {
  FormField,
  Modal,
  DeleteConfirmationDialog,
  DeletePreviewData,
  AffectedItemGroup,
  useToast,
  Spinner,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import {
  useSystemList,
  useCreateSystem,
  useUpdateSystem,
  useDeleteSystem,
  useSystemDeletePreview,
  System,
  CreateSystemInput,
  UpdateSystemInput,
} from '../../../hooks/useSystems';
import { useSiteList } from '../../../hooks/useSites';
import { useDepartmentsBySite } from '../../../hooks/useDepartments';
import { isBlockingError } from '../../../utils/list-view-state';
import {
  ArrowUp,
  Box,
  Building2,
  Layers,
  Pencil,
  Plus,
  Scale,
  Search as SearchIcon,
  Square,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

// System types matching backend enum (UPPERCASE)
const systemTypes = [
  { value: 'RAS', label: 'RAS (Recirculating)' },
  { value: 'FLOW_THROUGH', label: 'Flow-through' },
  { value: 'POND', label: 'Pond' },
  { value: 'CAGE', label: 'Cage' },
  { value: 'RACEWAY', label: 'Raceway' },
  { value: 'HATCHERY', label: 'Hatchery' },
  { value: 'NURSERY', label: 'Nursery' },
  { value: 'BIOFLOC', label: 'Biofloc' },
  { value: 'AQUAPONICS', label: 'Aquaponics' },
  { value: 'OTHER', label: 'Other' },
];

const systemStatuses = [
  { value: 'OPERATIONAL', label: 'Operational' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'OFFLINE', label: 'Offline' },
  { value: 'CONSTRUCTION', label: 'Construction' },
];

const statusColors: Record<string, string> = {
  OPERATIONAL: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  MAINTENANCE: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  OFFLINE: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  CONSTRUCTION: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
};

const typeColors: Record<string, string> = {
  RAS: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  FLOW_THROUGH: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  POND: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  CAGE: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  RACEWAY: 'bg-primary-100 dark:bg-primary-900/40 text-primary-800 dark:text-primary-200',
  HATCHERY: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  NURSERY: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  BIOFLOC: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  AQUAPONICS: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  OTHER: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
};

interface SystemFormData {
  name: string;
  code: string;
  type: string;
  status: string;
  siteId: string;
  departmentId: string;
  parentSystemId: string;
  description: string;
  totalVolumeM3: string;
  maxBiomassKg: string;
  tankCount: string;
}

const emptyFormData: SystemFormData = {
  name: '',
  code: '',
  type: 'OTHER',
  status: 'OPERATIONAL',
  siteId: '',
  departmentId: '',
  parentSystemId: '',
  description: '',
  totalVolumeM3: '',
  maxBiomassKg: '',
  tankCount: '',
};

export const SystemsTab: React.FC = () => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSystem, setEditingSystem] = useState<System | null>(null);
  const [formData, setFormData] = useState<SystemFormData>(emptyFormData);
  // FE-HIGH-086: required-field misses land on the field, not in a toast.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [filterSiteId, setFilterSiteId] = useState('');
  const [showOrphanedOnly, setShowOrphanedOnly] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [systemToDelete, setSystemToDelete] = useState<System | null>(null);

  // API hooks
  const {
    data: systemsData,
    isLoading,
    error,
    refetch,
  } = useSystemList({
    siteId: filterSiteId || undefined,
    search: searchTerm || undefined,
  });
  const { data: sitesData } = useSiteList();
  const { data: departmentsList, error: deptError } = useDepartmentsBySite(formData.siteId || '');
  const createSystem = useCreateSystem();
  const updateSystem = useUpdateSystem();
  const deleteSystem = useDeleteSystem();

  // Delete preview query
  const { data: deletePreview, isLoading: isPreviewLoading } = useSystemDeletePreview(
    systemToDelete?.id ?? null,
  );

  // Transform backend preview to dialog format
  const dialogPreview = useMemo((): DeletePreviewData | null => {
    if (!deletePreview) return null;

    const affectedItems: AffectedItemGroup[] = [];

    if (deletePreview.affectedItems.childSystems.length > 0) {
      affectedItems.push({
        type: 'childSystems',
        label: 'Alt Sistemler',
        items: deletePreview.affectedItems.childSystems.map((s) => ({
          id: s.id,
          name: s.name,
          code: s.code,
          status: `${s.equipmentCount} ekipman`,
        })),
      });
    }

    if (deletePreview.affectedItems.equipment.length > 0) {
      affectedItems.push({
        type: 'equipment',
        label: 'Ekipmanlar',
        items: deletePreview.affectedItems.equipment.map((e) => ({
          id: e.id,
          name: e.name,
          code: e.code,
          status: e.status,
        })),
      });
    }

    return {
      canDelete: deletePreview.canDelete,
      blockers: deletePreview.blockers,
      affectedItems,
      totalCount: deletePreview.affectedItems.totalCount,
    };
  }, [deletePreview]);

  const allSystems = systemsData?.items || [];
  const sites = sitesData?.items || [];
  const departments = departmentsList || [];

  // Filter systems based on orphaned filter
  const systems = showOrphanedOnly ? allSystems.filter((s) => !s.departmentId) : allSystems;

  // Count orphaned systems (no department)
  const orphanedCount = allSystems.filter((s) => !s.departmentId).length;

  // Get available parent systems (exclude current system if editing)
  const availableParentSystems = systems.filter(
    (s) => s.id !== editingSystem?.id && (!formData.siteId || s.siteId === formData.siteId),
  );

  const handleCreate = () => {
    setEditingSystem(null);
    setFormData(emptyFormData);
    setFieldErrors({});
    setIsModalOpen(true);
  };

  const handleEdit = (system: System) => {
    setEditingSystem(system);
    setFormData({
      name: system.name,
      code: system.code,
      type: system.type,
      status: system.status,
      siteId: system.siteId,
      departmentId: system.departmentId || '',
      parentSystemId: system.parentSystemId || '',
      description: system.description || '',
      totalVolumeM3: system.totalVolumeM3?.toString() || '',
      maxBiomassKg: system.maxBiomassKg?.toString() || '',
      tankCount: system.tankCount?.toString() || '',
    });
    setIsModalOpen(true);
  };

  const { toast } = useToast();
  const handleDelete = (system: System) => {
    setSystemToDelete(system);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!systemToDelete) return;
    try {
      await deleteSystem.mutateAsync({ id: systemToDelete.id, cascade: true });
      setDeleteDialogOpen(false);
      setSystemToDelete(null);
    } catch (err) {
      toast({
        title: 'Failed to delete system',
        description: err instanceof Error ? err.message : undefined,
        variant: 'error',
      });
    }
  };

  const handleCloseDeleteDialog = () => {
    setDeleteDialogOpen(false);
    setSystemToDelete(null);
  };

  const handleSave = async () => {
    if (!editingSystem) {
      const errors: Record<string, string> = {};
      if (!formData.name) errors.name = 'Please enter a name.';
      if (!formData.code) errors.code = 'Please enter a code.';
      if (!formData.siteId) errors.siteId = 'Please select a site.';
      setFieldErrors(errors);
      if (Object.keys(errors).length > 0) return;
    }

    try {
      if (editingSystem) {
        const input: UpdateSystemInput = {
          id: editingSystem.id,
          name: formData.name,
          code: formData.code,
          type: formData.type,
          status: formData.status,
          departmentId: formData.departmentId || undefined,
          parentSystemId: formData.parentSystemId || undefined,
          description: formData.description || undefined,
          totalVolumeM3: formData.totalVolumeM3 ? parseFloat(formData.totalVolumeM3) : undefined,
          maxBiomassKg: formData.maxBiomassKg ? parseFloat(formData.maxBiomassKg) : undefined,
          tankCount: formData.tankCount ? parseInt(formData.tankCount) : undefined,
        };
        await updateSystem.mutateAsync(input);
      } else {
        const input: CreateSystemInput = {
          name: formData.name,
          code: formData.code,
          type: formData.type,
          siteId: formData.siteId || undefined,
          status: formData.status || undefined,
          departmentId: formData.departmentId || undefined,
          parentSystemId: formData.parentSystemId || undefined,
          description: formData.description || undefined,
          totalVolumeM3: formData.totalVolumeM3 ? parseFloat(formData.totalVolumeM3) : undefined,
          maxBiomassKg: formData.maxBiomassKg ? parseFloat(formData.maxBiomassKg) : undefined,
          tankCount: formData.tankCount ? parseInt(formData.tankCount) : undefined,
        };
        await createSystem.mutateAsync(input);
      }
      setIsModalOpen(false);
    } catch (err) {
      toast({
        title: 'Failed to save system',
        description: err instanceof Error ? err.message : undefined,
        variant: 'error',
      });
    }
  };

  const handleFormChange = (field: keyof SystemFormData, value: string) => {
    setFormData((prev) => {
      const updated = { ...prev, [field]: value };
      // Reset department and parent system when site changes
      if (field === 'siteId') {
        updated.departmentId = '';
        updated.parentSystemId = '';
      }
      return updated;
    });
  };

  // Blocking error — ONLY when the initial load failed and there is no cached
  // data. A failed background refetch with cached systems keeps rendering the
  // list and surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, (systemsData?.items?.length ?? 0) > 0)) {
    return (
      <div className="text-center py-12 text-error-600 dark:text-error-400">
        Error loading systems: {error instanceof Error ? error.message : 'Unknown error'}
      </div>
    );
  }

  return (
    <div>
      {/* Non-blocking refresh error — keeps the last-loaded systems visible. */}
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-warning-200 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20 p-3">
          <p className="text-sm text-warning-800 dark:text-warning-200">
            Couldn&apos;t refresh systems — showing the last loaded data.{' '}
            <span className="text-warning-700 dark:text-warning-300">
              {error instanceof Error ? error.message : 'Unknown error'}
            </span>
          </p>
          <button
            onClick={() => refetch()}
            className="ml-3 shrink-0 rounded bg-warning-100 dark:bg-warning-900/40 px-3 py-1 text-sm text-warning-800 dark:text-warning-200 hover:bg-warning-200 dark:hover:bg-warning-800/60"
          >
            Retry
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4 max-w-2xl">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="Search systems..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent"
            />
            <SearchIcon
              className="absolute left-3 top-2.5 w-5 h-5 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
          </div>
          <Select
            aria-label="Site filter"
            fullWidth={false}
            value={filterSiteId}
            onChange={(e) => setFilterSiteId(e.target.value)}
            options={[
              { value: '', label: 'All Sites' },
              ...sites.map((site) => ({ value: site.id, label: site.name })),
            ]}
          />
          <label className="flex items-center text-sm text-gray-600 dark:text-gray-400 ml-2">
            <input
              type="checkbox"
              checked={showOrphanedOnly}
              onChange={(e) => setShowOrphanedOnly(e.target.checked)}
              className="mr-2 rounded border-gray-300 dark:border-gray-600 text-info-600 focus:ring-info-500"
            />
            Orphaned only
          </label>
        </div>
        <Button variant="primary" onClick={handleCreate}>
          <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
          Add System
        </Button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="text-center py-12">
          <Spinner size="lg" block />
          <p className="mt-2 text-gray-500 dark:text-gray-400">Loading systems...</p>
        </div>
      )}

      {/* Orphaned Systems Warning */}
      {orphanedCount > 0 && (
        <div className="mb-4 p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg flex items-center">
          <TriangleAlert className="w-5 h-5 text-error-500 mr-2 flex-shrink-0" aria-hidden="true" />
          <span className="text-sm text-error-700 dark:text-error-300">
            {orphanedCount} system(s) are not associated with any department
          </span>
        </div>
      )}

      {/* Systems Grid */}
      {!isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {systems.map((system) => (
            <div
              key={system.id}
              className={`rounded-lg shadow-sm border hover:shadow-md transition-shadow ${
                !system.departmentId
                  ? 'border-error-300 dark:border-error-700 bg-error-50 dark:bg-error-900/20'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'
              }`}
            >
              <div className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {system.name}
                      </h3>
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[system.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                      >
                        {system.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <p className="text-sm text-gray-500 dark:text-gray-400">{system.code}</p>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${typeColors[system.type] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                      >
                        {systemTypes.find((t) => t.value === system.type)?.label || system.type}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(system)}
                      title="Edit"
                    >
                      <Pencil className="w-5 h-5" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(system)}
                      title="Delete"
                      disabled={deleteSystem.isPending}
                    >
                      <Trash2 className="w-5 h-5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {system.site && (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <Building2
                        className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                        aria-hidden="true"
                      />
                      {system.site.name}
                    </div>
                  )}
                  {system.department ? (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <Square
                        className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                        aria-hidden="true"
                      />
                      {system.department.name}
                    </div>
                  ) : (
                    <div className="flex items-center text-sm text-error-600 dark:text-error-400">
                      <TriangleAlert className="w-4 h-4 mr-2 text-error-400" aria-hidden="true" />
                      Not associated with any department
                    </div>
                  )}
                  {system.parentSystem && (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <ArrowUp
                        className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                        aria-hidden="true"
                      />
                      Parent: {system.parentSystem.name}
                    </div>
                  )}
                  {system.totalVolumeM3 && (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <Box
                        className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                        aria-hidden="true"
                      />
                      {system.totalVolumeM3.toLocaleString()} m³
                    </div>
                  )}
                  {system.maxBiomassKg && (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <Scale
                        className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                        aria-hidden="true"
                      />
                      Max: {system.maxBiomassKg.toLocaleString()} kg
                    </div>
                  )}
                </div>

                {system.description && (
                  <p className="mt-3 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
                    {system.description}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && systems.length === 0 && (
        <div className="text-center py-12">
          <Layers
            className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            No systems found
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {searchTerm || filterSiteId
              ? 'Try adjusting your filters.'
              : 'Get started by creating a new system.'}
          </p>
          {!searchTerm && !filterSiteId && (
            <Button variant="primary" className="mt-4" onClick={handleCreate}>
              <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
              Add System
            </Button>
          )}
        </div>
      )}

      {/* Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingSystem ? 'Edit System' : 'Add New System'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={
                !formData.name ||
                !formData.code ||
                !formData.siteId ||
                createSystem.isPending ||
                updateSystem.isPending
              }
            >
              {createSystem.isPending || updateSystem.isPending ? 'Saving...' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Name *
              </label>
              <FormField error={formData.name ? undefined : fieldErrors.name} className="mb-0">
                <Input
                  fullWidth
                  type="text"
                  value={formData.name}
                  onChange={(e) => handleFormChange('name', e.target.value)}
                  placeholder="System name"
                />
              </FormField>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Code *
              </label>
              <FormField error={formData.code ? undefined : fieldErrors.code} className="mb-0">
                <Input
                  fullWidth
                  type="text"
                  value={formData.code}
                  onChange={(e) => handleFormChange('code', e.target.value)}
                  placeholder="SYS-001"
                />
              </FormField>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Type"
              required
              value={formData.type}
              onChange={(e) => handleFormChange('type', e.target.value)}
              options={systemTypes.map((type) => ({ value: type.value, label: type.label }))}
            />
            <Select
              label="Status"
              value={formData.status}
              onChange={(e) => handleFormChange('status', e.target.value)}
              options={systemStatuses.map((status) => ({
                value: status.value,
                label: status.label,
              }))}
            />
          </div>

          <Select
            label="Site"
            required
            placeholder="Select a site"
            value={formData.siteId}
            onChange={(e) => handleFormChange('siteId', e.target.value)}
            disabled={!!editingSystem}
            error={formData.siteId ? undefined : fieldErrors.siteId}
            options={sites.map((site) => ({ value: site.id, label: site.name }))}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Select
                label="Department"
                value={formData.departmentId}
                onChange={(e) => handleFormChange('departmentId', e.target.value)}
                disabled={!formData.siteId}
                options={[
                  {
                    value: '',
                    label: deptError
                      ? 'Departmanlar yüklenemedi'
                      : departments.length === 0 && formData.siteId
                        ? 'Bu site için departman bulunamadı'
                        : 'Departman seçin',
                  },
                  ...departments.map((dept) => ({ value: dept.id, label: dept.name })),
                ]}
              />
              {deptError && (
                <p className="text-xs text-error-500 mt-1">Departmanlar yüklenirken hata oluştu</p>
              )}
            </div>
            <Select
              label="Parent System"
              value={formData.parentSystemId}
              onChange={(e) => handleFormChange('parentSystemId', e.target.value)}
              disabled={!formData.siteId}
              options={[
                { value: '', label: 'No parent (root system)' },
                ...availableParentSystems.map((sys) => ({
                  value: sys.id,
                  label: `${sys.name} (${sys.code})`,
                })),
              ]}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Description
            </label>
            <Textarea
              fullWidth
              value={formData.description}
              onChange={(e) => handleFormChange('description', e.target.value)}
              rows={3}
              placeholder="System description..."
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Total Volume (m³)
              </label>
              <Input
                fullWidth
                type="number"
                value={formData.totalVolumeM3}
                onChange={(e) => handleFormChange('totalVolumeM3', e.target.value)}
                placeholder="0"
                step="0.01"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Max Biomass (kg)
              </label>
              <Input
                fullWidth
                type="number"
                value={formData.maxBiomassKg}
                onChange={(e) => handleFormChange('maxBiomassKg', e.target.value)}
                placeholder="0"
                step="0.01"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Tank Count
              </label>
              <Input
                fullWidth
                type="number"
                value={formData.tankCount}
                onChange={(e) => handleFormChange('tankCount', e.target.value)}
                placeholder="0"
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isOpen={deleteDialogOpen}
        onClose={handleCloseDeleteDialog}
        onConfirm={handleConfirmDelete}
        title="Sistem Silme Onayı"
        entityName={systemToDelete?.name ?? ''}
        entityType="Sistem"
        preview={dialogPreview}
        isLoading={isPreviewLoading}
        isDeleting={deleteSystem.isPending}
      />
    </div>
  );
};

export default SystemsTab;
