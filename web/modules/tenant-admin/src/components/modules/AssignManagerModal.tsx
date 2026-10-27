import React, { useState, useMemo } from 'react';
import { CheckCircle, Search, Shield, RefreshCw } from 'lucide-react';
import { Modal, Button } from '@aquaculture/shared-ui';
import { useAssignModuleManager, useTenantUsers } from '../../hooks/useTenantData';
import { logError, sanitizeErrorMessage } from '../../utils/error-handling';
import { UserAvatar } from '../ui/UserAvatar';
import type { DisplayModule } from './ModuleCard';

/**
 * Assign Manager Modal -- search and select a user to manage a module. The choice becomes the
 * module's primary manager grant, named by the module code (PKG-06); the user's account role is
 * left as it is.
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
    // PKG-06: only an owner module has a manager, named by its code (never its catalogue id).
    if (!selectedUserId || !module || module.ownerModule === null) return;
    setAssignError(null);
    try {
      await assignMutation.mutateAsync({
        moduleCode: module.ownerModule,
        userId: selectedUserId,
      });
      setSelectedUserId(null);
      onClose();
    } catch (err) {
      logError('AssignManagerModal', err);
      setAssignError(sanitizeErrorMessage(err));
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title="Assign Module Manager"
      description={<>Select a user to manage &quot;{module.name}&quot;</>}
      showCloseButton={!assignMutation.isPending}
      closeOnEscape={!assignMutation.isPending}
      closeOnOverlayClick={!assignMutation.isPending}
      bodyClassName=""
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={!selectedUserId || assignMutation.isPending}
          >
            {assignMutation.isPending && <RefreshCw className="w-4 h-4 animate-spin" />}
            Assign Manager
          </Button>
        </>
      }
    >
      <div className="px-6 py-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
          <input
            type="text"
            placeholder="Search users..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>
      {assignError && (
        <div className="px-6 pb-2">
          <p className="text-sm text-error-600 dark:text-error-400">{assignError}</p>
        </div>
      )}
      <div className="px-6 pb-4 max-h-64 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="w-6 h-6 animate-spin text-gray-500 dark:text-gray-400" />
          </div>
        ) : (
          <div className="space-y-2">
            {filteredUsers.map((user) => (
              <button
                key={user.id}
                onClick={() => setSelectedUserId(user.id)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left ${
                  selectedUserId === user.id
                    ? 'bg-primary-100 dark:bg-primary-900/40 ring-2 ring-primary-500'
                    : 'hover:bg-primary-50 dark:hover:bg-primary-900/30'
                }`}
              >
                <UserAvatar name={user.name} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {user.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
                </div>
                {selectedUserId === user.id ? (
                  <CheckCircle className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                ) : (
                  <Shield className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                )}
              </button>
            ))}
            {filteredUsers.length === 0 && !loading && (
              <p className="text-center text-sm text-gray-500 dark:text-gray-400 py-4">
                No users found
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default AssignManagerModal;
