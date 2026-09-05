/**
 * EffectivePermissionsModal Component
 *
 * Read-only modal showing a user's resolved permissions
 * (getUserEffectivePermissions: role + per-user overrides), grouped by
 * category (ADMIN-MEDIUM-016). Follows the module modal conventions
 * (fixed overlay + useFocusTrap + labelled dialog, see AddEditUserModal).
 */

import React, { useId } from 'react';
import { X, Shield, ShieldCheck, RefreshCw, AlertCircle, Check, Minus } from 'lucide-react';
import { useUserEffectivePermissions } from '../../hooks/useTenantData';
import { useFocusTrap } from '../../hooks';
import { sanitizeErrorMessage } from '../../utils/error-handling';

// ============================================================================
// Types
// ============================================================================

export interface EffectivePermissionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The user whose permissions are shown; null renders nothing. */
  user: { id: string; name: string; email: string } | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Group flat "category:action" resource permissions by their category prefix.
 * Entries without a ':' fall into a "general" group.
 */
function groupResourcePermissions(resourcePermissions: string[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const permission of resourcePermissions) {
    const separatorIndex = permission.indexOf(':');
    const category = separatorIndex > 0 ? permission.slice(0, separatorIndex) : 'general';
    const existing = groups.get(category);
    if (existing) {
      existing.push(permission);
    } else {
      groups.set(category, [permission]);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// ============================================================================
// Main Component
// ============================================================================

export const EffectivePermissionsModal: React.FC<EffectivePermissionsModalProps> = ({
  isOpen,
  onClose,
  user,
}) => {
  const titleId = useId();
  const descriptionId = useId();

  const { containerRef, handleKeyDown } = useFocusTrap({
    isOpen,
    onClose,
    closeOnEscape: true,
    autoFocus: true,
    restoreFocus: true,
  });

  const {
    data: permissions,
    isLoading,
    error,
  } = useUserEffectivePermissions(isOpen && user ? user.id : null);

  if (!isOpen || !user) return null;

  const panelCategories = permissions
    ? Object.entries(permissions.panelPermissions).sort(([a], [b]) => a.localeCompare(b))
    : [];
  const resourceGroups = permissions
    ? groupResourcePermissions(permissions.resourcePermissions)
    : [];
  const grants = permissions?.overrides.grants ?? [];
  const revokes = permissions?.overrides.revokes ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
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
              Effective Permissions
            </h2>
            <p id={descriptionId} className="text-sm text-gray-500 mt-0.5">
              Resolved permissions for {user.name} ({user.email})
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
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {isLoading && (
            <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
              <RefreshCw className="w-4 h-4 animate-spin text-gray-500" />
              <span className="text-sm text-gray-500">Loading permissions...</span>
            </div>
          )}

          {error != null && (
            <div className="p-3 bg-red-50 border border-red-100 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <p className="text-sm text-red-700">{sanitizeErrorMessage(error)}</p>
            </div>
          )}

          {permissions && (
            <>
              {/* Role */}
              <div className="flex items-center gap-3 p-3 bg-tenant-50 rounded-lg border border-tenant-100">
                <Shield className="w-5 h-5 text-tenant-600" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-gray-900">{permissions.roleName}</p>
                  <p className="text-xs text-gray-500">Assigned role</p>
                </div>
              </div>

              {/* Panel permissions grouped by category */}
              {panelCategories.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">Panel permissions</h3>
                  {panelCategories.map(([categoryKey, categoryPermissions]) => (
                    <div
                      key={categoryKey}
                      className="border border-gray-100 rounded-lg overflow-hidden"
                    >
                      <p className="px-3 py-2 bg-gray-50 text-xs font-medium text-gray-700 uppercase tracking-wider">
                        {categoryKey}
                      </p>
                      <ul className="divide-y divide-gray-50">
                        {Object.entries(categoryPermissions).map(([resourceName, actions]) => {
                          const enabledActions = Object.entries(actions)
                            .filter(([, enabled]) => enabled)
                            .map(([action]) => action);
                          return (
                            <li
                              key={resourceName}
                              className="px-3 py-2 flex items-start justify-between gap-3"
                            >
                              <span className="text-sm text-gray-700">{resourceName}</span>
                              {enabledActions.length > 0 ? (
                                <span className="text-xs text-green-700 text-right">
                                  {enabledActions.join(', ')}
                                </span>
                              ) : (
                                <span className="text-xs text-gray-500 inline-flex items-center gap-1">
                                  <Minus className="w-3 h-3" aria-hidden="true" />
                                  No access
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}

              {/* Resource permissions grouped by category prefix */}
              {resourceGroups.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">Resource permissions</h3>
                  {resourceGroups.map(([category, categoryPermissions]) => (
                    <div
                      key={category}
                      className="border border-gray-100 rounded-lg overflow-hidden"
                    >
                      <p className="px-3 py-2 bg-gray-50 text-xs font-medium text-gray-700 uppercase tracking-wider">
                        {category}
                      </p>
                      <ul className="divide-y divide-gray-50">
                        {categoryPermissions.map((permission) => (
                          <li key={permission} className="px-3 py-2 flex items-center gap-2">
                            <Check
                              className="w-3.5 h-3.5 text-green-600 flex-shrink-0"
                              aria-hidden="true"
                            />
                            <span className="text-sm text-gray-700">{permission}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}

              {panelCategories.length === 0 && resourceGroups.length === 0 && (
                <p className="text-sm text-gray-500">This user has no resolved permissions.</p>
              )}

              {/* Per-user overrides */}
              {(grants.length > 0 || revokes.length > 0) && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">User overrides</h3>
                  {grants.length > 0 && (
                    <div className="p-3 bg-green-50 border border-green-100 rounded-lg">
                      <p className="text-xs font-medium text-green-800 mb-1">
                        Granted in addition to the role
                      </p>
                      <ul className="space-y-0.5">
                        {grants.map((permission) => (
                          <li
                            key={permission}
                            className="text-sm text-green-700 flex items-center gap-2"
                          >
                            <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                            {permission}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {revokes.length > 0 && (
                    <div className="p-3 bg-red-50 border border-red-100 rounded-lg">
                      <p className="text-xs font-medium text-red-800 mb-1">Revoked from the role</p>
                      <ul className="space-y-0.5">
                        {revokes.map((permission) => (
                          <li
                            key={permission}
                            className="text-sm text-red-700 flex items-center gap-2"
                          >
                            <Minus className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                            {permission}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default EffectivePermissionsModal;
