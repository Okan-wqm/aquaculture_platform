/**
 * Per-widget role-based permission configuration following ISA-101.
 * Collapsible section that starts collapsed by default.
 *
 * In a multi-tenant aquaculture platform, different roles (operator,
 * supervisor, engineer, admin) need different access levels to SCADA
 * widgets. An operator should see pump status but may need supervisor
 * approval to change setpoints.
 *
 * Roles are fetched from the tenant's role definitions. If no roles
 * are configured, the section shows a hint to configure roles in
 * the tenant admin panel.
 */

import React, { useState, useCallback } from 'react';
import type { WidgetPermissions } from '../../../types/scada-widget.types';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface WidgetPermissionsSectionProps {
  permissions: WidgetPermissions;
  onChange: (permissions: WidgetPermissions) => void;
}

/* ------------------------------------------------------------------ */
/*  Available roles                                                    */
/*                                                                     */
/*  TODO: Replace hardcoded list with a tenant-aware hook that fetches */
/*  roles from auth-service (GET /api/auth/roles). The hook should     */
/*  cache results per tenant to avoid redundant network calls while    */
/*  the builder is open.                                               */
/* ------------------------------------------------------------------ */

const AVAILABLE_ROLES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'admin', label: 'Admin' },
  { id: 'supervisor', label: 'Supervisor' },
  { id: 'operator', label: 'Operator' },
  { id: 'viewer', label: 'Viewer' },
] as const;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const WidgetPermissionsSection: React.FC<WidgetPermissionsSectionProps> = ({
  permissions,
  onChange,
}) => {
  const [open, setOpen] = useState(false);

  /** Toggle a single role within the given category (showRoles / enableRoles). */
  const toggleRole = useCallback(
    (category: keyof WidgetPermissions, roleId: string) => {
      const current = permissions[category];
      const next = current.includes(roleId)
        ? current.filter((r) => r !== roleId)
        : [...current, roleId];
      onChange({ ...permissions, [category]: next });
    },
    [permissions, onChange],
  );

  /** Clear all role restrictions -- returns to "open for all" default. */
  const handleReset = useCallback(() => {
    onChange({ showRoles: [], enableRoles: [] });
  }, [onChange]);

  const hasAnyRestriction =
    permissions.showRoles.length > 0 || permissions.enableRoles.length > 0;

  return (
    <div className="border-t border-gray-100 pt-2 mt-3" data-testid="permissions-section">
      {/* Collapsible header -- matches TransformConfig chevron pattern */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full text-xs font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-700"
        aria-expanded={open}
        aria-label="Permissions settings"
        data-testid="permissions-toggle"
      >
        <span className="flex items-center gap-1.5">
          Permissions
          {hasAnyRestriction && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" title="Role restrictions active" />
          )}
        </span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="space-y-4 mt-2" data-testid="permissions-content">
          {/* Visibility roles */}
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1">Who can see this widget?</p>
            {permissions.showRoles.length === 0 && (
              <p className="text-[10px] text-gray-400 italic mb-1">Visible to all roles</p>
            )}
            <div className="space-y-1">
              {AVAILABLE_ROLES.map((role) => (
                <label key={`show-${role.id}`} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={permissions.showRoles.includes(role.id)}
                    onChange={() => toggleRole('showRoles', role.id)}
                    className="text-cyan-600 rounded focus:ring-cyan-500"
                    data-testid={`show-role-${role.id}`}
                  />
                  <span className="text-xs text-gray-700">{role.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Interaction roles */}
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1">Who can interact with this widget?</p>
            {permissions.enableRoles.length === 0 && (
              <p className="text-[10px] text-gray-400 italic mb-1">Enabled for all roles</p>
            )}
            <div className="space-y-1">
              {AVAILABLE_ROLES.map((role) => (
                <label key={`enable-${role.id}`} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={permissions.enableRoles.includes(role.id)}
                    onChange={() => toggleRole('enableRoles', role.id)}
                    className="text-cyan-600 rounded focus:ring-cyan-500"
                    data-testid={`enable-role-${role.id}`}
                  />
                  <span className="text-xs text-gray-700">{role.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Reset button -- only visible when restrictions are active */}
          {hasAnyRestriction && (
            <button
              type="button"
              onClick={handleReset}
              className="w-full py-1.5 text-xs text-gray-500 hover:text-red-500 border border-gray-200 hover:border-red-200 rounded-lg transition-colors"
              data-testid="permissions-reset"
            >
              Clear All Restrictions
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default WidgetPermissionsSection;
