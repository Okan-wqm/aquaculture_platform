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
        style={{ maxWidth: '32rem', width: '100%' }}
      >
        {/* Header */}
        <div className="sd-modal-head">
          <div>
            <h2 id={titleId} className="sd-modal-title">
              {isEditing ? 'Edit User' : 'Add New User'}
            </h2>
            <p id={descriptionId} className="sd-modal-sub">
              {isEditing
                ? `Editing ${user?.email}`
                : 'Create a new user and assign a role'}
            </p>
          </div>
          <button onClick={onClose} className="sd-iconbtn" aria-label="Close modal">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <div className="sd-modal-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Error Message */}
            {error && (
              <div className="sd-banner sd-banner--error" role="alert" style={{ padding: '10px 13px' }}>
                <AlertCircle size={15} style={{ color: '#b04a28', flexShrink: 0 }} />
                <p style={{ margin: 0, fontSize: 13, color: '#8e3a1e' }}>{error}</p>
              </div>
            )}

            {/* Email */}
            <label className="sd-field">
              <span>
                <Mail size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />
                Email Address *
              </span>
              <input
                type="email"
                className={`sd-input${validationErrors.email ? ' sd-input--invalid' : ''}`}
                value={formData.email}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, email: e.target.value }))
                }
                placeholder="user@example.com"
                disabled={isEditing}
              />
              {validationErrors.email && (
                <small style={{ fontSize: 11.5, color: '#b04a28' }}>
                  {validationErrors.email}
                </small>
              )}
            </label>

            {/* Name Fields */}
            <div className="sd-fieldgrid">
              <label className="sd-field">
                <span>First Name *</span>
                <input
                  type="text"
                  className={`sd-input${validationErrors.firstName ? ' sd-input--invalid' : ''}`}
                  value={formData.firstName}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      firstName: e.target.value,
                    }))
                  }
                  placeholder="John"
                />
                {validationErrors.firstName && (
                  <small style={{ fontSize: 11.5, color: '#b04a28' }}>
                    {validationErrors.firstName}
                  </small>
                )}
              </label>
              <label className="sd-field">
                <span>Last Name *</span>
                <input
                  type="text"
                  className={`sd-input${validationErrors.lastName ? ' sd-input--invalid' : ''}`}
                  value={formData.lastName}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      lastName: e.target.value,
                    }))
                  }
                  placeholder="Doe"
                />
                {validationErrors.lastName && (
                  <small style={{ fontSize: 11.5, color: '#b04a28' }}>
                    {validationErrors.lastName}
                  </small>
                )}
              </label>
            </div>

            {/* Phone Number */}
            <label className="sd-field">
              <span>
                <Phone size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />
                Phone Number
              </span>
              <input
                type="tel"
                className="sd-input"
                value={formData.phoneNumber}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    phoneNumber: e.target.value,
                  }))
                }
                placeholder="+90 555 123 4567"
              />
            </label>

            {/* Role Selection */}
            <div>
              <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#5c7783', marginBottom: 8 }}>
                <Shield size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />
                Assign Role
              </span>
              {rolesLoading ? (
                <div className="sd-empty" style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start' }}>
                  <RefreshCw size={14} className="animate-spin" style={{ color: '#8aa0aa' }} aria-hidden="true" />
                  Loading roles…
                </div>
              ) : roles.length === 0 ? (
                <div className="sd-banner" style={{ background: '#fbf3dc', borderColor: 'rgba(146,97,10,.28)', fontSize: 13, color: '#92610a' }}>
                  No roles defined. Please create roles first.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {roles.map((role) => (
                    <label
                      key={role.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 11,
                        padding: 11,
                        borderRadius: 12,
                        border: `1.5px solid ${formData.roleId === role.id ? 'rgba(20,111,132,.55)' : 'rgba(10,31,43,.10)'}`,
                        background: formData.roleId === role.id ? 'rgba(110,231,199,.14)' : '#fffdf8',
                        cursor: 'pointer',
                        transition: 'border-color .15s, background .15s',
                      }}
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
                        style={{
                          display: 'grid',
                          placeItems: 'center',
                          width: 32,
                          height: 32,
                          borderRadius: 10,
                          backgroundColor: `${role.color}20`,
                          flexShrink: 0,
                        }}
                      >
                        <Shield
                          size={14}
                          style={{ color: role.color }}
                        />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: '#0a1f2b' }}>
                          {role.name}
                          {role.isDefault && (
                            <span style={{ marginLeft: 7, fontSize: 11.5, color: '#166f5a', fontWeight: 600 }}>
                              (Default)
                            </span>
                          )}
                        </p>
                        {role.description && (
                          <p style={{ margin: 0, fontSize: 12, color: '#5c7783', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {role.description}
                          </p>
                        )}
                      </div>
                      {formData.roleId === role.id && (
                        <Check size={16} style={{ color: '#146f84', flexShrink: 0 }} />
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
              <div className="sd-checkrow" style={{ background: 'rgba(110,231,199,.14)', borderColor: 'rgba(74,187,162,.38)' }}>
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
                />
                <label htmlFor="sendInvitation" style={{ flex: 1, cursor: 'pointer' }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: '#0a1f2b' }}>
                    Send invitation email
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: '#5c7783' }}>
                    User will receive an email with login instructions
                  </span>
                </label>
                <Mail size={16} style={{ color: '#166f5a' }} aria-hidden="true" />
              </div>
            )}
            </div>
          </div>

          {/* Footer */}
          <div className="sd-modal-foot">
            {selectedRole && (
              <p style={{ margin: 0, marginRight: 'auto', fontSize: 12, color: '#5c7783' }}>
                Role:{' '}
                <span style={{ fontWeight: 600, color: selectedRole.color }}>
                  {selectedRole.name}
                </span>
              </p>
            )}
            <button type="button" onClick={onClose} className="sd-btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || (!isEditing && roles.length === 0 && !rolesLoading)}
              className="sd-btn-teal"
            >
              {isLoading ? (
                <>
                  <RefreshCw size={15} className="animate-spin" aria-hidden="true" />
                  {isEditing ? 'Updating…' : 'Creating…'}
                </>
              ) : (
                <>
                  {isEditing ? (
                    <>
                      <Check size={15} />
                      Update User
                    </>
                  ) : (
                    <>
                      <User size={15} />
                      Create User
                    </>
                  )}
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddEditUserModal;
