/**
 * Role Management Page
 *
 * Rol ve yetki yönetimi - Role hierarchy and permissions.
 */

import React, { useState, useEffect } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';
import { usersApi, RoleTemplate, Permission, RoleHierarchyItem } from '../services/adminApi';

// ============================================================================
// Role Management Page
// ============================================================================

const RoleManagementPage: React.FC = () => {
  const [roles, setRoles] = useState<readonly RoleHierarchyItem[]>([]);
  const [permissions, setPermissions] = useState<Readonly<Record<string, readonly Permission[]>>>(
    {},
  );
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [selectedRolePermissions, setSelectedRolePermissions] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (selectedRole) {
      loadRolePermissions(selectedRole);
    }
  }, [selectedRole]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [rolesData, permsData] = await Promise.all([
        usersApi.getRoleHierarchy(),
        usersApi.getPermissionsByCategory(),
      ]);
      setRoles(rolesData);
      setPermissions(permsData);
      // Select first role by default
      if (rolesData.length > 0 && rolesData[0]) {
        setSelectedRole(rolesData[0].code);
      }
    } catch {
      setRoles([]);
      setPermissions({});
      setError('Failed to load roles and permissions. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const loadRolePermissions = async (roleCode: string) => {
    try {
      const perms = await usersApi.getRolePermissions(roleCode);
      setSelectedRolePermissions(perms);
    } catch {
      setSelectedRolePermissions([]);
    }
  };

  const selectedRoleData = roles.find((r) => r.code === selectedRole);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{error}</div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Role Management</h1>
          <p className="mt-1 text-sm text-gray-500">System roles and permissions hierarchy</p>
        </div>
      </div>

      {/* Role Hierarchy Visualization */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Role Hierarchy</h3>
        <div className="relative">
          {/* Hierarchy Tree */}
          <div className="flex flex-col space-y-2">
            {roles.map((role) => (
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
                  className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
                  style={{ backgroundColor: role.color }}
                >
                  {role.level}
                </div>

                {/* Role Info */}
                <div className="ml-4 flex-grow">
                  <div className="flex items-center">
                    <span className="font-semibold text-gray-900">{role.name}</span>
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
                  {role.permissionMode === 'all' ? (
                    <>
                      <span className="text-2xl font-bold text-gray-700">
                        {role.permissionCount}
                      </span>
                      <p className="text-xs text-gray-500">all capabilities</p>
                    </>
                  ) : (
                    <p className="text-sm font-medium text-gray-600">Tenant assigned</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Role Details */}
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Role Details</h3>
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
                <label className="text-sm font-medium text-gray-500">Hierarchy Level</label>
                <div className="flex items-center mt-1">
                  <div className="flex-grow bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full"
                      style={{ width: `${selectedRoleData.level}%` }}
                    ></div>
                  </div>
                  <span className="ml-2 text-sm font-medium">{selectedRoleData.level}</span>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Description</label>
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
          {selectedRoleData?.permissionMode === 'assigned' && (
            <p className="mb-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              Capabilities for this platform role are assigned by each tenant. This catalogue lists
              grantable capabilities, not a static grant set.
            </p>
          )}
          <div className="space-y-6 max-h-[500px] overflow-y-auto">
            {Object.entries(permissions).map(([category, perms]) => (
              <div key={category}>
                <h4 className="text-sm font-medium text-gray-700 mb-2 flex items-center">
                  <span className="w-3 h-3 bg-blue-500 rounded-full mr-2"></span>
                  {category}
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {perms.map((permission) => {
                    const hasPermission = selectedRolePermissions.includes(permission.code);
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
                              hasPermission ? 'bg-green-500 text-white' : 'bg-gray-300'
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
        </Card>
      </div>

      {/* Role Assignment Info — derived from the API role authority. */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Role Assignment Rules</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {roles.map((role) => (
            <div key={role.code} className="rounded-lg bg-gray-50 p-4">
              <h4 className="font-semibold text-gray-800">
                {role.name} ({role.level})
              </h4>
              <p className="mt-1 text-sm text-gray-700">{role.description}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

export default RoleManagementPage;
