/**
 * TenantRolesPage
 *
 * Manages custom tenant roles with permissions.
 * Allows creating, editing, and deleting roles with granular permission control.
 *
 * SUDERRA restyle — sd-page/sd-modal primitives; every capability gate,
 * mutation, focus trap, and aria attribute is unchanged.
 *
 * DATA SOURCES (all real backend — no mocked data on this page):
 * - useTenantRoles / usePermissionCategories → auth-service tenant roles +
 *   permission catalogue (role.color/icon/level/userCount are stored values).
 * - Mutations: create / update / delete / seed-defaults — real endpoints;
 *   delete is hard-blocked server-side while users hold the role (RBAC-M8).
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
import { ROLE_COLORS } from '../lib/constants';

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
      className="sd-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Modal */}
      <div
        ref={containerRef}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="sd-modal"
        style={{ maxWidth: '56rem', width: '100%' }}
      >
        {/* Header */}
        <div className="sd-modal-head">
          <div>
            <h2 id={titleId} className="sd-modal-title">
              {isEditing ? 'Edit Role' : 'Create New Role'}
            </h2>
            <p id={descriptionId} className="sd-modal-sub">
              {isEditing
                ? `Editing "${role.name}" role`
                : 'Define a new role with custom permissions'}
            </p>
          </div>
          <button onClick={onClose} className="sd-iconbtn" aria-label="Close modal">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <div className="sd-modal-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Basic Info */}
              <div className="sd-fieldgrid">
                <label className="sd-field">
                  <span>Role Name *</span>
                  <input
                    type="text"
                    className="sd-input"
                    value={formData.name}
                    onChange={handleNameChange}
                    placeholder="e.g., Supervisor, Technician"
                    required
                    disabled={role?.isSystem}
                  />
                </label>

                <label className="sd-field">
                  <span>Priority Level</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    className="sd-input"
                    value={formData.level}
                    onChange={handleLevelChange}
                  />
                  <small style={{ fontSize: 11.5, color: '#8aa0aa' }}>
                    Higher = more authority (1-100)
                  </small>
                </label>
              </div>

              <label className="sd-field">
                <span>Description</span>
                <textarea
                  className="sd-input"
                  value={formData.description}
                  onChange={handleDescriptionChange}
                  placeholder="Describe what this role is for…"
                  rows={2}
                  style={{ resize: 'none' }}
                />
              </label>

              {/* Color Selection */}
              <div>
                <span className="sd-field" style={{ display: 'block', marginBottom: 8 }}>
                  <span>
                    <Palette size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 5 }} />
                    Role Color
                  </span>
                </span>
                <ColorPicker
                  value={formData.color}
                  onChange={handleColorChange}
                />
              </div>

              {/* Default Role Toggle */}
              <div className="sd-checkrow">
                <input
                  type="checkbox"
                  id="isDefault"
                  checked={formData.isDefault}
                  onChange={handleIsDefaultChange}
                />
                <label htmlFor="isDefault" style={{ flex: 1, cursor: 'pointer' }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: '#0a1f2b' }}>
                    Set as default role
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: '#5c7783' }}>
                    New users will be assigned this role by default
                  </span>
                </label>
                <Star size={16} style={{ color: '#92610a' }} aria-hidden="true" />
              </div>

              {/* Permissions */}
              <div>
                <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#5c7783', marginBottom: 10 }}>
                  Permissions
                </span>
                {categories.length > 0 ? (
                  <PermissionCheckboxGroup
                    categories={categories}
                    value={formData.panelPermissions}
                    onChange={handlePermissionsChange}
                    disabled={role?.isSystem}
                    readOnly={role?.isSystem}
                  />
                ) : (
                  <div className="sd-empty">
                    <RefreshCw className="animate-spin" size={18} style={{ color: '#8aa0aa', display: 'block', margin: '0 auto 8px' }} aria-hidden="true" />
                    Loading permission categories…
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="sd-modal-foot">
            {role?.isSystem && (
              <p style={{ margin: 0, marginRight: 'auto', fontSize: 12, color: '#92610a' }}>
                System roles cannot be modified
              </p>
            )}
            <button type="button" onClick={onClose} className="sd-btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitDisabled}
              className="sd-btn-teal"
            >
              {isLoading ? (
                <>
                  <RefreshCw size={15} className="animate-spin" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                <>
                  <Check size={15} />
                  {isEditing ? 'Update Role' : 'Create Role'}
                </>
              )}
            </button>
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
  /** Server rejection surfaced in the dialog (RBAC-M8: no silent failures). */
  errorMessage?: string;
}

const DeleteModal = memo<DeleteModalProps>(({
  isOpen,
  onClose,
  role,
  onConfirm,
  isLoading,
  errorMessage,
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

  // RBAC-M8: the backend HARD-BLOCKS deleting a role while users still hold it
  // (tenant-role.service delete guard). The UI must state that same rule and
  // block confirm — not offer a "they will lose access" delete that the server
  // will reject with a raw ForbiddenException.
  const hasActiveHolders = (role.userCount ?? 0) > 0;

  return (
    <div
      className="sd-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        onKeyDown={handleKeyDown}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="sd-modal"
        style={{ maxWidth: '26rem', width: '100%' }}
      >
        <div className="sd-modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <div
              style={{ display: 'grid', placeItems: 'center', width: 40, height: 40, borderRadius: 999, background: 'rgba(176,74,40,.12)', flexShrink: 0 }}
              aria-hidden="true"
            >
              <Trash2 size={18} style={{ color: '#b04a28' }} />
            </div>
            <div>
              <h3 id={titleId} className="sd-modal-title" style={{ fontSize: 17 }}>Delete Role</h3>
              <p id={descriptionId} className="sd-modal-sub">
                Are you sure you want to delete "{role.name}"?
              </p>
            </div>
          </div>
        </div>

        <div className="sd-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {hasActiveHolders && (
            <div
              className="sd-banner"
              style={{ background: '#fbf3dc', borderColor: 'rgba(146,97,10,.28)', fontSize: 13, color: '#92610a', display: 'flex', gap: 8, alignItems: 'flex-start' }}
              role="status"
            >
              <AlertCircle size={15} style={{ color: '#92610a', flexShrink: 0, marginTop: 2 }} />
              <span>
                This role cannot be deleted while it is assigned to{' '}
                {role.userCount ?? 0} user(s). Reassign those users to another
                role first.
              </span>
            </div>
          )}

          {errorMessage && (
            <div
              className="sd-banner"
              style={{ background: 'rgba(176,74,40,.10)', borderColor: 'rgba(176,74,40,.32)', fontSize: 13, color: '#8e3a1e', display: 'flex', gap: 8, alignItems: 'flex-start' }}
              role="alert"
            >
              <AlertCircle size={15} style={{ color: '#8e3a1e', flexShrink: 0, marginTop: 2 }} />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        <div className="sd-modal-foot">
          <button onClick={onClose} className="sd-btn-ghost">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading || hasActiveHolders}
            className="sd-btn-danger"
          >
            {isLoading ? (
              <>
                <RefreshCw size={15} className="animate-spin" aria-hidden="true" />
                Deleting…
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
    // Reset any error from a previous delete attempt so a fresh dialog
    // never opens pre-populated with a stale server rejection (RBAC-M8).
    deleteMutation.reset();
    setDeletingRole(role);
  }, [deleteMutation]);

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
      <div className="flex items-center justify-center h-64" role="status" aria-live="polite">
        <RefreshCw className="w-8 h-8 animate-spin" style={{ color: '#146f84' }} aria-hidden="true" />
        <span className="sr-only">Loading roles…</span>
      </div>
    );
  }

  return (
    <div className="sd-page">
      {/* Page header (mockup pattern: eyebrow + serif title + subtitle) */}
      <div className="sd-pagehead">
        <span className="sd-eyebrow">People &amp; access</span>
        <h1 className="sd-page-title">Roles &amp; Permissions</h1>
        <span className="sd-page-sub">Define custom roles with granular permission control</span>
      </div>

      {/* Actions row */}
      <div className="sd-actions">
        <button onClick={handleRefresh} className="sd-iconbtn" title="Refresh" aria-label="Refresh">
          <RefreshCw size={16} />
        </button>
        {/* RBAC-HIGH-004: seed + create require the roles:create capability.
            RBAC-M14: the seed offer only renders on a CONFIRMED empty list —
            on a query error `roles` is just the [] default, and offering a
            seed there invites a duplicate seed against unknown server state. */}
        {canCreateRoles && (
          <>
            {!error && roles.length === 0 && (
              <button
                onClick={handleSeedRoles}
                disabled={seedMutation.isPending}
                className="sd-btn-ghost"
              >
                {seedMutation.isPending ? (
                  <RefreshCw size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Shield size={15} />
                )}
                Seed Default Roles
              </button>
            )}
            <button onClick={handleOpenCreate} className="sd-btn-deep">
              <Plus size={16} />
              Create Role
            </button>
          </>
        )}
      </div>

      {/* Error Message */}
      {error && (
        <div className="sd-banner sd-banner--error" role="alert">
          <AlertCircle size={19} style={{ color: '#b04a28', flexShrink: 0 }} />
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#8e3a1e' }}>Failed to load roles</p>
          <p style={{ margin: 0, flex: 1, fontSize: 13.5, color: '#3d5c69' }}>{(error as Error).message}</p>
          <button onClick={() => refetch()} className="sd-btn-ghost" style={{ padding: '6px 13px', fontSize: 12.5, color: '#8e3a1e', borderColor: 'rgba(176,74,40,.35)' }}>
            Retry
          </button>
        </div>
      )}

      {/* Roles Grid — PERF-009: use shared RoleCard component, no inline duplicate.
          RBAC-M14: on a query error the empty state must NOT render — `roles`
          is only the [] default, not a confirmed empty list; the error banner
          above (with Retry) is the whole content. */}
      {roles.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 16 }}>
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
        <div className="sd-card sd-empty" style={{ padding: '48px 22px' }}>
          <Shield size={30} style={{ color: '#8aa0aa', marginBottom: 10 }} aria-hidden="true" />
          <strong style={{ display: 'block', marginBottom: 6 }}>No roles defined</strong>
          Create custom roles to manage user permissions. You can also seed
          default roles to get started quickly.
          {/* RBAC-HIGH-004: seed + create require the roles:create capability. */}
          {canCreateRoles && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
              <button
                onClick={handleSeedRoles}
                disabled={seedMutation.isPending}
                className="sd-btn-ghost"
              >
                {seedMutation.isPending ? (
                  <RefreshCw size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Shield size={15} />
                )}
                Seed Default Roles
              </button>
              <button onClick={handleOpenCreate} className="sd-btn-teal">
                <Plus size={15} />
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
        errorMessage={deleteMutation.error?.message}
      />
    </div>
  );
};

export default TenantRolesPage;
