/**
 * Messaging Tenants Page
 *
 * Per-tenant messaging management for SUPER_ADMIN.
 * Table with tenant breakdown, search/filter, pagination, and actions.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

interface TenantMessaging {
  tenantId: string;
  tenantName: string;
  totalChannels: number;
  totalMessages: number;
  activeUsers: number;
  storageUsedMB: number;
  messagingEnabled: boolean;
  lastActivity: string;
}

interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
}

// ============================================================================
// Constants
// ============================================================================

const PAGE_SIZES = [10, 25, 50];

// ============================================================================
// Mock Data (TODO: Replace with admin API calls)
// ============================================================================

const MOCK_TENANTS: TenantMessaging[] = [];

// ============================================================================
// Main Component
// ============================================================================

const MessagingTenantsPage: React.FC = () => {
  const [tenants, setTenants] = useState<TenantMessaging[]>(MOCK_TENANTS);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    pageSize: 10,
    total: 0,
  });

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    try {
      // TODO: Replace with actual admin API call
      // const res = await adminApi.get('/admin/messaging/tenants', {
      //   params: { page: pagination.page, pageSize: pagination.pageSize, search },
      // });
      // setTenants(res.data.items);
      // setPagination(prev => ({ ...prev, total: res.data.total }));

      setTenants(MOCK_TENANTS);
      setPagination((prev) => ({ ...prev, total: 0 }));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch messaging tenants:', error);
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, search]);

  useEffect(() => {
    void fetchTenants();
  }, [fetchTenants]);

  const filteredTenants = useMemo(() => {
    if (!search.trim()) return tenants;
    const q = search.toLowerCase();
    return tenants.filter(
      (t) =>
        t.tenantName.toLowerCase().includes(q) ||
        t.tenantId.toLowerCase().includes(q),
    );
  }, [tenants, search]);

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));

  const handleToggleMessaging = useCallback(
    async (tenantId: string, enabled: boolean) => {
      try {
        // TODO: Replace with actual admin API call
        // await adminApi.patch(`/admin/messaging/tenants/${tenantId}`, { messagingEnabled: enabled });
        setTenants((prev) =>
          prev.map((t) =>
            t.tenantId === tenantId ? { ...t, messagingEnabled: enabled } : t,
          ),
        );
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to toggle messaging:', error);
      }
    },
    [],
  );

  const handleExport = useCallback(async (tenantId: string) => {
    try {
      // TODO: Replace with actual admin API call
      // const res = await adminApi.get(`/admin/messaging/tenants/${tenantId}/export`, {
      //   responseType: 'blob',
      // });
      // Download blob
      // eslint-disable-next-line no-console
      console.log('Export requested for tenant:', tenantId);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to export:', error);
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Tenants</h1>
          <p className="text-sm text-gray-500 mt-1">
            Per-tenant messaging management and controls
          </p>
        </div>
        <Button
          onClick={() => void fetchTenants()}
          disabled={loading}
          variant="secondary"
          size="sm"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {/* Search & Filter */}
      <Card>
        <div className="p-4 flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <div className="flex-1 w-full">
            <input
              type="text"
              placeholder="Search by tenant name or ID..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPagination((prev) => ({ ...prev, page: 1 }));
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <span>Show</span>
            <select
              value={pagination.pageSize}
              onChange={(e) =>
                setPagination((prev) => ({
                  ...prev,
                  pageSize: Number(e.target.value),
                  page: 1,
                }))
              }
              className="border border-gray-300 rounded px-2 py-1 text-sm"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            <span>per page</span>
          </div>
        </div>
      </Card>

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          {filteredTenants.length === 0 && !loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="text-center">
                <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-sm text-gray-500">No tenants with messaging data found.</p>
              </div>
            </div>
          ) : (
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tenant
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Channels
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Messages
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Active Users
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Storage (MB)
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredTenants.map((t) => (
                  <tr key={t.tenantId} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{t.tenantName}</p>
                        <p className="text-xs text-gray-400 font-mono">{t.tenantId.slice(0, 8)}...</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-right">{t.totalChannels}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-right">
                      {t.totalMessages.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-right">{t.activeUsers}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-right">
                      {t.storageUsedMB.toFixed(1)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={t.messagingEnabled ? 'success' : 'error'}>
                        {t.messagingEnabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => void handleToggleMessaging(t.tenantId, !t.messagingEnabled)}
                          className={`text-xs px-2 py-1 rounded font-medium ${
                            t.messagingEnabled
                              ? 'text-red-600 hover:bg-red-50'
                              : 'text-green-600 hover:bg-green-50'
                          }`}
                        >
                          {t.messagingEnabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => void handleExport(t.tenantId)}
                          className="text-xs px-2 py-1 rounded font-medium text-blue-600 hover:bg-blue-50"
                        >
                          Export
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {pagination.total > pagination.pageSize && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
            <p className="text-sm text-gray-500">
              Showing {(pagination.page - 1) * pagination.pageSize + 1} to{' '}
              {Math.min(pagination.page * pagination.pageSize, pagination.total)} of{' '}
              {pagination.total}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPagination((prev) => ({ ...prev, page: prev.page - 1 }))}
                disabled={pagination.page <= 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-gray-600">
                Page {pagination.page} of {totalPages}
              </span>
              <button
                onClick={() => setPagination((prev) => ({ ...prev, page: prev.page + 1 }))}
                disabled={pagination.page >= totalPages}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

export default MessagingTenantsPage;
