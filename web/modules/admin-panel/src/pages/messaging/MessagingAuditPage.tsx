/**
 * Messaging Audit Page
 *
 * Audit log for messaging operations for SUPER_ADMIN.
 * Filterable by tenant, user, action type, and date range with CSV export.
 * Wired to real admin API: GET /messaging/audit
 *
 * @see ADR-012 Phase 3
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';
import { messagingApi, type MessagingAuditEntry } from '../../services/adminApi';
import type { ApiError } from '../../services/http-client';
import { expectedTotalPages } from '@platform/pagination-contracts';

// ============================================================================
// Types
// ============================================================================

interface AuditFilters {
  tenantId: string;
  userId: string;
  action: string;
  startDate: string;
  endDate: string;
}

// ============================================================================
// Constants
// ============================================================================

const ACTION_OPTIONS = [
  { value: '', label: 'All Actions' },
  { value: 'send', label: 'Send Message' },
  { value: 'edit', label: 'Edit Message' },
  { value: 'delete', label: 'Delete Message' },
  { value: 'create_channel', label: 'Create Channel' },
  { value: 'join_channel', label: 'Join Channel' },
  { value: 'leave_channel', label: 'Leave Channel' },
  { value: 'upload_file', label: 'Upload File' },
];

const ACTION_COLORS: Record<string, string> = {
  send: 'bg-blue-100 text-blue-800',
  edit: 'bg-yellow-100 text-yellow-800',
  delete: 'bg-red-100 text-red-800',
  create_channel: 'bg-green-100 text-green-800',
  join_channel: 'bg-purple-100 text-purple-800',
  leave_channel: 'bg-gray-100 text-gray-800',
  upload_file: 'bg-indigo-100 text-indigo-800',
};

const INITIAL_FILTERS: AuditFilters = {
  tenantId: '',
  userId: '',
  action: '',
  startDate: '',
  endDate: '',
};

const PAGE_SIZE = 25;

// ============================================================================
// Main Component
// ============================================================================

const MessagingAuditPage: React.FC = () => {
  const [entries, setEntries] = useState<readonly MessagingAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AuditFilters>(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const fetchAuditLog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await messagingApi.getAuditLog({
        tenantId: filters.tenantId || undefined,
        userId: filters.userId || undefined,
        action: filters.action || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setEntries(result.data);
      setTotal(result.total);
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message || 'Failed to fetch messaging audit log');
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    void fetchAuditLog();
  }, [fetchAuditLog]);

  const handleFilterChange = useCallback(
    (field: keyof AuditFilters, value: string) => {
      setFilters((prev) => ({ ...prev, [field]: value }));
      setPage(1);
    },
    [],
  );

  const handleResetFilters = useCallback(() => {
    setFilters(INITIAL_FILTERS);
    setPage(1);
  }, []);

  const handleExportCsv = useCallback(() => {
    if (entries.length === 0) return;

    const headers = ['Timestamp', 'Tenant', 'User', 'Action', 'Details', 'Channel ID', 'Message ID'];
    const rows = entries.map((e) => [
      e.timestamp,
      e.tenantName,
      e.userName,
      e.action,
      `"${e.details.replace(/"/g, '""')}"`,
      e.channelId ?? '',
      e.messageId ?? '',
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `messaging-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [entries]);

  const totalPages = expectedTotalPages(total, PAGE_SIZE);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Audit Log</h1>
          <p className="text-sm text-gray-500 mt-1">
            Audit trail of all messaging operations across tenants
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleExportCsv} variant="secondary" size="sm" disabled={entries.length === 0}>
            Export CSV
          </Button>
          <Button
            onClick={() => void fetchAuditLog()}
            disabled={loading}
            variant="secondary"
            size="sm"
          >
            {loading ? 'Loading...' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Filters */}
      <Card>
        <div className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Tenant ID</label>
              <input
                type="text"
                placeholder="Filter by tenant..."
                value={filters.tenantId}
                onChange={(e) => handleFilterChange('tenantId', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">User ID</label>
              <input
                type="text"
                placeholder="Filter by user..."
                value={filters.userId}
                onChange={(e) => handleFilterChange('userId', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Action</label>
              <select
                value={filters.action}
                onChange={(e) => handleFilterChange('action', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
              >
                {ACTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Start Date</label>
              <input
                type="date"
                value={filters.startDate}
                onChange={(e) => handleFilterChange('startDate', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">End Date</label>
              <input
                type="date"
                value={filters.endDate}
                onChange={(e) => handleFilterChange('endDate', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
              />
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={handleResetFilters}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              Reset Filters
            </button>
          </div>
        </div>
      </Card>

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          {entries.length === 0 && !loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="text-center">
                <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <p className="text-sm text-gray-500">No audit entries found.</p>
                <p className="text-xs text-gray-400 mt-1">
                  Audit entries will appear once messaging activity begins.
                </p>
              </div>
            </div>
          ) : (
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Timestamp
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tenant
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Action
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900">{entry.tenantName}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm text-gray-700">{entry.userName}</p>
                      <p className="text-xs text-gray-400 font-mono">{entry.userId.slice(0, 8)}...</p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                          ACTION_COLORS[entry.action] ?? 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {entry.action.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">
                      {entry.details}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
            <p className="text-sm text-gray-500">
              Showing {(page - 1) * PAGE_SIZE + 1} to {Math.min(page * PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
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

export default MessagingAuditPage;
