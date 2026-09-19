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
  OPERATIONAL: 'bg-green-100 text-green-800',
  MAINTENANCE: 'bg-yellow-100 text-yellow-800',
  OFFLINE: 'bg-red-100 text-red-800',
  CONSTRUCTION: 'bg-blue-100 text-blue-800',
};

const typeColors: Record<string, string> = {
  RAS: 'bg-purple-100 text-purple-800',
  FLOW_THROUGH: 'bg-cyan-100 text-cyan-800',
  POND: 'bg-emerald-100 text-emerald-800',
  CAGE: 'bg-orange-100 text-orange-800',
  RACEWAY: 'bg-indigo-100 text-indigo-800',
  HATCHERY: 'bg-pink-100 text-pink-800',
  NURSERY: 'bg-lime-100 text-lime-800',
  BIOFLOC: 'bg-teal-100 text-teal-800',
  AQUAPONICS: 'bg-sky-100 text-sky-800',
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
      <div className="text-center py-12 text-red-600">
        Error loading systems: {error instanceof Error ? error.message : 'Unknown error'}
      </div>
    );
  }

  return (
    <div>
      {/* Non-blocking refresh error — keeps the last-loaded systems visible. */}
      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800">
            Couldn&apos;t refresh systems — showing the last loaded data.{' '}
            <span className="text-amber-700">
              {error instanceof Error ? error.message : 'Unknown error'}
            </span>
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
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4 max-w-2xl">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="Search systems..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <SearchIcon
              className="absolute left-3 top-2.5 w-5 h-5 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
          </div>
          <select
            value={filterSiteId}
            onChange={(e) => setFilterSiteId(e.target.value)}
            className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">All Sites</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
          <label className="flex items-center text-sm text-gray-600 dark:text-gray-400 ml-2">
            <input
              type="checkbox"
              checked={showOrphanedOnly}
              onChange={(e) => setShowOrphanedOnly(e.target.checked)}
              className="mr-2 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
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
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center">
          <TriangleAlert className="w-5 h-5 text-red-500 mr-2 flex-shrink-0" aria-hidden="true" />
          <span className="text-sm text-red-700">
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
                  ? 'border-red-300 bg-red-50'
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
                    <div className="flex items-center text-sm text-red-600">
                      <TriangleAlert className="w-4 h-4 mr-2 text-red-400" aria-hidden="true" />
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
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Type *
              </label>
              <select
                value={formData.type}
                onChange={(e) => handleFormChange('type', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {systemTypes.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Status
              </label>
              <select
                value={formData.status}
                onChange={(e) => handleFormChange('status', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {systemStatuses.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Site *
            </label>
            <FormField error={formData.siteId ? undefined : fieldErrors.siteId} className="mb-0">
              <select
                value={formData.siteId}
                onChange={(e) => handleFormChange('siteId', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={!!editingSystem}
              >
                <option value="">Select a site</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Department
              </label>
              <select
                value={formData.departmentId}
                onChange={(e) => handleFormChange('departmentId', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={!formData.siteId}
              >
                <option value="">
                  {deptError
                    ? 'Departmanlar yüklenemedi'
                    : departments.length === 0 && formData.siteId
                      ? 'Bu site için departman bulunamadı'
                      : 'Departman seçin'}
                </option>
                {departments.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {dept.name}
                  </option>
                ))}
              </select>
              {deptError && (
                <p className="text-xs text-red-500 mt-1">Departmanlar yüklenirken hata oluştu</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Parent System
              </label>
              <select
                value={formData.parentSystemId}
                onChange={(e) => handleFormChange('parentSystemId', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={!formData.siteId}
              >
                <option value="">No parent (root system)</option>
                {availableParentSystems.map((sys) => (
                  <option key={sys.id} value={sys.id}>
                    {sys.name} ({sys.code})
                  </option>
                ))}
              </select>
            </div>
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
