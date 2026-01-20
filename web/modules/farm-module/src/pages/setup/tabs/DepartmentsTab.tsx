/**
 * Departments Tab Component
 * Displays list of departments with CRUD operations
 */
import React, { useState, useMemo } from 'react';
import { DeleteConfirmationDialog, DeletePreviewData, AffectedItemGroup } from '@aquaculture/shared-ui';
import {
  useDepartmentList,
  useCreateDepartment,
  useUpdateDepartment,
  useDeleteDepartment,
  useDepartmentDeletePreview,
  Department,
  CreateDepartmentInput,
} from '../../../hooks/useDepartments';
import { useSiteList } from '../../../hooks/useSites';

const typeLabels: Record<string, string> = {
  HATCHERY: 'Hatchery',
  NURSERY: 'Nursery',
  GROW_OUT: 'Grow-out',
  BROODSTOCK: 'Broodstock',
  QUARANTINE: 'Quarantine',
  PROCESSING: 'Processing',
  STORAGE: 'Storage',
  LABORATORY: 'Laboratory',
};

const typeColors: Record<string, string> = {
  HATCHERY: 'bg-purple-100 text-purple-800',
  NURSERY: 'bg-cyan-100 text-cyan-800',
  GROW_OUT: 'bg-green-100 text-green-800',
  BROODSTOCK: 'bg-blue-100 text-blue-800',
  QUARANTINE: 'bg-red-100 text-red-800',
  PROCESSING: 'bg-orange-100 text-orange-800',
  STORAGE: 'bg-gray-100 text-gray-800',
  LABORATORY: 'bg-indigo-100 text-indigo-800',
};

interface DepartmentFormData {
  name: string;
  code: string;
  type: string;
  siteId: string;
  capacity: number;
  notes: string;
}

const initialFormData: DepartmentFormData = {
  name: '',
  code: '',
  type: 'HATCHERY',
  siteId: '',
  capacity: 0,
  notes: '',
};

export const DepartmentsTab: React.FC = () => {
  // API hooks
  const { data: departmentsData, isLoading, error, refetch } = useDepartmentList();
  const { data: sitesData } = useSiteList();
  const createDepartment = useCreateDepartment();
  const updateDepartment = useUpdateDepartment();
  const deleteDepartmentMutation = useDeleteDepartment();

  // Local state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSite, setSelectedSite] = useState<string>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<DepartmentFormData>(initialFormData);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deptToDelete, setDeptToDelete] = useState<Department | null>(null);

  // Delete preview query
  const { data: deletePreview, isLoading: isPreviewLoading } = useDepartmentDeletePreview(
    deptToDelete?.id ?? null
  );

  // Transform backend preview to dialog format
  const dialogPreview = useMemo((): DeletePreviewData | null => {
    if (!deletePreview) return null;

    const affectedItems: AffectedItemGroup[] = [];

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

    if (deletePreview.affectedItems.tanks.length > 0) {
      affectedItems.push({
        type: 'tanks',
        label: 'Tanklar',
        items: deletePreview.affectedItems.tanks.map(t => ({
          id: t.id,
          name: t.name,
          code: t.code,
          hasBlocker: t.hasActiveBiomass,
          blockerReason: t.hasActiveBiomass ? `${t.currentBiomass} kg biyokütle` : undefined,
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

  // Get data from API
  const departments = departmentsData?.items || [];
  const sites = sitesData?.items || [];

  const filteredDepartments = departments.filter(dept => {
    const matchesSearch =
      dept.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      dept.code.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesSite = selectedSite === 'all'
      || (selectedSite === 'orphaned' && !dept.siteId)
      || dept.siteId === selectedSite;
    return matchesSearch && matchesSite;
  });

  // Count orphaned departments
  const orphanedCount = departments.filter(d => !d.siteId).length;

  const getLoadPercentage = (current: number, capacity: number) => {
    if (!capacity) return 0;
    return Math.round((current / capacity) * 100);
  };

  const getLoadColor = (percentage: number) => {
    if (percentage >= 90) return 'bg-red-500';
    if (percentage >= 70) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        // Update existing - siteId is not updatable in backend
        await updateDepartment.mutateAsync({
          id: editingId,
          name: formData.name,
          code: formData.code,
          type: formData.type.toUpperCase(),
          capacity: formData.capacity,
          notes: formData.notes || undefined,
        });
      } else {
        // Create new
        await createDepartment.mutateAsync({
          name: formData.name,
          code: formData.code,
          type: formData.type.toUpperCase(),
          siteId: formData.siteId,
          capacity: formData.capacity,
          notes: formData.notes || undefined,
        } as CreateDepartmentInput);
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setEditingId(null);
    } catch (err) {
      console.error('Failed to save department:', err);
      alert('Failed to save department. Please try again.');
    }
  };

  const handleEdit = (dept: Department) => {
    setEditingId(dept.id);
    setFormData({
      name: dept.name,
      code: dept.code,
      type: dept.type || 'hatchery',
      siteId: dept.siteId || '',
      capacity: dept.capacity || 0,
      notes: dept.notes || '',
    });
    setIsModalOpen(true);
  };

  const handleDelete = (dept: Department) => {
    setDeptToDelete(dept);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!deptToDelete) return;
    try {
      await deleteDepartmentMutation.mutateAsync({ id: deptToDelete.id, cascade: true });
      setDeleteDialogOpen(false);
      setDeptToDelete(null);
    } catch (err) {
      console.error('Failed to delete department:', err);
      alert('Failed to delete department. Please try again.');
    }
  };

  const handleCloseDeleteDialog = () => {
    setDeleteDialogOpen(false);
    setDeptToDelete(null);
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search departments..."
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
            value={selectedSite}
            onChange={(e) => setSelectedSite(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Sites</option>
            <option value="orphaned">Orphaned (No Site)</option>
            {sites.map(site => (
              <option key={site.id} value={site.id}>{site.name}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setFormData(initialFormData);
            setIsModalOpen(true);
          }}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Department
        </button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load departments. Please try again.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {/* Orphaned Departments Warning */}
      {orphanedCount > 0 && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center">
          <svg className="w-5 h-5 text-red-500 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-sm text-red-700">
            {orphanedCount} department(s) are not associated with any site
          </span>
        </div>
      )}

      {/* Departments Table */}
      {!isLoading && !error && (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Department
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Type
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Site
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Capacity
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredDepartments.map((dept) => {
              const loadPercentage = getLoadPercentage(dept.currentLoad || 0, dept.capacity || 0);
              const site = sites.find(s => s.id === dept.siteId);
              return (
                <tr key={dept.id} className={!dept.siteId ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div>
                      <div className="text-sm font-medium text-gray-900">{dept.name}</div>
                      <div className="text-sm text-gray-500">{dept.code}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${typeColors[dept.type || ''] || 'bg-gray-100 text-gray-800'}`}>
                      {typeLabels[dept.type || ''] || dept.type || '-'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    {site?.name ? (
                      <span className="text-gray-500">{site.name}</span>
                    ) : (
                      <span className="text-red-600 italic font-medium">
                        Not associated with any site
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {dept.capacity ? (
                      <>
                        <div className="flex items-center">
                          <div className="flex-1 max-w-[100px]">
                            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className={`h-full ${getLoadColor(loadPercentage)} rounded-full transition-all`}
                                style={{ width: `${loadPercentage}%` }}
                              />
                            </div>
                          </div>
                          <span className="ml-2 text-sm text-gray-500">
                            {loadPercentage}%
                          </span>
                        </div>
                        <div className="text-xs text-gray-400 mt-1">
                          {(dept.currentLoad || 0).toLocaleString()} / {dept.capacity.toLocaleString()}
                        </div>
                      </>
                    ) : (
                      <span className="text-sm text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={() => handleEdit(dept)}
                      className="text-blue-600 hover:text-blue-900 mr-3"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(dept)}
                      className="text-red-600 hover:text-red-900"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Empty State */}
        {filteredDepartments.length === 0 && (
          <div className="text-center py-12">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900">No departments found</h3>
            <p className="mt-1 text-sm text-gray-500">
              Get started by creating a new department.
            </p>
          </div>
        )}
      </div>
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => setIsModalOpen(false)} />
            <div className="relative bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:max-w-lg sm:w-full">
              <form onSubmit={handleSubmit}>
                <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">
                    {editingId ? 'Edit Department' : 'Add Department'}
                  </h3>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Name</label>
                      <input
                        type="text"
                        required
                        value={formData.name}
                        onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Code</label>
                      <input
                        type="text"
                        required
                        value={formData.code}
                        onChange={e => setFormData(prev => ({ ...prev, code: e.target.value }))}
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Type</label>
                      <select
                        value={formData.type}
                        onChange={e => setFormData(prev => ({ ...prev, type: e.target.value }))}
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      >
                        {Object.entries(typeLabels).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Site *</label>
                      <select
                        value={formData.siteId}
                        onChange={e => setFormData(prev => ({ ...prev, siteId: e.target.value }))}
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        required
                      >
                        <option value="">Select Site...</option>
                        {sites.map(site => (
                          <option key={site.id} value={site.id}>{site.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Capacity</label>
                      <input
                        type="number"
                        min="0"
                        value={formData.capacity}
                        onChange={e => setFormData(prev => ({ ...prev, capacity: parseInt(e.target.value) || 0 }))}
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Notes</label>
                      <textarea
                        value={formData.notes}
                        onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                        rows={3}
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                  </div>
                </div>
                <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                  <button
                    type="submit"
                    className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-blue-600 text-base font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:ml-3 sm:w-auto sm:text-sm"
                  >
                    {editingId ? 'Update' : 'Create'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isOpen={deleteDialogOpen}
        onClose={handleCloseDeleteDialog}
        onConfirm={handleConfirmDelete}
        title="Departman Silme Onayı"
        entityName={deptToDelete?.name ?? ''}
        entityType="Departman"
        preview={dialogPreview}
        isLoading={isPreviewLoading}
        isDeleting={deleteDepartmentMutation.isPending}
      />
    </div>
  );
};

export default DepartmentsTab;
