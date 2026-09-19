/**
 * Workers Tab Component
 * Manage farm workers with CRUD operations via GraphQL API
 */
import React, { useState } from 'react';
import {
  useWorkerList,
  useCreateWorker,
  useUpdateWorker,
  useDeleteWorker,
  Worker,
  CreateWorkerInput,
} from '../../../hooks/useWorkers';
import { FormField, Modal, useConfirm, useToast, DataTable, type DataTableColumn, Spinner } from '@aquaculture/shared-ui';

const statusColors: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  on_leave: 'bg-yellow-100 text-yellow-800',
  terminated: 'bg-red-100 text-red-800',
  suspended: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
};

const statusLabels: Record<string, string> = {
  active: 'Active',
  on_leave: 'On Leave',
  terminated: 'Terminated',
  suspended: 'Suspended',
};

interface WorkerFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  position: string;
  isVeterinarian: boolean;
  veterinaryLicenseNumber: string;
}

const initialFormData: WorkerFormData = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  position: '',
  isVeterinarian: false,
  veterinaryLicenseNumber: '',
};

export const WorkersTab: React.FC = () => {
  const { data: workers, isLoading, error, refetch } = useWorkerList();
  const createWorker = useCreateWorker();
  const updateWorker = useUpdateWorker();
  const deleteWorkerMutation = useDeleteWorker();

  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<WorkerFormData>(initialFormData);
  // FE-HIGH-086: required-field misses land on the field, not in a toast.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  const workerList = workers || [];

  const filtered = workerList.filter((item) => {
    const fullName = `${item.firstName} ${item.lastName}`.toLowerCase();
    const search = searchTerm.toLowerCase();
    return (
      fullName.includes(search) ||
      item.email.toLowerCase().includes(search) ||
      item.position.toLowerCase().includes(search)
    );
  });

  const openCreate = () => {
    setEditingId(null);
    setFormData(initialFormData);
    setFieldErrors({});
    setIsModalOpen(true);
  };

  const openEdit = (item: Worker) => {
    setEditingId(item.id);
    setFormData({
      firstName: item.firstName,
      lastName: item.lastName,
      email: item.email,
      phone: item.phone || '',
      position: item.position,
      isVeterinarian: item.isVeterinarian ?? false,
      veterinaryLicenseNumber: item.veterinaryLicenseNumber || '',
    });
    setIsModalOpen(true);
  };

  const confirm = useConfirm();
  const { toast } = useToast();
  const handleDelete = async (id: string) => {
    if (await confirm({ title: 'Delete this worker?', confirmText: 'Delete', cancelText: 'Cancel', variant: 'danger' })) {
      try {
        await deleteWorkerMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete worker:', err);
        toast({ title: 'Failed to delete worker. Please try again.', variant: 'error' });
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!formData.firstName) errors.firstName = 'Please enter a first name.';
    if (!formData.lastName) errors.lastName = 'Please enter a last name.';
    if (!formData.email) errors.email = 'Please enter an email address.';
    if (!formData.position) errors.position = 'Please enter a position.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsSaving(true);
    try {
      if (editingId) {
        await updateWorker.mutateAsync({
          id: editingId,
          firstName: formData.firstName,
          lastName: formData.lastName,
          email: formData.email,
          phone: formData.phone || undefined,
          position: formData.position,
          isVeterinarian: formData.isVeterinarian,
          veterinaryLicenseNumber: formData.veterinaryLicenseNumber || undefined,
        });
      } else {
        await createWorker.mutateAsync({
          firstName: formData.firstName,
          lastName: formData.lastName,
          email: formData.email,
          phone: formData.phone || undefined,
          position: formData.position,
          isVeterinarian: formData.isVeterinarian,
          veterinaryLicenseNumber: formData.veterinaryLicenseNumber || undefined,
        } as CreateWorkerInput);
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setFieldErrors({});
      setEditingId(null);
    } catch (err) {
      console.error('Failed to save worker:', err);
      toast({ title: 'Failed to save worker. Please try again.', variant: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  type ItemRow = (typeof filtered)[number];
  const itemRowColumns: DataTableColumn<ItemRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (_value, item) => (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {item.firstName} {item.lastName}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{item.employeeNumber}</div>
        </>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      render: (_value, item) => item.email,
    },
    {
      key: 'phone',
      header: 'Phone',
      render: (_value, item) => item.phone || '-',
    },
    {
      key: 'position',
      header: 'Position',
      render: (_value, item) => item.position,
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, item) => (
        <>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[item.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
          >
            {statusLabels[item.status] || item.status}
          </span>
        </>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, item) => (
        <>
          <button
            onClick={() => openEdit(item)}
            className="text-blue-600 hover:text-blue-900 mr-3"
          >
            Edit
          </button>
          <button
            onClick={() => handleDelete(item.id)}
            className="text-red-600 hover:text-red-900"
          >
            Delete
          </button>
        </>
      ),
    }
  ];

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search workers..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <svg
              className="absolute left-3 top-2.5 w-5 h-5 text-gray-400 dark:text-gray-500"
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
          onClick={openCreate}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 6v6m0 0v6m0-6h6m-6 0H6"
            />
          </svg>
          Add Worker
        </button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load workers. Please try again.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">
            Retry
          </button>
        </div>
      )}

      {/* Table */}
      {!isLoading && !error && (
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <DataTable<ItemRow>
            data={filtered}
            columns={itemRowColumns}
            keyExtractor={(item) => item.id}
            emptyMessage="No records found"
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />
          {filtered.length === 0 && (
            <div className="text-center py-12">
              <svg
                className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No workers found</h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Add workers to manage your farm team.</p>
            </div>
          )}
        </div>
      )}

      {/* Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Worker' : 'Add Worker'}
        size="md"
      >
        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">First Name *</label>
                <FormField error={formData.firstName ? undefined : fieldErrors.firstName} className="mb-0">
                <input
                  type="text"
                  required
                  value={formData.firstName}
                  onChange={(e) => setFormData((prev) => ({ ...prev, firstName: e.target.value }))}
                  className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
                </FormField>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Last Name *</label>
                <FormField error={formData.lastName ? undefined : fieldErrors.lastName} className="mb-0">
                <input
                  type="text"
                  required
                  value={formData.lastName}
                  onChange={(e) => setFormData((prev) => ({ ...prev, lastName: e.target.value }))}
                  className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
                </FormField>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email *</label>
              <FormField error={formData.email ? undefined : fieldErrors.email} className="mb-0">
              <input
                type="email"
                required
                value={formData.email}
                onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
                className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
              />
              </FormField>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Phone</label>
              <input
                type="text"
                value={formData.phone}
                onChange={(e) => setFormData((prev) => ({ ...prev, phone: e.target.value }))}
                className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Position *</label>
              <FormField error={formData.position ? undefined : fieldErrors.position} className="mb-0">
              <input
                type="text"
                required
                value={formData.position}
                onChange={(e) => setFormData((prev) => ({ ...prev, position: e.target.value }))}
                placeholder="e.g., Farm Technician, Feed Operator"
                className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
              />
              </FormField>
            </div>
            <div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.isVeterinarian}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, isVeterinarian: e.target.checked }))
                  }
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Veterinarian (can be attributed to treatments)
                </span>
              </label>
            </div>
            {formData.isVeterinarian && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Veterinary licence number
                </label>
                <input
                  type="text"
                  maxLength={50}
                  value={formData.veterinaryLicenseNumber}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      veterinaryLicenseNumber: e.target.value,
                    }))
                  }
                  placeholder="Professional licence / registration number"
                  className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            )}
          </div>
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:bg-gray-400"
            >
              {isSaving ? 'Saving...' : editingId ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default WorkersTab;
