/**
 * Departments Page
 *
 * Displays departments from the real backend API with create/edit modals.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Users, Plus, ChevronRight, X, Pencil } from 'lucide-react';
import { useDepartments, useCreateDepartment, useUpdateDepartment } from '../hooks';
import type { Department, CreateDepartmentInput, UpdateDepartmentInput } from '../types';

// ============================================================================
// Department Form Modal
// ============================================================================

interface DepartmentFormModalProps {
  department?: Department | null;
  onClose: () => void;
}

const DepartmentFormModal: React.FC<DepartmentFormModalProps> = ({ department, onClose }) => {
  const isEditing = !!department;
  const createMutation = useCreateDepartment();
  const updateMutation = useUpdateDepartment();

  const [name, setName] = useState(department?.name || '');
  const [code, setCode] = useState(department?.code || '');
  const [description, setDescription] = useState(department?.description || '');
  const [budgetCode, setBudgetCode] = useState(department?.budgetCode || '');
  const [costCenter, setCostCenter] = useState(department?.costCenter || '');
  const [error, setError] = useState<string | null>(null);

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !code.trim()) {
      setError('Name and code are required.');
      return;
    }

    try {
      if (isEditing && department) {
        const input: UpdateDepartmentInput = {
          id: department.id,
          name: name.trim(),
          code: code.trim(),
          description: description.trim() || undefined,
          budgetCode: budgetCode.trim() || undefined,
          costCenter: costCenter.trim() || undefined,
        };
        await updateMutation.mutateAsync(input);
      } else {
        const input: CreateDepartmentInput = {
          name: name.trim(),
          code: code.trim(),
          description: description.trim() || undefined,
          budgetCode: budgetCode.trim() || undefined,
          costCenter: costCenter.trim() || undefined,
        };
        await createMutation.mutateAsync(input);
      }
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred';
      setError(message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {isEditing ? 'Edit Department' : 'New Department'}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Operations"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Code <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. OPS"
              maxLength={20}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Brief description of the department"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Budget Code
              </label>
              <input
                type="text"
                value={budgetCode}
                onChange={(e) => setBudgetCode(e.target.value)}
                placeholder="e.g. BC-001"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Cost Center
              </label>
              <input
                type="text"
                value={costCenter}
                onChange={(e) => setCostCenter(e.target.value)}
                placeholder="e.g. CC-001"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {isPending ? 'Saving...' : isEditing ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// Department Type Badge
// ============================================================================

// ============================================================================
// Departments Page
// ============================================================================

const DepartmentsPage: React.FC = () => {
  const { data: departments, isLoading, error } = useDepartments();
  const [showModal, setShowModal] = useState(false);
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(null);

  const handleCreate = () => {
    setEditingDepartment(null);
    setShowModal(true);
  };

  const handleEdit = (department: Department) => {
    setEditingDepartment(department);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingDepartment(null);
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Departments</h1>
          <p className="mt-1 text-gray-500 dark:text-gray-400">
            {departments?.length ?? '-'} departments
          </p>
        </div>
        <button
          onClick={handleCreate}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />
          New Department
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          Failed to load departments: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-gray-100 bg-gray-100 dark:border-gray-700 dark:bg-gray-700"
            />
          ))}
        </div>
      )}

      {/* Departments Grid */}
      {!isLoading && departments && departments.length > 0 && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {departments.map((department) => {
            const color = '#6366f1';
            return (
              <div
                key={department.id}
                className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="h-2" style={{ backgroundColor: color }} />
                <div className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="rounded-lg p-3"
                        style={{ backgroundColor: `${color}20` }}
                      >
                        <Building2
                          className="h-6 w-6"
                          style={{ color }}
                        />
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900 dark:text-white">
                          {department.name}
                        </h3>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {department.code}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleEdit(department)}
                      className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                      title="Edit department"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  </div>

                  {department.description && (
                    <p className="mt-4 text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                      {department.description}
                    </p>
                  )}

                  {(department.budgetCode || department.costCenter) && (
                    <div className="mt-3 flex gap-3 text-xs text-gray-500">
                      {department.budgetCode && (
                        <span>Budget: {department.budgetCode}</span>
                      )}
                      {department.costCenter && (
                        <span>CC: {department.costCenter}</span>
                      )}
                    </div>
                  )}

                  <div className="mt-4 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-gray-500">
                      <Users className="h-4 w-4" />
                      <span className="text-sm">
                        {department.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <Link
                      to={`/hr/employees?departmentId=${department.id}`}
                      className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                    >
                      View Employees
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && (!departments || departments.length === 0) && !error && (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 text-center dark:border-gray-600 dark:bg-gray-800/50">
          <Building2 className="mb-3 h-10 w-10 text-gray-400" />
          <p className="text-gray-500">No departments found</p>
          <button
            onClick={handleCreate}
            className="mt-3 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            Create your first department
          </button>
        </div>
      )}

      {/* Organization Chart placeholder */}
      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          Organization Chart
        </h3>
        <div className="flex h-48 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 bg-gray-50 dark:border-gray-600 dark:bg-gray-800/50">
          <p className="text-gray-500">
            <Link
              to="/hr/organization"
              className="text-indigo-600 hover:underline dark:text-indigo-400"
            >
              View full organization chart
            </Link>
          </p>
        </div>
      </div>

      {/* CRUD Modal */}
      {showModal && (
        <DepartmentFormModal
          department={editingDepartment}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
};

export default DepartmentsPage;
