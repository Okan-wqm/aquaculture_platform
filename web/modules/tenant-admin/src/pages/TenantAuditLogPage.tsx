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
import {
  Badge,
  Button,
  DataTable,
  Input,
  Modal,
  PageHeader,
  Select,
  ToggleButton,
  type DataTableColumn,
} from '@aquaculture/shared-ui';

// ============================================================================
// Sub-Components
// ============================================================================

/**
 * Severity badge with color coding
 */
const SeverityBadge: React.FC<{ severity: string }> = ({ severity }) => {
  // FE-HIGH-079: severity on the shared-ui Badge scale; critical keeps its own icon.
  const config: Record<string, { variant: 'info' | 'warning' | 'error'; icon: React.ReactNode }> = {
    info: { variant: 'info', icon: <Info className="w-3 h-3" /> },
    warning: { variant: 'warning', icon: <AlertTriangle className="w-3 h-3" /> },
    error: { variant: 'error', icon: <XCircle className="w-3 h-3" /> },
    critical: { variant: 'error', icon: <Zap className="w-3 h-3" /> },
  };
  const c = config[severity] || config.info;
  return (
    <Badge variant={c.variant} size="sm" className="gap-1">
      {c.icon}
      {severity.charAt(0).toUpperCase() + severity.slice(1)}
    </Badge>
  );
};

/**
 * Action badge
 */
const ActionBadge: React.FC<{ action: string }> = ({ action }) => {
  // FE-HIGH-079: creates are success, deletes error, updates info, sign-ins outlined.
  const lower = action.toLowerCase();
  let variant: 'default' | 'success' | 'error' | 'info' | 'outline' = 'default';
  if (lower.includes('create') || lower.includes('add')) variant = 'success';
  else if (lower.includes('delete') || lower.includes('remove')) variant = 'error';
  else if (lower.includes('update') || lower.includes('edit') || lower.includes('modify'))
    variant = 'info';
  else if (lower.includes('login') || lower.includes('auth')) variant = 'outline';
  return (
    <Badge variant={variant} size="sm">
      {action.replace(/_/g, ' ')}
    </Badge>
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
        <Button variant="secondary" type="button" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
            Timestamp
          </label>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">
            {new Date(entry.createdAt).toLocaleString()}
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
            Severity
          </label>
          <div className="mt-0.5">
            <SeverityBadge severity={entry.severity} />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
            Action
          </label>
          <div className="mt-0.5">
            <ActionBadge action={entry.action} />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
            User
          </label>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">
            {entry.performedByEmail || entry.performedBy}
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
            IP Address
          </label>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5 font-mono">
            {entry.ipAddress || 'N/A'}
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
            Entity
          </label>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-0.5">
            {entry.entityType}
            {entry.entityId ? ` / ${entry.entityId.slice(0, 8)}...` : ''}
          </p>
        </div>
      </div>
      {entry.userAgent && (
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
            User Agent
          </label>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 break-all font-mono bg-gray-50 dark:bg-gray-800 p-2 rounded">
            {entry.userAgent}
          </p>
        </div>
      )}
      {entry.details && Object.keys(entry.details).length > 0 && (
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
            Details
          </label>
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
          (e.performedByEmail || e.performedBy)
            .toLowerCase()
            .includes(debouncedSearch.toLowerCase()) ||
          e.entityType.toLowerCase().includes(debouncedSearch.toLowerCase()),
      )
    : entries;

  const hasActiveFilters =
    filters.startDate ||
    filters.endDate ||
    filters.action ||
    filters.severity ||
    filters.performedBy;

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
      render: (_value, entry) => <ActionBadge action={entry.action} />,
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
      render: (_value, entry) => <SeverityBadge severity={entry.severity} />,
    },
    {
      key: 'details',
      header: 'Details',
      align: 'right',
      render: (_value, entry) => (
        <>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="View details"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedEntry(entry);
            }}
            title="View details"
          >
            <Eye className="w-4 h-4" />
          </Button>
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Audit Log"
        description="Review all actions and changes within your tenant"
        actions={
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh"
              onClick={refresh}
              disabled={isFetching}
              title="Refresh"
            >
              <RefreshCw
                className={`w-5 h-5 text-gray-500 dark:text-gray-400 ${isFetching ? 'animate-spin' : ''}`}
              />
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Download className="w-4 h-4" />}
              onClick={exportCsv}
              disabled={entries.length === 0}
            >
              Export CSV
            </Button>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                showFilters || hasActiveFilters
                  ? 'text-success-700 dark:text-success-300 bg-success-50 dark:bg-success-900/20 border border-success-200 dark:border-success-800'
                  : 'text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              <Filter className="w-4 h-4" />
              Filters
              {hasActiveFilters && <span className="w-2 h-2 rounded-full bg-success-500" />}
            </button>
          </div>
        }
      />

      {/* Error Message */}
      {error && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-error-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-error-800 dark:text-error-200">
              Failed to load audit logs
            </p>
            <p className="text-sm text-error-600 dark:text-error-400">{(error as Error).message}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      {/* Filters Panel */}
      {showFilters && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Filter Audit Logs
            </h3>
            {hasActiveFilters && (
              <Button variant="ghost" size="xs" onClick={resetFilters}>
                Clear all
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Start Date
              </label>
              <Input
                fullWidth
                type="date"
                value={filters.startDate || ''}
                onChange={(e) => updateFilters({ startDate: e.target.value || null })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                End Date
              </label>
              <Input
                fullWidth
                type="date"
                value={filters.endDate || ''}
                onChange={(e) => updateFilters({ endDate: e.target.value || null })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Action
              </label>
              <Input
                fullWidth
                type="text"
                placeholder="e.g. USER_CREATE"
                value={filters.action || ''}
                onChange={(e) => updateFilters({ action: e.target.value || null })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                Severity
              </label>
              <Select
                fullWidth
                options={[
                  { value: '', label: 'All' },
                  { value: 'info', label: 'Info' },
                  { value: 'warning', label: 'Warning' },
                  { value: 'error', label: 'Error' },
                  { value: 'critical', label: 'Critical' },
                ]}
                value={filters.severity || ''}
                onChange={(e) => updateFilters({ severity: e.target.value || null })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                User
              </label>
              <Input
                fullWidth
                type="text"
                placeholder="Email or ID"
                value={filters.performedBy || ''}
                onChange={(e) => updateFilters({ performedBy: e.target.value || null })}
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
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:outline-hidden focus:ring-2 focus:ring-success-500 focus:border-transparent"
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
                <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-gray-100">
                  No audit log entries found
                </h3>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {hasActiveFilters
                    ? 'Try adjusting your filters to see more results.'
                    : 'Audit log entries will appear here as actions are performed.'}
                </p>
                {hasActiveFilters && (
                  <Button variant="ghost" className="mt-4" onClick={resetFilters}>
                    Clear Filters
                  </Button>
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
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<ChevronLeft className="w-4 h-4" />}
                  onClick={prevPage}
                  disabled={page <= 1}
                >
                  Previous
                </Button>

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
                      <ToggleButton
                        key={pageNum}
                        onClick={() => goToPage(pageNum)}
                        pressed={page === pageNum}
                        className="w-8 h-8 text-sm rounded-lg transition-colors"
                        pressedClassName="bg-success-600 text-white"
                        idleClassName="text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        {pageNum}
                      </ToggleButton>
                    );
                  })}
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  rightIcon={<ChevronRight className="w-4 h-4" />}
                  onClick={nextPage}
                  disabled={page >= totalPages}
                >
                  Next
                </Button>
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
