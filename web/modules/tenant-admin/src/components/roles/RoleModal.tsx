/**
 * RoleModal Component
 *
 * Modal dialog for creating and editing tenant roles with permissions.
 * Provides form inputs for role name, description, color, priority level,
 * and a permission checkbox group for granular permission control.
 *
 * @module components/roles/RoleModal
 */

import React, { useState, useEffect } from 'react';
import {
  X,
  Check,
  RefreshCw,
  Star,
  Palette,
} from 'lucide-react';
import { PermissionCheckboxGroup } from '../permissions';
import type {
  TenantRole,
  CreateTenantRoleInput,
  UpdateTenantRoleInput,
  PanelPermissions,
  PermissionCategory,
} from '../../hooks/useTenantRoles';

// ============================================================================
// Constants
// ============================================================================

/**
 * Available role colors for customization
 */
export const ROLE_COLORS = [
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
 * Color picker component for selecting role colors
 *
 * @param props - Component props
 * @param props.value - Currently selected color value
 * @param props.onChange - Callback fired when color selection changes
 */
interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

const ColorPicker: React.FC<ColorPickerProps> = ({ value, onChange }) => {
  return (
    <div className="flex flex-wrap gap-2">
      {ROLE_COLORS.map((color) => (
        <button
          key={color.value}
          type="button"
          onClick={() => onChange(color.value)}
          className={`
            w-8 h-8 rounded-lg border-2 transition-all
            ${value === color.value ? 'border-gray-900 scale-110' : 'border-transparent hover:scale-105'}
          `}
          style={{ backgroundColor: color.value }}
          title={color.label}
          aria-label={`Select ${color.label} color`}
        />
      ))}
    </div>
  );
};

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the RoleModal component
 */
export interface RoleModalProps {
  /** Whether the modal is currently visible */
  isOpen: boolean;
  /** Callback fired when the modal should close */
  onClose: () => void;
  /** Existing role to edit, or null/undefined for creating a new role */
  role?: TenantRole | null;
  /** Available permission categories to display */
  categories: PermissionCategory[];
  /** Callback fired when the form is submitted with role data */
  onSave: (data: CreateTenantRoleInput | UpdateTenantRoleInput) => void;
  /** Whether a save operation is in progress */
  isLoading?: boolean;
}

/**
 * Internal form state for the role modal
 */
interface RoleFormData {
  name: string;
  description: string;
  color: string;
  icon: string;
  level: number;
  isDefault: boolean;
  panelPermissions: PanelPermissions;
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Modal dialog for creating and editing tenant roles
 *
 * Provides a comprehensive form for role management including:
 * - Basic information (name, description)
 * - Visual customization (color)
 * - Priority level configuration
 * - Default role toggle
 * - Granular permission assignment
 *
 * @example
 * ```tsx
 * <RoleModal
 *   isOpen={isModalOpen}
 *   onClose={() => setIsModalOpen(false)}
 *   role={editingRole}
 *   categories={permissionCategories}
 *   onSave={handleSaveRole}
 *   isLoading={isSaving}
 * />
 * ```
 */
export const RoleModal: React.FC<RoleModalProps> = ({
  isOpen,
  onClose,
  role,
  categories,
  onSave,
  isLoading,
}) => {
  const isEditing = !!role;

  const getInitialFormData = (): RoleFormData => ({
    name: role?.name || '',
    description: role?.description || '',
    color: role?.color || '#6366F1',
    icon: role?.icon || 'shield',
    level: role?.level || 50,
    isDefault: role?.isDefault || false,
    panelPermissions: role?.permissions?.panelPermissions || {},
  });

  const [formData, setFormData] = useState<RoleFormData>(getInitialFormData);

  // Reset form data when role prop changes
  useEffect(() => {
    setFormData(getInitialFormData());
  }, [role?.id]);

  /**
   * Handle form submission
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="role-modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-tenant-50 to-white">
          <div>
            <h2 id="role-modal-title" className="text-xl font-bold text-gray-900">
              {isEditing ? 'Edit Role' : 'Create New Role'}
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">
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
                <label
                  htmlFor="role-name"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  Role Name *
                </label>
                <input
                  id="role-name"
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder="e.g., Supervisor, Technician"
                  required
                  disabled={role?.isSystemRole}
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-tenant-500 disabled:bg-gray-100"
                />
              </div>

              <div>
                <label
                  htmlFor="role-level"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  Priority Level
                </label>
                <input
                  id="role-level"
                  type="number"
                  min="1"
                  max="100"
                  value={formData.level}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      level: parseInt(e.target.value) || 50,
                    }))
                  }
                  className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-tenant-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Higher = more authority (1-100)
                </p>
              </div>
            </div>

            <div>
              <label
                htmlFor="role-description"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Description
              </label>
              <textarea
                id="role-description"
                value={formData.description}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                placeholder="Describe what this role is for..."
                rows={2}
                className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-tenant-500 resize-none"
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
                onChange={(color) =>
                  setFormData((prev) => ({ ...prev, color }))
                }
              />
            </div>

            {/* Default Role Toggle */}
            <div className="flex items-center gap-3 p-4 bg-yellow-50 rounded-xl border border-yellow-100">
              <input
                type="checkbox"
                id="isDefault"
                checked={formData.isDefault}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    isDefault: e.target.checked,
                  }))
                }
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
              <Star className="w-5 h-5 text-yellow-500" aria-hidden="true" />
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
                  onChange={(panelPermissions) =>
                    setFormData((prev) => ({ ...prev, panelPermissions }))
                  }
                  disabled={role?.isSystemRole}
                  readOnly={role?.isSystemRole}
                />
              ) : (
                <div className="p-8 text-center bg-gray-50 rounded-xl">
                  <RefreshCw className="w-6 h-6 animate-spin text-gray-400 mx-auto" />
                  <p className="mt-2 text-sm text-gray-500">
                    Loading permission categories...
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
            {role?.isSystemRole && (
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
                disabled={isLoading || role?.isSystemRole || !formData.name.trim()}
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
};

export default RoleModal;
