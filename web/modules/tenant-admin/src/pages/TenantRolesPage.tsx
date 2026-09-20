/**
 * TenantRolesPage
 *
 * Manages custom tenant roles with permissions.
 * Allows creating, editing, and deleting roles with granular permission control.
 */

import React, { useState, useCallback, useMemo, memo } from 'react';
import { Button, Input, Modal, PageHeader, Textarea, ToggleButton } from '@aquaculture/shared-ui';
import { Shield, Plus, Trash2, RefreshCw, AlertCircle, Check, Star, Palette } from 'lucide-react';
import { useAuth } from '@aquaculture/shared-ui';
import { PermissionCheckboxGroup } from '../components/permissions';
import { RoleCard as SharedRoleCard } from '../components/roles/RoleCard';
import {
  useTenantRoles,
  usePermissionCategories,
  useCreateTenantRole,
  useUpdateTenantRole,
  useDeleteTenantRole,
  useSeedTenantRoles,
  type TenantRole,
  type CreateTenantRoleInput,
  type UpdateTenantRoleInput,
  type PanelPermissions,
} from '../hooks/useTenantRoles';
import { logError } from '../utils/error-handling';
import { DEFAULT_ROLE_COLOR, ROLE_COLORS } from '../lib/constants';

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Role badge component
 */
const RoleBadge = memo<{ role: TenantRole }>(({ role }) => {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-white"
      style={{ backgroundColor: role.color || DEFAULT_ROLE_COLOR }}
    >
      <Shield className="w-3 h-3" />
      {role.name}
    </span>
  );
});
RoleBadge.displayName = 'RoleBadge';

/**
 * Color picker component
 */
interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

const ColorPicker = memo<ColorPickerProps>(({ value, onChange }) => {
  const handleColorClick = useCallback(
    (colorValue: string) => {
      onChange(colorValue);
    },
    [onChange],
  );

  return (
    <div className="flex flex-wrap gap-2">
      {ROLE_COLORS.map((color) => (
        <ToggleButton
          key={color.value}
          type="button"
          onClick={() => handleColorClick(color.value)}
          pressed={value === color.value}
          className="w-8 h-8 rounded-lg border-2 transition-all"
          pressedClassName="border-gray-900 scale-110"
          idleClassName="border-transparent hover:scale-105"
          style={{ backgroundColor: color.value }}
          title={color.label}
        />
      ))}
    </div>
  );
});
ColorPicker.displayName = 'ColorPicker';

/**
 * Role modal for create/edit
 */
interface RoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  role?: TenantRole | null;
  categories: Array<{
    categoryKey: string;
    name: string;
    resources: Array<{ name: string; actions: string[] }>;
  }>;
  onSave: (data: CreateTenantRoleInput | UpdateTenantRoleInput) => void;
  isLoading?: boolean;
}

interface RoleFormData {
  name: string;
  description: string;
  color: string;
  icon: string;
  level: number;
  isDefault: boolean;
  panelPermissions: PanelPermissions;
}

const RoleModal = memo<RoleModalProps>(
  ({ isOpen, onClose, role, categories, onSave, isLoading }) => {
    const isEditing = !!role;

    // Memoize initial form data to avoid recreating on each render
    const initialFormData = useMemo<RoleFormData>(
      () => ({
        name: role?.name || '',
        description: role?.description || '',
        color: role?.color || DEFAULT_ROLE_COLOR,
        icon: role?.icon || 'shield',
        level: role?.level || 50,
        isDefault: role?.isDefault || false,
        panelPermissions: role?.permissions?.panelPermissions || {},
      }),
      [role],
    );

    const [formData, setFormData] = useState<RoleFormData>(initialFormData);

    // Reset form when role changes
    React.useEffect(() => {
      if (isOpen) {
        setFormData(initialFormData);
      }
    }, [isOpen, initialFormData]);

    // Memoized field handlers
    const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setFormData((prev) => ({ ...prev, name: e.target.value }));
    }, []);

    const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setFormData((prev) => ({ ...prev, description: e.target.value }));
    }, []);

    const handleLevelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setFormData((prev) => ({ ...prev, level: parseInt(e.target.value) || 50 }));
    }, []);

    const handleColorChange = useCallback((color: string) => {
      setFormData((prev) => ({ ...prev, color }));
    }, []);

    const handleIsDefaultChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setFormData((prev) => ({ ...prev, isDefault: e.target.checked }));
    }, []);

    const handlePermissionsChange = useCallback((panelPermissions: PanelPermissions) => {
      setFormData((prev) => ({ ...prev, panelPermissions }));
    }, []);

    const handleSubmit = useCallback(
      (e: React.FormEvent) => {
        e.preventDefault();
        onSave(formData);
      },
      [formData, onSave],
    );

    // Memoize validation state
    const isSubmitDisabled = useMemo(() => {
      return isLoading || role?.isSystem || !formData.name.trim();
    }, [isLoading, role?.isSystem, formData.name]);

    if (!isOpen) return null;

    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="xl"
        className="max-h-[90vh] overflow-hidden flex flex-col"
        bodyClassName="flex-1 min-h-0 flex flex-col"
        title={isEditing ? 'Edit Role' : 'Create New Role'}
        description={
          isEditing ? `Editing "${role.name}" role` : 'Define a new role with custom permissions'
        }
      >
        {/* Content */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="p-6 space-y-6">
            {/* Basic Info */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Input
                label="Role Name"
                fullWidth
                type="text"
                value={formData.name}
                onChange={handleNameChange}
                placeholder="e.g., Supervisor, Technician"
                required
                disabled={role?.isSystem}
              />

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Priority Level
                </label>
                <Input
                  fullWidth
                  type="number"
                  min="1"
                  max="100"
                  value={formData.level}
                  onChange={handleLevelChange}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Higher = more authority (1-100)
                </p>
              </div>
            </div>

            <Textarea
              label="Description"
              className="resize-none"
              fullWidth
              value={formData.description}
              onChange={handleDescriptionChange}
              placeholder="Describe what this role is for..."
              rows={2}
            />

            {/* Color Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                <Palette className="w-4 h-4 inline mr-1" />
                Role Color
              </label>
              <ColorPicker value={formData.color} onChange={handleColorChange} />
            </div>

            {/* Default Role Toggle */}
            <div className="flex items-center gap-3 p-4 bg-warning-50 dark:bg-warning-900/20 rounded-xl border border-warning-100 dark:border-warning-800">
              <input
                type="checkbox"
                id="isDefault"
                checked={formData.isDefault}
                onChange={handleIsDefaultChange}
                className="rounded border-gray-300 dark:border-gray-600 text-success-600 focus:ring-success-500"
              />
              <label htmlFor="isDefault" className="flex-1">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Set as default role
                </span>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  New users will be assigned this role by default
                </p>
              </label>
              <Star className="w-5 h-5 text-warning-500" />
            </div>

            {/* Permissions */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                Permissions
              </label>
              {categories.length > 0 ? (
                <PermissionCheckboxGroup
                  categories={categories}
                  value={formData.panelPermissions}
                  onChange={handlePermissionsChange}
                  disabled={role?.isSystem}
                  readOnly={role?.isSystem}
                />
              ) : (
                <div className="p-8 text-center bg-gray-50 dark:bg-gray-800 rounded-xl">
                  <RefreshCw className="w-6 h-6 animate-spin text-gray-500 dark:text-gray-400 mx-auto" />
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    Loading permission categories...
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex items-center justify-between">
            {role?.isSystem && (
              <p className="text-xs text-warning-600 dark:text-warning-400">
                System roles cannot be modified
              </p>
            )}
            <div className="flex items-center gap-3 ml-auto">
              <Button variant="secondary" type="button" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={isSubmitDisabled}>
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    {isEditing ? 'Update Role' : 'Create Role'}
                  </>
                )}
              </Button>
            </div>
          </div>
        </form>
      </Modal>
    );
  },
);
RoleModal.displayName = 'RoleModal';

/**
 * Delete confirmation modal
 */
interface DeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  role: TenantRole | null;
  onConfirm: () => void;
  isLoading?: boolean;
  /** Server rejection surfaced in the dialog (RBAC-M8: no silent failures). */
  errorMessage?: string;
}

const DeleteModal = memo<DeleteModalProps>(
  ({ isOpen, onClose, role, onConfirm, isLoading, errorMessage }) => {
    if (!isOpen || !role) return null;

    // RBAC-M8: the backend HARD-BLOCKS deleting a role while users still hold it
    // (tenant-role.service delete guard). The UI must state that same rule and
    // block confirm — not offer a "they will lose access" delete that the server
    // will reject with a raw ForbiddenException.
    const hasActiveHolders = (role.userCount ?? 0) > 0;

    return (
      <Modal
        isOpen={isOpen && !!role}
        onClose={onClose}
        size="sm"
        title={
          <span className="flex items-center gap-3">
            <span className="p-2 rounded-full bg-error-100 dark:bg-error-900/40" aria-hidden="true">
              <Trash2 className="w-5 h-5 text-error-600 dark:text-error-400" />
            </span>
            Delete Role
          </span>
        }
        description={`Are you sure you want to delete "${role.name}"?`}
      >
        {hasActiveHolders && (
          <div className="mt-4 p-3 bg-warning-50 dark:bg-warning-900/20 rounded-lg border border-warning-100 dark:border-warning-800">
            <p className="text-sm text-warning-700 dark:text-warning-300">
              <AlertCircle className="w-4 h-4 inline mr-1" />
              This role cannot be deleted while it is assigned to {role.userCount ?? 0} user(s).
              Reassign those users to another role first.
            </p>
          </div>
        )}

        {errorMessage && (
          <div className="mt-4 p-3 bg-error-50 dark:bg-error-900/20 rounded-lg border border-error-100 dark:border-error-800">
            <p className="text-sm text-error-700 dark:text-error-300">
              <AlertCircle className="w-4 h-4 inline mr-1" />
              {errorMessage}
            </p>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={isLoading || hasActiveHolders}>
            {isLoading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Deleting...
              </>
            ) : (
              'Delete Role'
            )}
          </Button>
        </div>
      </Modal>
    );
  },
);
DeleteModal.displayName = 'DeleteModal';

// PERF-009: Use shared RoleCard from components/roles instead of inline duplicate
const RoleCard = SharedRoleCard;

// ============================================================================
// Main Component
// ============================================================================

const TenantRolesPage: React.FC = () => {
  // RBAC-HIGH-004 (FE-HIGH-001): gate each control on the SAME granular capability
  // the backend enforces (@RequireTenantPermission), not the coarse TENANT_ADMIN
  // role. Admins bypass inside hasResourcePermission, so this is strictly a
  // superset — but it also lets a delegate holding roles:create/edit/delete use
  // the controls, which the previous role check silently blocked (the delegation
  // feature was inert on this screen).
  const { hasPermission } = useAuth();
  const canCreateRoles = hasPermission('roles:create');
  const canEditRoles = hasPermission('roles:edit');
  const canDeleteRoles = hasPermission('roles:delete');

  // State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<TenantRole | null>(null);
  const [deletingRole, setDeletingRole] = useState<TenantRole | null>(null);

  // Queries
  const { data: roles = [], isLoading, error, refetch } = useTenantRoles();
  const { data: categories = [] } = usePermissionCategories();

  // Mutations
  const createMutation = useCreateTenantRole();
  const updateMutation = useUpdateTenantRole();
  const deleteMutation = useDeleteTenantRole();
  const seedMutation = useSeedTenantRoles();

  // Memoized handlers
  const handleOpenCreate = useCallback(() => {
    setEditingRole(null);
    setIsModalOpen(true);
  }, []);

  const handleOpenEdit = useCallback((role: TenantRole) => {
    setEditingRole(role);
    setIsModalOpen(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setIsModalOpen(false);
    setEditingRole(null);
  }, []);

  const handleSave = useCallback(
    async (data: CreateTenantRoleInput | UpdateTenantRoleInput) => {
      try {
        if (editingRole) {
          await updateMutation.mutateAsync({
            roleId: editingRole.id,
            input: data,
          });
        } else {
          await createMutation.mutateAsync(data as CreateTenantRoleInput);
        }
        setIsModalOpen(false);
        setEditingRole(null);
      } catch (err) {
        logError('TenantRolesPage.handleSave', err);
      }
    },
    [editingRole, updateMutation, createMutation],
  );

  const handleDelete = useCallback(async () => {
    if (!deletingRole) return;

    try {
      await deleteMutation.mutateAsync(deletingRole.id);
      setDeletingRole(null);
    } catch (err) {
      logError('TenantRolesPage.handleDelete', err);
    }
  }, [deletingRole, deleteMutation]);

  const handleSeedRoles = useCallback(async () => {
    try {
      await seedMutation.mutateAsync();
    } catch (err) {
      logError('TenantRolesPage.handleSeedRoles', err);
    }
  }, [seedMutation]);

  const handleDeleteRole = useCallback(
    (role: TenantRole) => {
      // Reset any error from a previous delete attempt so a fresh dialog
      // never opens pre-populated with a stale server rejection (RBAC-M8).
      deleteMutation.reset();
      setDeletingRole(role);
    },
    [deleteMutation],
  );

  const handleCloseDeleteModal = useCallback(() => {
    setDeletingRole(null);
  }, []);

  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  // Memoize loading state for mutations
  const isSaving = useMemo(() => {
    return createMutation.isPending || updateMutation.isPending;
  }, [createMutation.isPending, updateMutation.isPending]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-success-600 dark:text-success-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Roles & Permissions"
        description="Define custom roles with granular permission control"
        actions={
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh"
              onClick={handleRefresh}
              title="Refresh"
            >
              <RefreshCw className="w-5 h-5 text-gray-500 dark:text-gray-400" />
            </Button>
            {/* RBAC-HIGH-004: seed + create require the roles:create capability.
                RBAC-M14: the seed offer only renders on a CONFIRMED empty list —
                on a query error `roles` is just the [] default, and offering a
                seed there invites a duplicate seed against unknown server state. */}
            {canCreateRoles && (
              <>
                {!error && roles.length === 0 && (
                  <Button
                    variant="secondary"
                    onClick={handleSeedRoles}
                    disabled={seedMutation.isPending}
                  >
                    {seedMutation.isPending ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Shield className="w-4 h-4" />
                    )}
                    Seed Default Roles
                  </Button>
                )}
                <Button
                  variant="primary"
                  leftIcon={<Plus className="w-4 h-4" />}
                  onClick={handleOpenCreate}
                >
                  Create Role
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* Error Message */}
      {error && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-error-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-error-800 dark:text-error-200">
              Failed to load roles
            </p>
            <p className="text-sm text-error-600 dark:text-error-400">{(error as Error).message}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Roles Grid — PERF-009: use shared RoleCard component, no inline duplicate.
          RBAC-M14: on a query error the empty state must NOT render — `roles`
          is only the [] default, not a confirmed empty list; the error banner
          above (with Retry) is the whole content. */}
      {roles.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {roles.map((role) => (
            <RoleCard
              key={role.id}
              role={role}
              onEdit={canEditRoles ? handleOpenEdit : undefined}
              onDelete={canDeleteRoles ? handleDeleteRole : undefined}
            />
          ))}
        </div>
      ) : error ? null : (
        // Empty State (confirmed empty — the query succeeded with zero roles)
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 py-16 text-center">
          <Shield className="w-16 h-16 text-gray-200 mx-auto" />
          <h3 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
            No roles defined
          </h3>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
            Create custom roles to manage user permissions. You can also seed default roles to get
            started quickly.
          </p>
          {/* RBAC-HIGH-004: seed + create require the roles:create capability. */}
          {canCreateRoles && (
            <div className="mt-6 flex items-center justify-center gap-3">
              <Button
                variant="secondary"
                onClick={handleSeedRoles}
                disabled={seedMutation.isPending}
              >
                {seedMutation.isPending ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Shield className="w-4 h-4" />
                )}
                Seed Default Roles
              </Button>
              <Button
                variant="primary"
                leftIcon={<Plus className="w-4 h-4" />}
                onClick={handleOpenCreate}
              >
                Create Role
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Role Modal */}
      <RoleModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        role={editingRole}
        categories={categories}
        onSave={handleSave}
        isLoading={isSaving}
      />

      {/* Delete Confirmation Modal */}
      <DeleteModal
        isOpen={!!deletingRole}
        onClose={handleCloseDeleteModal}
        role={deletingRole}
        onConfirm={handleDelete}
        isLoading={deleteMutation.isPending}
        errorMessage={deleteMutation.error?.message}
      />
    </div>
  );
};

export default TenantRolesPage;
