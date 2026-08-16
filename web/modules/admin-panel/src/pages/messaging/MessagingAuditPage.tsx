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
import { Card, Button } from '@aquaculture/shared-ui';
import { messagingApi, type MessagingAuditEntry } from '../../services/adminApi';
import type { ApiError } from '../../services/http-client';

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
  { value: 'message_send', label: 'Send Message' },
  { value: 'message_edit', label: 'Edit Message' },
  { value: 'message_delete', label: 'Delete Message' },
  { value: 'channel_create', label: 'Create Channel' },
  { value: 'channel_archive', label: 'Archive Channel' },
  { value: 'member_add', label: 'Add Member' },
  { value: 'member_remove', label: 'Remove Member' },
  { value: 'message_export', label: 'Export Messages' },
  { value: 'data_anonymize', label: 'Anonymize Data' },
  { value: 'retention_set', label: 'Set Retention' },
  { value: 'legal_hold_toggle', label: 'Toggle Legal Hold' },
];

const ACTION_COLORS: Record<string, string> = {
  message_send: 'bg-blue-100 text-blue-800',
  message_edit: 'bg-yellow-100 text-yellow-800',
  message_delete: 'bg-red-100 text-red-800',
  channel_create: 'bg-green-100 text-green-800',
  channel_archive: 'bg-gray-100 text-gray-800',
  member_add: 'bg-purple-100 text-purple-800',
  member_remove: 'bg-orange-100 text-orange-800',
  message_export: 'bg-indigo-100 text-indigo-800',
  data_anonymize: 'bg-red-100 text-red-800',
  retention_set: 'bg-teal-100 text-teal-800',
  legal_hold_toggle: 'bg-amber-100 text-amber-800',
};

const INITIAL_FILTERS: AuditFilters = {
  tenantId: '',
  userId: '',
  action: '',
  startDate: '',
  endDate: '',
};

const PAGE_SIZE = 25;

function auditDetails(entry: MessagingAuditEntry): string {
  return entry.details ? JSON.stringify(entry.details) : '';
}

// ============================================================================
// Main Component
// ============================================================================

const MessagingAuditPage: React.FC = () => {
  const [entries, setEntries] = useState<readonly MessagingAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AuditFilters>(INITIAL_FILTERS);
  const [cursorStack, setCursorStack] = useState<readonly (string | null)[]>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const page = cursorStack.length;
  const currentCursor = cursorStack[cursorStack.length - 1] ?? null;

  const fetchAuditLog = useCallback(async () => {
    if (!filters.tenantId) {
      setEntries([]);
      setTotal(0);
      setNextCursor(null);
      setHasMore(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await messagingApi.getAuditLog({
        tenantId: filters.tenantId,
        userId: filters.userId || undefined,
        action: filters.action || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
        cursor: currentCursor,
        limit: PAGE_SIZE,
      });
      setEntries(result.items);
      setTotal(result.totalCount);
      setNextCursor(result.cursor);
      setHasMore(result.hasMore);
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message || 'Failed to fetch messaging audit log');
    } finally {
      setLoading(false);
    }
  }, [currentCursor, filters]);

  useEffect(() => {
    void fetchAuditLog();
  }, [fetchAuditLog]);

  const handleFilterChange = useCallback(
    (field: keyof AuditFilters, value: string) => {
      setFilters((prev) => ({ ...prev, [field]: value }));
      setCursorStack([null]);
    },
    [],
  );

  const handleResetFilters = useCallback(() => {
    setFilters(INITIAL_FILTERS);
    setCursorStack([null]);
  }, []);

  const handleExportCsv = useCallback(() => {
    if (entries.length === 0) return;

    const headers = [
      'Timestamp',
      'Tenant ID',
      'User ID',
      'Action',
      'Details',
      'Resource Type',
      'Resource ID',
    ];
    const rows = entries.map((e) => [
      e.createdAt,
      e.tenantId,
      e.userId,
      e.action,
      `"${auditDetails(e).replace(/"/g, '""')}"`,
      e.resourceType,
      e.resourceId,
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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Audit Log</h1>
          <p className="text-sm text-gray-500 mt-1">
            Tenant-scoped audit trail of messaging operations
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
                <p className="text-sm text-gray-500">
                  {filters.tenantId ? 'No audit entries found.' : 'Enter a tenant ID to query.'}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {filters.tenantId
                    ? 'Audit entries will appear once messaging activity begins.'
                    : 'The messaging audit store is tenant-isolated and cannot be queried globally.'}
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
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-mono text-gray-900">{entry.tenantId}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-mono text-gray-700">{entry.userId}</p>
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
                      {auditDetails(entry)}
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
                onClick={() =>
                  setCursorStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack))
                }
                disabled={page <= 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => {
                  if (nextCursor) setCursorStack((stack) => [...stack, nextCursor]);
                }}
                disabled={!hasMore || nextCursor === null}
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
