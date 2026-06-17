/**
 * AddEditUserModal Component
 *
 * Modal for creating and editing tenant users with role selection.
 */

import React, { useState, useEffect, useId } from 'react';
import {
  X,
  User,
  Mail,
  Phone,
  Shield,
  RefreshCw,
  Check,
  AlertCircle,
} from 'lucide-react';
import type { TenantRole } from '../../hooks/useTenantRoles';
import { useFocusTrap } from '../../hooks';

// ============================================================================
// Types
// ============================================================================

export interface UserFormData {
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber?: string;
  roleId?: string;
  sendInvitation: boolean;
}

interface AddEditUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  user?: {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    phoneNumber?: string;
    roleId?: string;
  } | null;
  roles: TenantRole[];
  rolesLoading?: boolean;
  onSave: (data: UserFormData) => Promise<void>;
  isLoading?: boolean;
  error?: string | null;
}

// ============================================================================
// Main Component
// ============================================================================

export const AddEditUserModal: React.FC<AddEditUserModalProps> = ({
  isOpen,
  onClose,
  user,
  roles,
  rolesLoading,
  onSave,
  isLoading,
  error,
}) => {
  const isEditing = !!user;

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

  // Form state
  const [formData, setFormData] = useState<UserFormData>({
    email: '',
    firstName: '',
    lastName: '',
    phoneNumber: '',
    roleId: '',
    sendInvitation: true,
  });

  const [validationErrors, setValidationErrors] = useState<
    Partial<Record<keyof UserFormData, string>>
  >({});

  // Reset form when modal opens/closes or user changes
  useEffect(() => {
    if (isOpen) {
      if (user) {
        setFormData({
          email: user.email,
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          phoneNumber: user.phoneNumber || '',
          roleId: user.roleId || '',
          sendInvitation: false,
        });
      } else {
        // Find default role
        const defaultRole = roles.find((r) => r.isDefault);
        setFormData({
          email: '',
          firstName: '',
          lastName: '',
          phoneNumber: '',
          roleId: defaultRole?.id || '',
          sendInvitation: true,
        });
      }
      setValidationErrors({});
    }
  }, [isOpen, user, roles]);

  // Validate form
  const validate = (): boolean => {
    const errors: Partial<Record<keyof UserFormData, string>> = {};

    if (!formData.email.trim()) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      errors.email = 'Invalid email format';
    }

    if (!formData.firstName.trim()) {
      errors.firstName = 'First name is required';
    }

    if (!formData.lastName.trim()) {
      errors.lastName = 'Last name is required';
    }

    // HIGH-13: Require role selection for new users
    if (!isEditing && !formData.roleId) {
      errors.roleId = 'Please select a role';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Handle submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validate()) return;

    await onSave(formData);
  };

  // Get selected role
  const selectedRole = roles.find((r) => r.id === formData.roleId);

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
        className="relative bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-tenant-50 to-white">
          <div>
            <h2 id={titleId} className="text-xl font-bold text-gray-900">
              {isEditing ? 'Edit User' : 'Add New User'}
            </h2>
            <p id={descriptionId} className="text-sm text-gray-500 mt-0.5">
              {isEditing
                ? `Editing ${user?.email}`
                : 'Create a new user and assign a role'}
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
          <div className="p-6 space-y-5">
            {/* Error Message */}
            {error && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                <Mail className="w-4 h-4 inline mr-1" />
                Email Address *
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, email: e.target.value }))
                }
                placeholder="user@example.com"
                disabled={isEditing}
                className={`w-full px-4 py-2 rounded-lg border focus:outline-hidden focus:ring-2 focus:ring-tenant-500 disabled:bg-gray-100 ${
                  validationErrors.email ? 'border-red-300' : 'border-gray-200'
                }`}
              />
              {validationErrors.email && (
                <p className="text-xs text-red-500 mt-1">
                  {validationErrors.email}
                </p>
              )}
            </div>

            {/* Name Fields */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  First Name *
                </label>
                <input
                  type="text"
                  value={formData.firstName}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      firstName: e.target.value,
                    }))
                  }
                  placeholder="John"
                  className={`w-full px-4 py-2 rounded-lg border focus:outline-hidden focus:ring-2 focus:ring-tenant-500 ${
                    validationErrors.firstName
                      ? 'border-red-300'
                      : 'border-gray-200'
                  }`}
                />
                {validationErrors.firstName && (
                  <p className="text-xs text-red-500 mt-1">
                    {validationErrors.firstName}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Last Name *
                </label>
                <input
                  type="text"
                  value={formData.lastName}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      lastName: e.target.value,
                    }))
                  }
                  placeholder="Doe"
                  className={`w-full px-4 py-2 rounded-lg border focus:outline-hidden focus:ring-2 focus:ring-tenant-500 ${
                    validationErrors.lastName
                      ? 'border-red-300'
                      : 'border-gray-200'
                  }`}
                />
                {validationErrors.lastName && (
                  <p className="text-xs text-red-500 mt-1">
                    {validationErrors.lastName}
                  </p>
                )}
              </div>
            </div>

            {/* Phone Number */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                <Phone className="w-4 h-4 inline mr-1" />
                Phone Number
              </label>
              <input
                type="tel"
                value={formData.phoneNumber}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    phoneNumber: e.target.value,
                  }))
                }
                placeholder="+90 555 123 4567"
                className="w-full px-4 py-2 rounded-lg border border-gray-200 focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
              />
            </div>

            {/* Role Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                <Shield className="w-4 h-4 inline mr-1" />
                Assign Role
              </label>
              {rolesLoading ? (
                <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
                  <RefreshCw className="w-4 h-4 animate-spin text-gray-500" />
                  <span className="text-sm text-gray-500">Loading roles...</span>
                </div>
              ) : roles.length === 0 ? (
                <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg">
                  <p className="text-sm text-amber-700">
                    No roles defined. Please create roles first.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {roles.map((role) => (
                    <label
                      key={role.id}
                      className={`
                        flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer
                        transition-all hover:border-tenant-300
                        ${
                          formData.roleId === role.id
                            ? 'border-tenant-500 bg-tenant-50'
                            : 'border-gray-100 bg-white'
                        }
                      `}
                    >
                      <input
                        type="radio"
                        name="role"
                        value={role.id}
                        checked={formData.roleId === role.id}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            roleId: e.target.value,
                          }))
                        }
                        className="sr-only"
                      />
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={{ backgroundColor: `${role.color}20` }}
                      >
                        <Shield
                          className="w-4 h-4"
                          style={{ color: role.color }}
                        />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-900">
                          {role.name}
                          {role.isDefault && (
                            <span className="ml-2 text-xs text-green-600">
                              (Default)
                            </span>
                          )}
                        </p>
                        {role.description && (
                          <p className="text-xs text-gray-500 line-clamp-1">
                            {role.description}
                          </p>
                        )}
                      </div>
                      {formData.roleId === role.id && (
                        <Check className="w-5 h-5 text-tenant-600" />
                      )}
                    </label>
                  ))}
                </div>
              )}
              {validationErrors.roleId && (
                <p className="text-xs text-red-500 mt-1">
                  {validationErrors.roleId}
                </p>
              )}
            </div>

            {/* Send Invitation Toggle (only for new users) */}
            {!isEditing && (
              <div className="flex items-center gap-3 p-4 bg-blue-50 rounded-xl border border-blue-100">
                <input
                  type="checkbox"
                  id="sendInvitation"
                  checked={formData.sendInvitation}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      sendInvitation: e.target.checked,
                    }))
                  }
                  className="rounded border-gray-300 text-tenant-600 focus:ring-tenant-500"
                />
                <label htmlFor="sendInvitation" className="flex-1">
                  <span className="text-sm font-medium text-gray-900">
                    Send invitation email
                  </span>
                  <p className="text-xs text-gray-500">
                    User will receive an email with login instructions
                  </p>
                </label>
                <Mail className="w-5 h-5 text-blue-500" />
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
            {selectedRole && (
              <p className="text-xs text-gray-500">
                Role:{' '}
                <span className="font-medium" style={{ color: selectedRole.color }}>
                  {selectedRole.name}
                </span>
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
                disabled={isLoading || (!isEditing && roles.length === 0 && !rolesLoading)}
                className="px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    {isEditing ? 'Updating...' : 'Creating...'}
                  </>
                ) : (
                  <>
                    {isEditing ? (
                      <>
                        <Check className="w-4 h-4" />
                        Update User
                      </>
                    ) : (
                      <>
                        <User className="w-4 h-4" />
                        Create User
                      </>
                    )}
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

export default AddEditUserModal;
