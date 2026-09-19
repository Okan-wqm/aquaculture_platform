/**
 * TenantAuditLogPage
 *
 * Displays audit log entries for the current tenant with server-side
 * filtering, pagination, and CSV export.
 *
 * SEC-007: Protected by RequireTenantAdmin guard in Module.tsx.
 * Read-only page -- no mutations.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Shield,
  Search,
  Download,
  RefreshCw,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Filter,
  Info,
  AlertTriangle,
  XCircle,
  Zap,
  Calendar,
  Eye,
} from 'lucide-react';
import { useTenantAuditLog, type AuditLogEntry } from '../hooks/useTenantAuditLog';
import { Modal, DataTable, type DataTableColumn, PageHeader } from '@aquaculture/shared-ui';

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Severity badge with color coding
 */
const SeverityBadge: React.FC<{ severity: string }> = ({ severity }) => {
  const config: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
    info: {
      bg: 'bg-blue-100',
      text: 'text-blue-700',
      icon: <Info className="w-3 h-3" />,
    },
    warning: {
      bg: 'bg-yellow-100',
      text: 'text-yellow-700',
      icon: <AlertTriangle className="w-3 h-3" />,
    },
    error: {
      bg: 'bg-red-100',
      text: 'text-red-700',
      icon: <XCircle className="w-3 h-3" />,
    },
    critical: {
      bg: 'bg-red-200',
      text: 'text-red-900',
      icon: <Zap className="w-3 h-3" />,
    },
  };

  const c = config[severity] || config.info;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      {c.icon}
      {severity.charAt(0).toUpperCase() + severity.slice(1)}
    </span>
  );
};

/**
 * Action badge
 */
const ActionBadge: React.FC<{ action: string }> = ({ action }) => {
  // Color-code common actions
  let bg = 'bg-gray-100 dark:bg-gray-800';
  let text = 'text-gray-700 dark:text-gray-300';
  const lower = action.toLowerCase();
  if (lower.includes('create') || lower.includes('add')) {
    bg = 'bg-green-100';
    text = 'text-green-700';
  } else if (lower.includes('delete') || lower.includes('remove')) {
    bg = 'bg-red-100';
    text = 'text-red-700';
  } else if (lower.includes('update') || lower.includes('edit') || lower.includes('modify')) {
    bg = 'bg-blue-100';
    text = 'text-blue-700';
  } else if (lower.includes('login') || lower.includes('auth')) {
    bg = 'bg-purple-100';
    text = 'text-purple-700';
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${bg} ${text}`}>
      {action.replace(/_/g, ' ')}
    </span>
  );
};

/**
 * Details modal
 */
const DetailsModal: React.FC<{
  entry: AuditLogEntry | null;
  onClose: () => void;
}> = ({ entry, onClose }) => {
  if (!entry) return null;

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title="Audit Log Details"
      className="max-h-[80vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          Close
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Timestamp</label>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">
            {new Date(entry.createdAt).toLocaleString()}
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Severity</label>
          <div className="mt-0.5">
            <SeverityBadge severity={entry.severity} />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Action</label>
          <div className="mt-0.5">
            <ActionBadge action={entry.action} />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">User</label>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">
            {entry.performedByEmail || entry.performedBy}
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">IP Address</label>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5 font-mono">{entry.ipAddress || 'N/A'}</p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Entity</label>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">
            {entry.entityType}{entry.entityId ? ` / ${entry.entityId.slice(0, 8)}...` : ''}
          </p>
        </div>
      </div>
      {entry.userAgent && (
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">User Agent</label>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 break-all font-mono bg-gray-50 dark:bg-gray-800 p-2 rounded">
            {entry.userAgent}
          </p>
        </div>
      )}
      {entry.details && Object.keys(entry.details).length > 0 && (
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Details</label>
          <pre className="text-xs text-gray-700 dark:text-gray-300 mt-0.5 bg-gray-50 dark:bg-gray-800 p-3 rounded-lg overflow-auto max-h-48 font-mono">
            {JSON.stringify(entry.details, null, 2)}
          </pre>
        </div>
      )}
    </Modal>
  );
};

// ============================================================================
// Skeleton Loading
// ============================================================================

const TableSkeleton: React.FC = () => (
  <div className="animate-pulse">
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="flex items-center gap-4 px-6 py-4 border-b border-gray-50">
        <div className="w-36 h-4 bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="w-24 h-5 bg-gray-200 dark:bg-gray-700 rounded-full" />
        <div className="w-32 h-4 bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="w-24 h-4 bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="w-16 h-5 bg-gray-200 dark:bg-gray-700 rounded-full" />
        <div className="flex-1" />
        <div className="w-8 h-8 bg-gray-200 dark:bg-gray-700 rounded" />
      </div>
    ))}
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

const TenantAuditLogPage: React.FC = () => {
  const {
    entries,
    total,
    totalPages,
    page,
    filters,
    isLoading,
    isFetching,
    error,
    updateFilters,
    resetFilters,
    goToPage,
    nextPage,
    prevPage,
    refresh,
    exportCsv,
  } = useTenantAuditLog(20);

  const [showFilters, setShowFilters] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);

  // Debounce search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  // Client-side filter on search (server handles the rest)
  const visibleEntries = debouncedSearch
    ? entries.filter(
        (e) =>
          e.action.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          (e.performedByEmail || e.performedBy).toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          e.entityType.toLowerCase().includes(debouncedSearch.toLowerCase())
      )
    : entries;

  const hasActiveFilters =
    filters.startDate || filters.endDate || filters.action || filters.severity || filters.performedBy;

  const auditLogEntryColumns: DataTableColumn<AuditLogEntry>[] = [
    {
      key: 'timestamp',
      header: 'Timestamp',
      render: (_value, entry) => (
        <div className="flex items-center gap-2">
          <Calendar className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400 hidden sm:block" />
          <div>
            <p className="text-sm text-gray-900 dark:text-gray-100">
              {new Date(entry.createdAt).toLocaleDateString()}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {new Date(entry.createdAt).toLocaleTimeString()}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (_value, entry) => (
        <ActionBadge action={entry.action} />
      ),
    },
    {
      key: 'user',
      header: 'User',
      render: (_value, entry) => (
        <p className="text-sm text-gray-900 dark:text-gray-100 truncate max-w-[200px]">
          {entry.performedByEmail || entry.performedBy}
        </p>
      ),
    },
    {
      key: 'ipAddress',
      header: 'IP Address',
      render: (_value, entry) => (
        <span className="text-sm text-gray-500 dark:text-gray-400 font-mono">
          {entry.ipAddress || '--'}
        </span>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      render: (_value, entry) => (
        <SeverityBadge severity={entry.severity} />
      ),
    },
    {
      key: 'details',
      header: 'Details',
      align: 'right',
      render: (_value, entry) => (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSelectedEntry(entry);
            }}
            className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:text-tenant-600 hover:bg-tenant-50 transition-colors"
            title="View details"
          >
            <Eye className="w-4 h-4" />
          </button>
        </>
      ),
    }
  ];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Audit Log"
        description="Review all actions and changes within your tenant"
        actions={
          <div className="flex items-center gap-3">
            <button
              onClick={refresh}
              disabled={isFetching}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-5 h-5 text-gray-500 dark:text-gray-400 ${isFetching ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={exportCsv}
              disabled={entries.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </button>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                showFilters || hasActiveFilters
                  ? 'text-tenant-700 bg-tenant-50 border border-tenant-200'
                  : 'text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              <Filter className="w-4 h-4" />
              Filters
              {hasActiveFilters && (
                <span className="w-2 h-2 rounded-full bg-tenant-500" />
              )}
            </button>
          </div>
        }
      />

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">Failed to load audit logs</p>
            <p className="text-sm text-red-600">{(error as Error).message}</p>
          </div>
          <button
            onClick={refresh}
            className="ml-auto px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Filters Panel */}
      {showFilters && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Filter Audit Logs</h3>
            {hasActiveFilters && (
              <button
                onClick={resetFilters}
                className="text-xs text-tenant-600 hover:text-tenant-700 font-medium"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Start Date</label>
              <input
                type="date"
                value={filters.startDate || ''}
                onChange={(e) => updateFilters({ startDate: e.target.value || null })}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">End Date</label>
              <input
                type="date"
                value={filters.endDate || ''}
                onChange={(e) => updateFilters({ endDate: e.target.value || null })}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Action</label>
              <input
                type="text"
                placeholder="e.g. USER_CREATE"
                value={filters.action || ''}
                onChange={(e) => updateFilters({ action: e.target.value || null })}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Severity</label>
              <select
                value={filters.severity || ''}
                onChange={(e) => updateFilters({ severity: e.target.value || null })}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
              >
                <option value="">All</option>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="error">Error</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">User</label>
              <input
                type="text"
                placeholder="Email or ID"
                value={filters.performedBy || ''}
                onChange={(e) => updateFilters({ performedBy: e.target.value || null })}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500"
              />
            </div>
          </div>
        </div>
      )}

      {/* Search Bar */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
          <input
            type="text"
            placeholder="Search audit logs by action, user, or entity..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-tenant-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 overflow-hidden">
        {isLoading ? (
          <TableSkeleton />
        ) : (
          <>
            <DataTable<AuditLogEntry>
              data={visibleEntries}
              columns={auditLogEntryColumns}
              keyExtractor={(entry) => entry.id}
              emptyMessage="No audit entries"
              searchable={false}
              sortable={false}
              stickyHeader={false}
              className="shadow-none rounded-none"
            />

            {/* Empty State */}
            {visibleEntries.length === 0 && !isLoading && (
              <div className="py-12 text-center">
                <Shield className="w-12 h-12 text-gray-500 dark:text-gray-400 mx-auto" />
                <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-gray-100">No audit log entries found</h3>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {hasActiveFilters
                    ? 'Try adjusting your filters to see more results.'
                    : 'Audit log entries will appear here as actions are performed.'}
                </p>
                {hasActiveFilters && (
                  <button
                    onClick={resetFilters}
                    className="mt-4 px-4 py-2 text-sm font-medium text-tenant-600 hover:bg-tenant-50 rounded-lg transition-colors"
                  >
                    Clear Filters
                  </button>
                )}
              </div>
            )}

            {/* Pagination */}
            <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700 flex flex-col sm:flex-row items-center justify-between gap-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Showing {visibleEntries.length} of {total} entries
                {totalPages > 1 && ` (Page ${page} of ${totalPages})`}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={prevPage}
                  disabled={page <= 1}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </button>

                {/* Page numbers */}
                <div className="hidden sm:flex items-center gap-1">
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let pageNum: number;
                    if (totalPages <= 5) {
                      pageNum = i + 1;
                    } else if (page <= 3) {
                      pageNum = i + 1;
                    } else if (page >= totalPages - 2) {
                      pageNum = totalPages - 4 + i;
                    } else {
                      pageNum = page - 2 + i;
                    }
                    return (
                      <button
                        key={pageNum}
                        onClick={() => goToPage(pageNum)}
                        className={`w-8 h-8 text-sm rounded-lg transition-colors ${
                          page === pageNum
                            ? 'bg-tenant-600 text-white'
                            : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                        }`}
                      >
                        {pageNum}
                      </button>
                    );
                  })}
                </div>

                <button
                  onClick={nextPage}
                  disabled={page >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Details Modal */}
      <DetailsModal entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
    </div>
  );
};

export default TenantAuditLogPage;
