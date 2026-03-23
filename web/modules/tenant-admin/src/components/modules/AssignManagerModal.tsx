import React, { useState, useMemo } from 'react';
import {
  CheckCircle,
  Search,
  Shield,
  RefreshCw,
} from 'lucide-react';
import { useAssignModuleManager, useTenantUsers } from '../../hooks/useTenantData';
import { logError, sanitizeErrorMessage } from '../../utils/error-handling';
import type { DisplayModule } from './ModuleCard';

/**
 * Assign Manager Modal -- search and select a user to manage a module.
 */
const AssignManagerModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  module: DisplayModule | null;
}> = ({ isOpen, onClose, module }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  const { data: tenantUsersData, isLoading: loading } = useTenantUsers();
  const assignMutation = useAssignModuleManager();

  const users = useMemo(() => {
    return (tenantUsersData || []).map((u) => ({
      id: u.id,
      name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
      email: u.email,
    }));
  }, [tenantUsersData]);

  if (!isOpen || !module) return null;

  const filteredUsers = users.filter(
    (user) =>
      user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.email.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleConfirm = async () => {
    if (!selectedUserId || !module) return;
    setAssignError(null);
    try {
      await assignMutation.mutateAsync({ moduleId: module.id, userId: selectedUserId });
      setSelectedUserId(null);
      onClose();
    } catch (err) {
      logError('AssignManagerModal', err);
      setAssignError(sanitizeErrorMessage(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative min-h-screen flex items-center justify-center p-4">
        <div className="relative w-full max-w-md bg-white rounded-xl shadow-xl">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-lg font-semibold text-gray-900">Assign Module Manager</h3>
            <p className="text-sm text-gray-500 mt-1">
              Select a user to manage &quot;{module.name}&quot;
            </p>
          </div>
          <div className="px-6 py-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                placeholder="Search users..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
              />
            </div>
          </div>
          {assignError && (
            <div className="px-6 pb-2">
              <p className="text-sm text-red-600">{assignError}</p>
            </div>
          )}
          <div className="px-6 pb-4 max-h-64 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="w-6 h-6 animate-spin text-gray-500" />
              </div>
            ) : (
              <div className="space-y-2">
                {filteredUsers.map((user) => (
                  <button
                    key={user.id}
                    onClick={() => setSelectedUserId(user.id)}
                    className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left ${
                      selectedUserId === user.id
                        ? 'bg-tenant-100 ring-2 ring-tenant-500'
                        : 'hover:bg-tenant-50'
                    }`}
                  >
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-tenant-500 to-tenant-700 flex items-center justify-center text-white text-sm font-medium">
                      {user.name.split(' ').map((n) => n[0]).join('').substring(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{user.name}</p>
                      <p className="text-xs text-gray-500 truncate">{user.email}</p>
                    </div>
                    {selectedUserId === user.id ? (
                      <CheckCircle className="w-4 h-4 text-tenant-600" />
                    ) : (
                      <Shield className="w-4 h-4 text-gray-500" />
                    )}
                  </button>
                ))}
                {filteredUsers.length === 0 && !loading && (
                  <p className="text-center text-sm text-gray-500 py-4">No users found</p>
                )}
              </div>
            )}
          </div>
          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!selectedUserId || assignMutation.isPending}
              className="px-4 py-2 text-sm font-medium text-white bg-tenant-600 hover:bg-tenant-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {assignMutation.isPending && <RefreshCw className="w-4 h-4 animate-spin" />}
              Assign Manager
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AssignManagerModal;
