/**
 * Departments Page
 *
 * Displays departments from the real backend API with create/edit modals.
 * A department belongs to a module (or to none: company-wide). In a module
 * workspace the list is that module's and a new department is born in it; the
 * Company workspace sees every department and is the only place a department's
 * module is chosen or changed.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Users, Plus, ChevronRight, Pencil } from 'lucide-react';
import {
  Modal,
  colors,
  PageHeader,
  Button,
  Input,
  Select,
  Textarea,
  useI18n,
} from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import {
  useDepartments,
  useCreateDepartment,
  useIsWorkforceManager,
  useUpdateDepartment,
} from '../hooks';
import { useModuleScope } from '../hooks/useModuleScope';
import { ScopedDescription } from '../components/common';
import { MODULE_CODES, moduleLabel } from '../utils/moduleLabels';
import type { Department, CreateDepartmentInput, UpdateDepartmentInput } from '../types';

/** The module select's "no module" option; '' is never sent as a module. */
const COMPANY_WIDE = '';

/** Narrows a select value to a module code; the company-wide option is no module. */
function moduleOfSelection(value: string): HrModuleCode | null {
  return MODULE_CODES.find((code) => code === value) ?? null;
}

// ============================================================================
// Department Form Modal
// ============================================================================

interface DepartmentFormModalProps {
  department?: Department | null;
  onClose: () => void;
}

const DepartmentFormModal: React.FC<DepartmentFormModalProps> = ({ department, onClose }) => {
  const { t } = useI18n();
  const isEditing = !!department;
  const createMutation = useCreateDepartment();
  const updateMutation = useUpdateDepartment();
  // WHY: a module workspace fixes the module (no selector); only Company chooses one.
  const workspaceModule = useModuleScope();

  const [name, setName] = useState(department?.name || '');
  const [code, setCode] = useState(department?.code || '');
  const [description, setDescription] = useState(department?.description || '');
  const [budgetCode, setBudgetCode] = useState(department?.budgetCode || '');
  const [costCenter, setCostCenter] = useState(department?.costCenter || '');
  const [moduleSelection, setModuleSelection] = useState<string>(
    department?.moduleCode ?? COMPANY_WIDE,
  );
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
          // Company may move the department to a module or back to company-wide (null);
          // a module workspace leaves the module as it is.
          ...(workspaceModule === undefined && { moduleCode: moduleOfSelection(moduleSelection) }),
        };
        await updateMutation.mutateAsync(input);
      } else {
        const input: CreateDepartmentInput = {
          name: name.trim(),
          code: code.trim(),
          description: description.trim() || undefined,
          budgetCode: budgetCode.trim() || undefined,
          costCenter: costCenter.trim() || undefined,
          moduleCode: workspaceModule ?? moduleOfSelection(moduleSelection) ?? undefined,
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
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      title={isEditing ? 'Edit Department' : 'New Department'}
      showCloseButton={!isPending}
      closeOnEscape={!isPending}
      closeOnOverlayClick={!isPending}
      bodyClassName="p-6"
    >
      {error && (
        <div className="mb-4 rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-700 dark:border-error-800 dark:bg-error-900/20 dark:text-error-400">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Name <span className="text-error-500">*</span>
          </label>
          <Input
            fullWidth
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Operations"
            required
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Code <span className="text-error-500">*</span>
          </label>
          <Input
            fullWidth
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. OPS"
            maxLength={20}
            required
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            Description
          </label>
          <Textarea
            fullWidth
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Brief description of the department"
          />
        </div>

        {workspaceModule === undefined && (
          <div>
            <Select
              fullWidth
              id="department-module"
              label={t('hr.departments.moduleLabel')}
              value={moduleSelection}
              onChange={(e) => setModuleSelection(e.target.value)}
              options={[
                { value: COMPANY_WIDE, label: t('hr.module.companyWide') },
                ...MODULE_CODES.map((code) => ({ value: code, label: moduleLabel(code, t) })),
              ]}
            />
            {isEditing && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('hr.departments.moduleMoveHint')}
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Budget Code
            </label>
            <Input
              fullWidth
              type="text"
              value={budgetCode}
              onChange={(e) => setBudgetCode(e.target.value)}
              placeholder="e.g. BC-001"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Cost Center
            </label>
            <Input
              fullWidth
              type="text"
              value={costCenter}
              onChange={(e) => setCostCenter(e.target.value)}
              placeholder="e.g. CC-001"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={isPending}>
            {isPending ? 'Saving...' : isEditing ? 'Update' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================================
// Department Type Badge
// ============================================================================

// ============================================================================
// Departments Page
// ============================================================================

const DepartmentsPage: React.FC = () => {
  const { t } = useI18n();
  const { data: departments, isLoading, error } = useDepartments();
  // The service rejects department writes from everyone else, so they are not offered.
  const canManage = useIsWorkforceManager();
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
      <PageHeader
        title="Departments"
        description={<ScopedDescription text={`${departments?.length ?? '-'} departments`} />}
        actions={
          canManage ? (
            <Button
              variant="primary"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={handleCreate}
            >
              New Department
            </Button>
          ) : undefined
        }
      />

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-error-200 bg-error-50 p-4 text-sm text-error-700 dark:border-error-800 dark:bg-error-900/20 dark:text-error-400">
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
            const color = colors.primary[500];
            return (
              <div
                key={department.id}
                className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-(--shadow-sd-sm) transition-shadow hover:shadow-(--shadow-sd-md) dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="h-2" style={{ backgroundColor: color }} />
                <div className="p-6">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg p-3" style={{ backgroundColor: `${color}20` }}>
                        <Building2 className="h-6 w-6" style={{ color }} />
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900 dark:text-white">
                          {department.name}
                        </h3>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {department.code} · {moduleLabel(department.moduleCode, t)}
                        </p>
                      </div>
                    </div>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label="Edit department"
                        onClick={() => handleEdit(department)}
                        title="Edit department"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </div>

                  {department.description && (
                    <p className="mt-4 text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                      {department.description}
                    </p>
                  )}

                  {(department.budgetCode || department.costCenter) && (
                    <div className="mt-3 flex gap-3 text-xs text-gray-500 dark:text-gray-400">
                      {department.budgetCode && <span>Budget: {department.budgetCode}</span>}
                      {department.costCenter && <span>CC: {department.costCenter}</span>}
                    </div>
                  )}

                  <div className="mt-4 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                      <Users className="h-4 w-4" />
                      <span className="text-sm">{department.isActive ? 'Active' : 'Inactive'}</span>
                    </div>
                    <Link
                      to={`/hr/employees?departmentId=${department.id}`}
                      className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400"
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
          <Building2 className="mb-3 h-10 w-10 text-gray-400 dark:text-gray-500" />
          <p className="text-gray-500 dark:text-gray-400">No departments found</p>
          {canManage && (
            <Button variant="ghost" className="mt-3" onClick={handleCreate}>
              Create your first department
            </Button>
          )}
        </div>
      )}

      {/* Organization Chart placeholder */}
      <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-(--shadow-sd-sm) dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          Organization Chart
        </h3>
        <div className="flex h-48 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 bg-gray-50 dark:border-gray-600 dark:bg-gray-800/50">
          <p className="text-gray-500 dark:text-gray-400">
            <Link
              to="/hr/organization"
              className="text-primary-600 hover:underline dark:text-primary-400"
            >
              View full organization chart
            </Link>
          </p>
        </div>
      </div>

      {/* CRUD Modal */}
      {showModal && (
        <DepartmentFormModal department={editingDepartment} onClose={handleCloseModal} />
      )}
    </div>
  );
};

export default DepartmentsPage;
