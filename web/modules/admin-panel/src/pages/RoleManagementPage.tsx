/**
 * Role Management Page
 *
 * Rol ve yetki yönetimi - Role hierarchy and permissions.
 */

import React, { useEffect, useState } from 'react';
import { Card, Badge } from '@aquaculture/shared-ui';
import { usersApi, Permission, RoleHierarchyItem } from '../services/adminApi';
import { adminKeys, useAdminQuery } from '../hooks';
import { QueryFailureNotice } from '../components/QueryFailureNotice';

// ============================================================================
// Role Management Page
// ============================================================================

const RoleManagementPage: React.FC = () => {
  const [selectedRole, setSelectedRole] = useState<string | null>(null);

  // ==========================================================================
  // Reads (ADMIN-HIGH-121)
  // ==========================================================================

  const rolesQuery = useAdminQuery<RoleHierarchyItem[]>(
    adminKeys.users.roleHierarchy(),
    ({ signal }) => usersApi.getRoleHierarchy(signal),
  );

  const permissionsQuery = useAdminQuery<Record<string, Permission[]>>(
    adminKeys.users.permissionCatalogue(),
    ({ signal }) => usersApi.getPermissionsByCategory(signal),
  );

  const roles = rolesQuery.data ?? [];
  const permissions = permissionsQuery.data ?? {};

  // Which permissions the selected role actually holds. Keyed on the role, so
  // switching back to a role already looked at does not re-request it and
  // switching away cancels the outstanding request.
  const rolePermissionsQuery = useAdminQuery<string[]>(
    adminKeys.users.rolePermissions(selectedRole ?? 'none'),
    ({ signal }) => usersApi.getRolePermissions(selectedRole ?? '', signal),
    { enabled: selectedRole !== null },
  );

  // NOT `?? []`. An empty array here renders every permission in the catalogue
  // as NOT granted — on a permission matrix that is a measurement, and a failed
  // request would have shown the role as holding nothing at all. `undefined`
  // means "not known", and the matrix says so instead of drawing sixty empty
  // checkboxes.
  const selectedRolePermissions = rolePermissionsQuery.data;

  // Select the first role once the hierarchy arrives.
  useEffect(() => {
    if (selectedRole === null && roles.length > 0 && roles[0]) {
      setSelectedRole(roles[0].code);
    }
  }, [roles, selectedRole]);

  const reload = (): void => {
    void rolesQuery.refetch();
    void permissionsQuery.refetch();
    if (selectedRole !== null) {
      void rolePermissionsQuery.refetch();
    }
  };

  const queryErrors = [
    rolesQuery.error,
    permissionsQuery.error,
    rolePermissionsQuery.error,
  ];

  const getRoleLevelColor = (level: number): string => {
    if (level >= 90) return 'bg-red-100 text-red-800';
    if (level >= 70) return 'bg-purple-100 text-purple-800';
    if (level >= 50) return 'bg-yellow-100 text-yellow-800';
    if (level >= 30) return 'bg-blue-100 text-blue-800';
    return 'bg-gray-100 text-gray-800';
  };

  const selectedRoleData = roles.find((r) => r.code === selectedRole);

  if (rolesQuery.isPending && permissionsQuery.isPending) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (roles.length === 0 && (rolesQuery.error || permissionsQuery.error)) {
    return <QueryFailureNotice errors={queryErrors} hasContent={false} onRetry={reload} />;
  }

  return (
    <div className="space-y-6">
      <QueryFailureNotice errors={queryErrors} hasContent onRetry={reload} />

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Role Management</h1>
          <p className="mt-1 text-sm text-gray-500">
            System roles and permissions hierarchy
          </p>
        </div>
      </div>

      {/* Role Hierarchy Visualization */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Role Hierarchy
        </h3>
        <div className="relative">
          {/* Hierarchy Tree */}
          <div className="flex flex-col space-y-2">
            {roles.map((role, index) => (
              <div
                key={role.code}
                className={`flex items-center p-3 rounded-lg cursor-pointer transition-all ${
                  selectedRole === role.code
                    ? 'bg-blue-50 border-2 border-blue-500'
                    : 'bg-gray-50 border-2 border-transparent hover:bg-gray-100'
                }`}
                style={{ marginLeft: `${(100 - role.level) * 0.3}rem` }}
                onClick={() => setSelectedRole(role.code)}
              >
                {/* Level Indicator */}
                <div
                  className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${getRoleLevelColor(role.level)}`}
                >
                  {role.level}
                </div>

                {/* Role Info */}
                <div className="ml-4 flex-grow">
                  <div className="flex items-center">
                    <span className="font-semibold text-gray-900">
                      {role.name}
                    </span>
                    {role.isSystem && (
                      <Badge variant="info" className="ml-2">
                        System
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-gray-500">{role.description}</p>
                </div>

                {/* Permission Count */}
                <div className="flex-shrink-0 text-right">
                  <span className="text-2xl font-bold text-gray-700">
                    {role.permissions != null ? role.permissions.length : '\u2014'}
                  </span>
                  <p className="text-xs text-gray-500">permissions</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Role Details */}
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Role Details
          </h3>
          {selectedRoleData ? (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-500">Name</label>
                <p className="text-lg font-semibold">{selectedRoleData.name}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Code</label>
                <p className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">
                  {selectedRoleData.code}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">
                  Hierarchy Level
                </label>
                <div className="flex items-center mt-1">
                  <div className="flex-grow bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full"
                      style={{ width: `${selectedRoleData.level}%` }}
                    ></div>
                  </div>
                  <span className="ml-2 text-sm font-medium">
                    {selectedRoleData.level}
                  </span>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">
                  Description
                </label>
                <p className="text-gray-700">{selectedRoleData.description}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Type</label>
                <p>
                  {selectedRoleData.isSystem ? (
                    <Badge variant="warning">System Role (Read-only)</Badge>
                  ) : (
                    <Badge variant="success">Custom Role</Badge>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-gray-500">Select a role to view details</p>
          )}
        </Card>

        {/* Permission Matrix */}
        <Card className="lg:col-span-2 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Permissions for {selectedRoleData?.name || 'Selected Role'}
          </h3>
          {selectedRolePermissions === undefined ? (
            /* The grant set did not load. Rendering the catalogue with every
               box unchecked would state that this role holds no permissions —
               a claim about authority, read off a request that failed. */
            <p className="text-sm text-gray-500" role="status">
              {rolePermissionsQuery.isPending
                ? 'Loading permissions…'
                : 'Permissions for this role could not be loaded.'}
            </p>
          ) : (
          <div className="space-y-6 max-h-[500px] overflow-y-auto">
            {Object.entries(permissions).map(([category, perms]) => (
              <div key={category}>
                <h4 className="text-sm font-medium text-gray-700 mb-2 flex items-center">
                  <span className="w-3 h-3 bg-blue-500 rounded-full mr-2"></span>
                  {category}
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {perms.map((permission) => {
                    const hasPermission = selectedRolePermissions.includes(
                      permission.code,
                    );
                    return (
                      <div
                        key={permission.code}
                        className={`p-2 rounded border ${
                          hasPermission
                            ? 'bg-green-50 border-green-200'
                            : 'bg-gray-50 border-gray-200'
                        }`}
                        title={permission.description}
                      >
                        <div className="flex items-center">
                          <div
                            className={`w-4 h-4 rounded flex items-center justify-center mr-2 ${
                              hasPermission
                                ? 'bg-green-500 text-white'
                                : 'bg-gray-300'
                            }`}
                          >
                            {hasPermission && (
                              <svg
                                className="w-3 h-3"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={3}
                                  d="M5 13l4 4L19 7"
                                />
                              </svg>
                            )}
                          </div>
                          <span
                            className={`text-sm ${hasPermission ? 'text-green-800 font-medium' : 'text-gray-500'}`}
                          >
                            {permission.name}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          )}
        </Card>
      </div>

      {/* Role Assignment Rules.

          This was four hand-typed blocks naming `Super Admin (100)`,
          `Tenant Admin (90)`, `Module Manager (70)` and `Module User (10)` in
          JSX. The numbers were right today, which is the whole problem: it was
          a fifth copy of a vocabulary that four other copies had already
          drifted apart on (ADMIN-CRITICAL-133), and it could neither show a
          role the platform added nor stop showing one it removed — the
          catalogue lost two entries in W8r and this card would not have
          noticed.

          The rule itself is ONE rule, not four, and it lives in auth-service's
          `assertRoleHierarchy`: a platform administrator may assign anything;
          everyone else may assign only inside their own tenant and only at or
          below their own rank. So the rule is stated once, and the roles it
          ranks come from the hierarchy this page already fetched. */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Role Assignment Rules</h3>
        <p className="text-sm text-gray-600 mb-4">
          A platform administrator may assign any role. Every other role may assign only within
          its own tenant, and only at or below its own level. The server enforces this; the
          levels below are the catalogue it enforces against.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {roles.map((role) => (
            <div key={role.code} className={`rounded-lg p-4 ${getRoleLevelColor(role.level)}`}>
              <h4 className="font-semibold">
                {role.name} ({role.level})
              </h4>
              <p className="text-sm mt-1">{role.description}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

export default RoleManagementPage;
