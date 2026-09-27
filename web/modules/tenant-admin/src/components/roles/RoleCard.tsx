/**
 * RoleCard Component
 *
 * Displays a single tenant role as a card with its details,
 * including name, description, user count, and action buttons.
 *
 * @module components/roles/RoleCard
 */

import React from 'react';
import { Button } from '@aquaculture/shared-ui';

import { DEFAULT_ROLE_COLOR } from '../../lib/constants';
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
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-white"
      style={{ backgroundColor: role.color || DEFAULT_ROLE_COLOR }}
    >
      <Shield className="w-3 h-3" aria-hidden="true" />
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
 * - Color-coded role icon
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
export const RoleCard: React.FC<RoleCardProps> = ({ role, onEdit, onDelete }) => {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 p-5 hover:shadow-lg transition-shadow">
      {/* Role Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div
            className="p-2.5 rounded-xl"
            style={{ backgroundColor: `${role.color}20` }}
            aria-hidden="true"
          >
            <Shield className="w-5 h-5" style={{ color: role.color || DEFAULT_ROLE_COLOR }} />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">{role.name}</h3>
            {role.isSystem && (
              <span className="text-xs text-warning-600 dark:text-warning-400 font-medium">
                System Role
              </span>
            )}
            {role.isDefault && !role.isSystem && (
              <span className="text-xs text-success-600 dark:text-success-400 font-medium flex items-center gap-1">
                <Star className="w-3 h-3" aria-hidden="true" />
                Default
              </span>
            )}
          </div>
        </div>

        {/* Action Buttons - SEC-007: only rendered when callbacks provided */}
        {(onEdit || onDelete) && (
          <div className="flex items-center gap-1">
            {onEdit && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={() => onEdit(role)}
                title="Edit role"
                aria-label={`Edit ${role.name} role`}
              >
                <Edit className="w-4 h-4" />
              </Button>
            )}
            {onDelete && !role.isSystem && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={() => onDelete(role)}
                title="Delete role"
                aria-label={`Delete ${role.name} role`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Description */}
      {role.description && (
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 line-clamp-2">
          {role.description}
        </p>
      )}

      {/* Stats */}
      <div className="flex items-center gap-4 pt-4 border-t border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
          <Users className="w-4 h-4" aria-hidden="true" />
          <span>{role.userCount} users</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
          <Shield className="w-4 h-4" aria-hidden="true" />
          <span>Level {role.level}</span>
        </div>
      </div>
    </div>
  );
};

export default RoleCard;
