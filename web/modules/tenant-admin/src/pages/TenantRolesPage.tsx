/**
 * TenantRolesPage
 *
 * Manages custom tenant roles with permissions.
 * Allows creating, editing, and deleting roles with granular permission control.
 */

import React, { useState, useCallback, useMemo, memo, useId } from 'react';
import {
  Shield,
  Plus,
  Trash2,
  RefreshCw,
  AlertCircle,
  X,
  Check,
  Star,
  Palette,
} from 'lucide-react';
import { useAuth } from '@aquaculture/shared-ui';
import { PermissionCheckboxGroup } from '../components/permissions';
import { RoleCard as SharedRoleCard } from '../components/roles/RoleCard';
import { useFocusTrap } from '../hooks';
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

// ============================================================================
// Constants
// ============================================================================

const ROLE_COLORS = [
  { value: '#6366F1', label: 'Indigo' },
  { value: '#8B5CF6', label: 'Purple' },
  { value: '#EC4899', label: 'Pink' },
  { value: '#EF4444', label: 'Red' },
  { value: '#F97316', label: 'Orange' },
  { value: '#EAB308', label: 'Yellow' },
  { value: '#22C55E', label: 'Green' },
  { value: '#14B8A6', label: 'Teal' },
  { value: '#0EA5E9', label: 'Sky' },
  { value: '#6B7280', label: 'Gray' },
];

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
      style={{ backgroundColor: role.color || '#6366F1' }}
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
    [onChange]
  );

  return (
    <div className="flex flex-wrap gap-2">
      {ROLE_COLORS.map((color) => (
        <button
          key={color.value}
          type="button"
          onClick={() => handleColorClick(color.value)}
          className={`
            w-8 h-8 rounded-lg border-2 transition-all
            ${value === color.value ? 'border-gray-900 scale-110' : 'border-transparent hover:scale-105'}
          `}
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

const RoleModal = memo<RoleModalProps>(({
  isOpen,
  onClose,
  role,
  categories,
  onSave,
  isLoading,
}) => {
  const isEditing = !!role;

  // Generate unique IDs for ARIA attributes
  const titleId = useId();
  const descriptionId = useId();

  // Focus trap for accessibility
  const { containerRef, handleKeyDown } = useFocusTrap({
    isOpen,
    onClose,
    closeOnEscape: true,
    autoFocus: true,
    restoreFocus: true,
  });

  // Memoize initial form data to avoid recreating on each render
  const initialFormData = useMemo<RoleFormData>(() => ({
    name: role?.name || '',
    description: role?.description || '',
    color: role?.color || '#6366F1',
    icon: role?.icon || 'shield',
    level: role?.level || 50,
    isDefault: role?.isDefault || false,
    panelPermissions: role?.permissions?.panelPermissions || {},
  }), [role]);

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

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  }, [formData, onSave]);

  // Memoize validation state
  const isSubmitDisabled = useMemo(() => {
    return isLoading || role?.isSystem || !formData.name.trim();
  }, [isLoading, role?.isSystem, formData.name]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={containerRef}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-tenant-50 to-white">
          <div>
            <h2 id={titleId} className="text-xl font-bold text-gray-900">
              {isEditing ? 'Edit Role' : 'Create New Role'}
            </h2>
            <p id={descriptionId} className="text-sm text-gray-500 mt-0.5">
              {isEditing
                ? `Editing "${role.name}" role`
                : 'Define a new role with custom permissions'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="p-6 space-y-6">
            {/* Basic Info */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Role Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={handleNameChange}
                  placeholder="e.g., Supervisor, Technician"
                  required
                  disabled={role?.isSystem}
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:outline-hidden focus:ring-2 focus:ring-tenant-500 disabled:bg-gray-100"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Priority Level
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={formData.level}
                  onChange={handleLevelChange}
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Higher = more authority (1-100)
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Description
              </label>
              <textarea
                value={formData.description}
                onChange={handleDescriptionChange}
                placeholder="Describe what this role is for..."
                rows={2}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:outline-hidden focus:ring-2 focus:ring-tenant-500 resize-none"
              />
            </div>

            {/* Color Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                <Palette className="w-4 h-4 inline mr-1" />
                Role Color
              </label>
              <ColorPicker
                value={formData.color}
                onChange={handleColorChange}
              />
            </div>

            {/* Default Role Toggle */}
            <div className="flex items-center gap-3 p-4 bg-yellow-50 rounded-xl border border-yellow-100">
              <input
                type="checkbox"
                id="isDefault"
                checked={formData.isDefault}
                onChange={handleIsDefaultChange}
                className="rounded border-gray-300 text-tenant-600 focus:ring-tenant-500"
              />
              <label htmlFor="isDefault" className="flex-1">
                <span className="text-sm font-medium text-gray-900">
                  Set as default role
                </span>
                <p className="text-xs text-gray-500">
                  New users will be assigned this role by default
                </p>
              </label>
              <Star className="w-5 h-5 text-yellow-500" />
            </div>

            {/* Permissions */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
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
                <div className="p-8 text-center bg-gray-50 rounded-xl">
                  <RefreshCw className="w-6 h-6 animate-spin text-gray-500 mx-auto" />
                  <p className="mt-2 text-sm text-gray-500">
                    Loading permission categories...
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
            {role?.isSystem && (
              <p className="text-xs text-amber-600">
                System roles cannot be modified
              </p>
            )}
            <div className="flex items-center gap-3 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitDisabled}
                className="px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
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
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
});
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
}

const DeleteModal = memo<DeleteModalProps>(({
  isOpen,
  onClose,
  role,
  onConfirm,
  isLoading,
}) => {
  // Generate unique IDs for ARIA attributes
  const titleId = useId();
  const descriptionId = useId();

  // Focus trap for accessibility
  const { containerRef, handleKeyDown } = useFocusTrap({
    isOpen: isOpen && !!role,
    onClose,
    closeOnEscape: true,
    autoFocus: true,
    restoreFocus: true,
  });

  if (!isOpen || !role) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={containerRef}
        onKeyDown={handleKeyDown}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6"
      >
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-full bg-red-100" aria-hidden="true">
            <Trash2 className="w-6 h-6 text-red-600" />
          </div>
          <div>
            <h3 id={titleId} className="text-lg font-bold text-gray-900">Delete Role</h3>
            <p id={descriptionId} className="text-sm text-gray-500">
              Are you sure you want to delete "{role.name}"?
            </p>
          </div>
        </div>

        {(role.userCount ?? 0) > 0 && (
          <div className="mt-4 p-3 bg-amber-50 rounded-lg border border-amber-100">
            <p className="text-sm text-amber-700">
              <AlertCircle className="w-4 h-4 inline mr-1" />
              This role is assigned to {role.userCount ?? 0} user(s). They will lose
              access to associated permissions.
            </p>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
          >
            {isLoading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Deleting...
              </>
            ) : (
              'Delete Role'
            )}
          </button>
        </div>
      </div>
    </div>
  );
});
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

  const handleSave = useCallback(async (data: CreateTenantRoleInput | UpdateTenantRoleInput) => {
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
  }, [editingRole, updateMutation, createMutation]);

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

  const handleDeleteRole = useCallback((role: TenantRole) => {
    setDeletingRole(role);
  }, []);

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
        <RefreshCw className="w-8 h-8 animate-spin text-tenant-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Roles & Permissions</h1>
          <p className="text-sm text-gray-500 mt-1">
            Define custom roles with granular permission control
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRefresh}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-5 h-5 text-gray-500" />
          </button>
          {/* RBAC-HIGH-004: seed + create require the roles:create capability. */}
          {canCreateRoles && (
            <>
              {roles.length === 0 && (
                <button
                  onClick={handleSeedRoles}
                  disabled={seedMutation.isPending}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {seedMutation.isPending ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Shield className="w-4 h-4" />
                  )}
                  Seed Default Roles
                </button>
              )}
              <button
                onClick={handleOpenCreate}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Create Role
              </button>
            </>
          )}
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">
              Failed to load roles
            </p>
            <p className="text-sm text-red-600">{(error as Error).message}</p>
          </div>
          <button
            onClick={() => refetch()}
            className="ml-auto px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Roles Grid — PERF-009: use shared RoleCard component, no inline duplicate */}
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
      ) : (
        // Empty State
        <div className="bg-white rounded-xl border border-gray-100 py-16 text-center">
          <Shield className="w-16 h-16 text-gray-200 mx-auto" />
          <h3 className="mt-4 text-lg font-semibold text-gray-900">
            No roles defined
          </h3>
          <p className="mt-2 text-sm text-gray-500 max-w-md mx-auto">
            Create custom roles to manage user permissions. You can also seed
            default roles to get started quickly.
          </p>
          {/* RBAC-HIGH-004: seed + create require the roles:create capability. */}
          {canCreateRoles && (
            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                onClick={handleSeedRoles}
                disabled={seedMutation.isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                {seedMutation.isPending ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Shield className="w-4 h-4" />
                )}
                Seed Default Roles
              </button>
              <button
                onClick={handleOpenCreate}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Create Role
              </button>
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
      />
    </div>
  );
};

export default TenantRolesPage;
