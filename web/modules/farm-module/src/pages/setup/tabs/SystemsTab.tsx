/**
 * Systems Tab Component
 * Displays list of systems with CRUD operations
 * Supports hierarchical parent-child relationships
 */
import React, { useState, useMemo } from 'react';
import { DeleteConfirmationDialog, DeletePreviewData, AffectedItemGroup } from '@aquaculture/shared-ui';
import {
  useSystemList,
  useCreateSystem,
  useUpdateSystem,
  useDeleteSystem,
  useSystemDeletePreview,
  System,
  CreateSystemInput,
  UpdateSystemInput
} from '../../../hooks/useSystems';
import { useSiteList } from '../../../hooks/useSites';
import { useDepartmentsBySite } from '../../../hooks/useDepartments';

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
  OTHER: 'bg-gray-100 text-gray-800',
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
  const [searchTerm, setSearchTerm] = useState('');
  const [filterSiteId, setFilterSiteId] = useState('');
  const [showOrphanedOnly, setShowOrphanedOnly] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [systemToDelete, setSystemToDelete] = useState<System | null>(null);

  // API hooks
  const { data: systemsData, isLoading, error } = useSystemList({
    siteId: filterSiteId || undefined,
    search: searchTerm || undefined
  });
  const { data: sitesData } = useSiteList();
  const { data: departmentsList } = useDepartmentsBySite(formData.siteId || '');
  const createSystem = useCreateSystem();
  const updateSystem = useUpdateSystem();
  const deleteSystem = useDeleteSystem();

  // Delete preview query
  const { data: deletePreview, isLoading: isPreviewLoading } = useSystemDeletePreview(
    systemToDelete?.id ?? null
  );

  // Transform backend preview to dialog format
  const dialogPreview = useMemo((): DeletePreviewData | null => {
    if (!deletePreview) return null;

    const affectedItems: AffectedItemGroup[] = [];

    if (deletePreview.affectedItems.childSystems.length > 0) {
      affectedItems.push({
        type: 'childSystems',
        label: 'Alt Sistemler',
        items: deletePreview.affectedItems.childSystems.map(s => ({
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
        items: deletePreview.affectedItems.equipment.map(e => ({
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
  const systems = showOrphanedOnly
    ? allSystems.filter(s => !s.departmentId)
    : allSystems;

  // Count orphaned systems (no department)
  const orphanedCount = allSystems.filter(s => !s.departmentId).length;

  // Get available parent systems (exclude current system if editing)
  const availableParentSystems = systems.filter(s =>
    s.id !== editingSystem?.id &&
    (!formData.siteId || s.siteId === formData.siteId)
  );

  const handleCreate = () => {
    setEditingSystem(null);
    setFormData(emptyFormData);
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
      alert(err instanceof Error ? err.message : 'Failed to delete system');
    }
  };

  const handleCloseDeleteDialog = () => {
    setDeleteDialogOpen(false);
    setSystemToDelete(null);
  };

  const handleSave = async () => {
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
          siteId: formData.siteId,
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
      alert(err instanceof Error ? err.message : 'Failed to save system');
    }
  };

  const handleFormChange = (field: keyof SystemFormData, value: string) => {
    setFormData(prev => {
      const updated = { ...prev, [field]: value };
      // Reset department and parent system when site changes
      if (field === 'siteId') {
        updated.departmentId = '';
        updated.parentSystemId = '';
      }
      return updated;
    });
  };

  if (error) {
    return (
      <div className="text-center py-12 text-red-600">
        Error loading systems: {error instanceof Error ? error.message : 'Unknown error'}
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4 max-w-2xl">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="Search systems..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <svg
              className="absolute left-3 top-2.5 w-5 h-5 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <select
            value={filterSiteId}
            onChange={(e) => setFilterSiteId(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">All Sites</option>
            {sites.map(site => (
              <option key={site.id} value={site.id}>{site.name}</option>
            ))}
          </select>
          <label className="flex items-center text-sm text-gray-600 ml-2">
            <input
              type="checkbox"
              checked={showOrphanedOnly}
              onChange={(e) => setShowOrphanedOnly(e.target.checked)}
              className="mr-2 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Orphaned only
          </label>
        </div>
        <button
          onClick={handleCreate}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add System
        </button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-2 text-gray-500">Loading systems...</p>
        </div>
      )}

      {/* Orphaned Systems Warning */}
      {orphanedCount > 0 && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center">
          <svg className="w-5 h-5 text-red-500 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
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
                  : 'border-gray-200 bg-white'
              }`}
            >
              <div className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-semibold text-gray-900">{system.name}</h3>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[system.status] || 'bg-gray-100 text-gray-800'}`}>
                        {system.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <p className="text-sm text-gray-500">{system.code}</p>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${typeColors[system.type] || 'bg-gray-100 text-gray-800'}`}>
                        {systemTypes.find(t => t.value === system.type)?.label || system.type}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => handleEdit(system)}
                      className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                      title="Edit"
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(system)}
                      className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                      title="Delete"
                      disabled={deleteSystem.isPending}
                    >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {system.site && (
                    <div className="flex items-center text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                      </svg>
                      {system.site.name}
                    </div>
                  )}
                  {system.department ? (
                    <div className="flex items-center text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" />
                      </svg>
                      {system.department.name}
                    </div>
                  ) : (
                    <div className="flex items-center text-sm text-red-600">
                      <svg className="w-4 h-4 mr-2 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      Not associated with any department
                    </div>
                  )}
                  {system.parentSystem && (
                    <div className="flex items-center text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                      </svg>
                      Parent: {system.parentSystem.name}
                    </div>
                  )}
                  {system.totalVolumeM3 && (
                    <div className="flex items-center text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                      </svg>
                      {system.totalVolumeM3.toLocaleString()} m³
                    </div>
                  )}
                  {system.maxBiomassKg && (
                    <div className="flex items-center text-sm text-gray-600">
                      <svg className="w-4 h-4 mr-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
                      </svg>
                      Max: {system.maxBiomassKg.toLocaleString()} kg
                    </div>
                  )}
                </div>

                {system.description && (
                  <p className="mt-3 text-sm text-gray-500 line-clamp-2">{system.description}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && systems.length === 0 && (
        <div className="text-center py-12">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">No systems found</h3>
          <p className="mt-1 text-sm text-gray-500">
            {searchTerm || filterSiteId ? 'Try adjusting your filters.' : 'Get started by creating a new system.'}
          </p>
          {!searchTerm && !filterSiteId && (
            <button
              onClick={handleCreate}
              className="mt-4 inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              Add System
            </button>
          )}
        </div>
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">
                {editingSystem ? 'Edit System' : 'Add New System'}
              </h2>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => handleFormChange('name', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="System name"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Code *</label>
                  <input
                    type="text"
                    value={formData.code}
                    onChange={(e) => handleFormChange('code', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="SYS-001"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Type *</label>
                  <select
                    value={formData.type}
                    onChange={(e) => handleFormChange('type', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {systemTypes.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => handleFormChange('status', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {systemStatuses.map(status => (
                      <option key={status.value} value={status.value}>{status.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Site *</label>
                <select
                  value={formData.siteId}
                  onChange={(e) => handleFormChange('siteId', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={!!editingSystem}
                >
                  <option value="">Select a site</option>
                  {sites.map(site => (
                    <option key={site.id} value={site.id}>{site.name}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
                  <select
                    value={formData.departmentId}
                    onChange={(e) => handleFormChange('departmentId', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    disabled={!formData.siteId}
                  >
                    <option value="">Select a department</option>
                    {departments.map(dept => (
                      <option key={dept.id} value={dept.id}>{dept.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Parent System</label>
                  <select
                    value={formData.parentSystemId}
                    onChange={(e) => handleFormChange('parentSystemId', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    disabled={!formData.siteId}
                  >
                    <option value="">No parent (root system)</option>
                    {availableParentSystems.map(sys => (
                      <option key={sys.id} value={sys.id}>{sys.name} ({sys.code})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => handleFormChange('description', e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="System description..."
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Total Volume (m³)</label>
                  <input
                    type="number"
                    value={formData.totalVolumeM3}
                    onChange={(e) => handleFormChange('totalVolumeM3', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="0"
                    step="0.01"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Max Biomass (kg)</label>
                  <input
                    type="number"
                    value={formData.maxBiomassKg}
                    onChange={(e) => handleFormChange('maxBiomassKg', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="0"
                    step="0.01"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tank Count</label>
                  <input
                    type="number"
                    value={formData.tankCount}
                    onChange={(e) => handleFormChange('tankCount', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="0"
                  />
                </div>
              </div>
            </div>

            <div className="p-6 border-t border-gray-200 flex justify-end space-x-3">
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!formData.name || !formData.code || !formData.siteId || createSystem.isPending || updateSystem.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createSystem.isPending || updateSystem.isPending ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

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
