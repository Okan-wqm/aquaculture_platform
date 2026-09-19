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
import {
  Card,
  Button,
  Badge,
  DataTable,
  type DataTableColumn,
  PageHeader,
} from '@aquaculture/shared-ui';
import { messagingApi, type MessagingAuditEntry } from '../../services/adminApi';
import type { ApiError } from '../../services/http-client';
import { expectedTotalPages } from '@platform/pagination-contracts';
import { saveBlob } from '../../services/blob-client';
import { Clipboard } from 'lucide-react';

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
  send: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  edit: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  delete: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  create_channel: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  join_channel: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  leave_channel: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  upload_file: 'bg-primary-100 dark:bg-primary-900/40 text-primary-800 dark:text-primary-200',
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

  const handleFilterChange = useCallback((field: keyof AuditFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [field]: value }));
    setPage(1);
  }, []);

  const handleResetFilters = useCallback(() => {
    setFilters(INITIAL_FILTERS);
    setPage(1);
  }, []);

  const handleExportCsv = useCallback(() => {
    if (entries.length === 0) return;

    const headers = [
      'Timestamp',
      'Tenant',
      'User',
      'Action',
      'Details',
      'Channel ID',
      'Message ID',
    ];
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
    saveBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
      `messaging-audit-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  }, [entries]);

  const totalPages = expectedTotalPages(total, PAGE_SIZE);

  const messagingAuditEntryColumns: DataTableColumn<MessagingAuditEntry>[] = [
    {
      key: 'timestamp',
      header: 'Timestamp',
      render: (_value, entry) => new Date(entry.timestamp).toLocaleString(),
    },
    {
      key: 'tenant',
      header: 'Tenant',
      render: (_value, entry) => (
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{entry.tenantName}</p>
      ),
    },
    {
      key: 'user',
      header: 'User',
      render: (_value, entry) => (
        <>
          <p className="text-sm text-gray-700 dark:text-gray-300">{entry.userName}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 font-mono">
            {entry.userId.slice(0, 8)}...
          </p>
        </>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (_value, entry) => (
        <>
          <span
            className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
              ACTION_COLORS[entry.action] ??
              'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
            }`}
          >
            {entry.action.replace(/_/g, ' ')}
          </span>
        </>
      ),
    },
    {
      key: 'details',
      header: 'Details',
      render: (_value, entry) => entry.details,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Messaging Audit Log"
        description="Audit trail of all messaging operations across tenants"
        actions={
          <div className="flex items-center gap-3">
            <Button
              onClick={handleExportCsv}
              variant="secondary"
              size="sm"
              disabled={entries.length === 0}
            >
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
        }
      />

      {/* Error Banner */}
      {error && (
        <div className="p-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg">
          <p className="text-sm text-error-700 dark:text-error-300">{error}</p>
        </div>
      )}

      {/* Filters */}
      <Card>
        <div className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Tenant ID
              </label>
              <input
                type="text"
                placeholder="Filter by tenant..."
                value={filters.tenantId}
                onChange={(e) => handleFilterChange('tenantId', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                User ID
              </label>
              <input
                type="text"
                placeholder="Filter by user..."
                value={filters.userId}
                onChange={(e) => handleFilterChange('userId', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Action
              </label>
              <select
                value={filters.action}
                onChange={(e) => handleFilterChange('action', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden"
              >
                {ACTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Start Date
              </label>
              <input
                type="date"
                value={filters.startDate}
                onChange={(e) => handleFilterChange('startDate', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                End Date
              </label>
              <input
                type="date"
                value={filters.endDate}
                onChange={(e) => handleFilterChange('endDate', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden"
              />
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={handleResetFilters}
              className="text-sm text-info-600 dark:text-info-400 hover:text-info-800 dark:hover:text-info-200 font-medium"
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
                <Clipboard className="w-12 h-12 text-gray-300 mx-auto mb-3" aria-hidden="true" />
                <p className="text-sm text-gray-500 dark:text-gray-400">No audit entries found.</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  Audit entries will appear once messaging activity begins.
                </p>
              </div>
            </div>
          ) : (
            <DataTable<MessagingAuditEntry>
              data={entries}
              columns={messagingAuditEntryColumns}
              keyExtractor={(entry) => entry.id}
              emptyMessage="No audit entries"
              searchable={false}
              sortable={false}
              stickyHeader={false}
              className="shadow-none rounded-none"
            />
          )}
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Showing {(page - 1) * PAGE_SIZE + 1} to {Math.min(page * PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
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
