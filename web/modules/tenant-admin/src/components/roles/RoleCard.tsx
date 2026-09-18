/**
 * RoleCard Component
 *
 * Displays a single tenant role as a card with its details,
 * including name, description, user count, and action buttons.
 *
 * SUDERRA restyle — sd-card primitives from the shell stylesheet; role color
 * still comes from the tenant's stored role.color (real data).
 *
 * @module components/roles/RoleCard
 */

import React from 'react';
import { Shield, Edit, Trash2, Users, Star } from 'lucide-react';
import type { TenantRole } from '../../hooks/useTenantRoles';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the RoleCard component
 */
export interface RoleCardProps {
  /** The role data to display */
  role: TenantRole;
  /** Callback fired when the edit button is clicked. Omit to hide the edit button (SEC-007). */
  onEdit?: (role: TenantRole) => void;
  /** Callback fired when the delete button is clicked. Omit to hide the delete button (SEC-007). */
  onDelete?: (role: TenantRole) => void;
}

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Badge component displaying role name with color
 *
 * @param props - Component props
 * @param props.role - The role to display
 */
export interface RoleBadgeProps {
  /** The role to display as a badge */
  role: TenantRole;
}

export const RoleBadge: React.FC<RoleBadgeProps> = ({ role }) => {
  return (
    <span
      className="sd-rolepill"
      style={{ backgroundColor: `${role.color || '#6366F1'}22`, color: role.color || '#6366F1' }}
    >
      <Shield size={12} aria-hidden="true" />
      {role.name}
    </span>
  );
};

// ============================================================================
// Main Component
// ============================================================================

/**
 * Card component for displaying tenant role information
 *
 * Features:
 * - Color-coded role icon (tenant-configured color, real data)
 * - System role and default role indicators
 * - Description with text truncation
 * - User count and priority level stats
 * - Edit and delete action buttons
 *
 * @example
 * ```tsx
 * <RoleCard
 *   role={role}
 *   onEdit={handleEditRole}
 *   onDelete={handleDeleteRole}
 * />
 * ```
 */
export const RoleCard: React.FC<RoleCardProps> = ({
  role,
  onEdit,
  onDelete,
}) => {
  return (
    <div className="sd-card" style={{ padding: '17px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Role Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 38,
              height: 38,
              borderRadius: 12,
              backgroundColor: `${role.color || '#6366F1'}1e`,
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            <Shield
              size={17}
              style={{ color: role.color || '#6366F1' }}
            />
          </div>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 600, color: '#0a1f2b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {role.name}
            </h3>
            {role.isSystem && (
              <span style={{ fontSize: 11.5, fontWeight: 600, color: '#92610a' }}>
                System Role
              </span>
            )}
            {role.isDefault && !role.isSystem && (
              <span style={{ fontSize: 11.5, fontWeight: 600, color: '#166f5a', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Star size={11} aria-hidden="true" />
                Default
              </span>
            )}
          </div>
        </div>

        {/* Action Buttons - SEC-007: only rendered when callbacks provided */}
        {(onEdit || onDelete) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {onEdit && (
              <button
                onClick={() => onEdit(role)}
                className="sd-iconbtn"
                title="Edit role"
                aria-label={`Edit ${role.name} role`}
              >
                <Edit size={15} />
              </button>
            )}
            {onDelete && !role.isSystem && (
              <button
                onClick={() => onDelete(role)}
                className="sd-iconbtn sd-iconbtn--danger"
                title="Delete role"
                aria-label={`Delete ${role.name} role`}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Description */}
      {role.description && (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#5c7783', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {role.description}
        </p>
      )}

      {/* Stats */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          paddingTop: 11,
          borderTop: '1px solid rgba(10,31,43,.08)',
          fontSize: 12.5,
          color: '#5c7783',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Users size={14} aria-hidden="true" />
          {role.userCount} users
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Shield size={14} aria-hidden="true" />
          Level {role.level}
        </span>
      </div>
    </div>
  );
};

export default RoleCard;
