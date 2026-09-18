/**
 * Error Tracking Page
 *
 * Enterprise-grade error tracking and monitoring with real API integration.
 * Provides comprehensive error management, filtering, and resolution workflows.
 *
 * Sprint 3 Fix (Grup Q / H27-35): Import fixed (systemApi -> systemSettingsApi),
 * all commented API calls activated.
 */

import React, { useMemo, useState } from 'react';
import { Card, Button, Badge, Input, Select } from '@aquaculture/shared-ui';

import { systemSettingsApi } from '../../services/adminApi';
import { adminKeys, useAdminMutation, useAdminQuery } from '../../hooks';
import { QueryFailureNotice } from '../../components';
import type { ErrorGroup, ErrorOccurrence } from '../../services/adminApi';

// ============================================================================
// Types
// ============================================================================

/**
 * What the error dashboard reports, with `null` for anything it could not
 * (ADMIN-HIGH-128).
 *
 * These four were seeded as zeros and RESET to zeros by the catch, so a failed
 * `/system/errors/dashboard` displayed "0 unresolved errors" and "0 critical"
 * on the screen an operator opens to find out whether anything is broken.
 */
interface ErrorStats {
  totalErrors: number | null;
  unresolvedErrors: number | null;
  criticalErrors: number | null;
  todayErrors: number | null;
}

/** What a card shows for a count the platform did not read. */
const UNKNOWN = '\u2014';

const formatCount = (value: number | null | undefined): string =>
  value === null || value === undefined ? UNKNOWN : new Intl.NumberFormat('en-US').format(value);

const EMPTY_GROUPS: readonly ErrorGroup[] = [];
const EMPTY_OCCURRENCES: readonly ErrorOccurrence[] = [];

// ============================================================================
// No Mock Data - Using Real API Only
// ============================================================================

// ============================================================================
// Component
// ============================================================================

export const ErrorTrackingPage: React.FC = () => {
  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterSeverity, setFilterSeverity] = useState<string>('all');
  const [filterService, setFilterService] = useState<string>('all');
  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({
    start: '',
    end: '',
  });

  // Detail Modal
  const [selectedErrorId, setSelectedErrorId] = useState<string | null>(null);

  // ==========================================================================
  // Reads (ADMIN-HIGH-121)
  // ==========================================================================

  const groupFilter = useMemo(
    () => ({
      status: filterStatus !== 'all' ? filterStatus : undefined,
      severity: filterSeverity !== 'all' ? filterSeverity : undefined,
      service: filterService !== 'all' ? filterService : undefined,
      search: searchTerm || undefined,
      startDate: dateRange.start || undefined,
      endDate: dateRange.end || undefined,
    }),
    [filterStatus, filterSeverity, filterService, searchTerm, dateRange],
  );

  const errorsKey = [...adminKeys.system.all(), 'errors'];

  const groupsQuery = useAdminQuery(
    [...errorsKey, 'groups', groupFilter],
    ({ signal }) => systemSettingsApi.getErrorGroups(groupFilter, signal),
    { placeholderData: (previous) => previous },
  );

  const dashboardQuery = useAdminQuery([...errorsKey, 'dashboard'], ({ signal }) =>
    systemSettingsApi.getErrorDashboard(signal),
  );

  const occurrencesQuery = useAdminQuery(
    [...errorsKey, 'occurrences', selectedErrorId],
    ({ signal }) =>
      systemSettingsApi.getErrorOccurrences(selectedErrorId ?? '', undefined, signal),
    { enabled: selectedErrorId !== null },
  );

  const errorGroups: readonly ErrorGroup[] = groupsQuery.data?.data ?? EMPTY_GROUPS;
  const errorOccurrences: readonly ErrorOccurrence[] =
    occurrencesQuery.data?.data ?? EMPTY_OCCURRENCES;
  const loadingOccurrences = occurrencesQuery.isFetching;

  /**
   * The four counts, or `null` for a dashboard that did not answer.
   *
   * `todayErrors` is the last point of the trend series: absent when the
   * series is, rather than the 0 the old expression produced for an empty
   * one, which said "no errors today" about a window nobody had measured.
   */
  const dashboardData = dashboardQuery.data ?? null;
  const trend = dashboardData?.errorTrend ?? [];
  const stats: ErrorStats = {
    totalErrors: dashboardData?.totalErrors ?? null,
    unresolvedErrors: dashboardData?.unresolvedErrors ?? null,
    criticalErrors: dashboardData?.criticalErrors ?? null,
    todayErrors: trend.length > 0 ? (trend[trend.length - 1]?.count ?? null) : null,
  };

  const selectedError =
    errorGroups.find((group) => group.id === selectedErrorId) ??
    (selectedErrorId === null ? null : (groupsQuery.data?.data ?? []).find((g) => g.id === selectedErrorId) ?? null);

  // ==========================================================================
  // Writes — both slices, because both move (ADMIN-HIGH-121)
  //
  // Each handler used to splice the updated group into local state AND
  // decrement `unresolvedErrors` by one by hand. That is arithmetic on a
  // server-computed aggregate: if the action did not change that count — an
  // already-acknowledged group, a different definition of "unresolved" — the
  // card drifted further from the truth with every click, and nothing on the
  // page ever corrected it.
  // ==========================================================================

  const invalidateErrors = { invalidateKeys: [errorsKey] };

  const resolveError = useAdminMutation<ErrorGroup, string>(
    (id) => systemSettingsApi.resolveError(id, 'admin'),
    invalidateErrors,
  );

  const ignoreError = useAdminMutation<ErrorGroup, string>(
    (id) => systemSettingsApi.ignoreError(id),
    invalidateErrors,
  );

  const acknowledgeError = useAdminMutation<ErrorGroup, string>(
    (id) => systemSettingsApi.updateErrorStatus(id, 'acknowledged'),
    invalidateErrors,
  );

  const mutations = [resolveError, ignoreError, acknowledgeError];
  const queryErrors = [
    groupsQuery.error,
    dashboardQuery.error,
    occurrencesQuery.error,
    ...mutations.map((mutation) => mutation.error),
  ];
  const loading = groupsQuery.isPending;
  const hasContent = groupsQuery.data !== undefined || dashboardQuery.data !== undefined;

  const loadData = (): void => {
    void groupsQuery.refetch();
    void dashboardQuery.refetch();
  };

  const loadErrorDetails = (errorGroup: ErrorGroup): void => {
    setSelectedErrorId(errorGroup.id);
  };

  const handleResolve = async (): Promise<void> => {
    if (!selectedError) return;
    try {
      await resolveError.mutateAsync(selectedError.id);
    } catch {
      // `resolveError.error` carries it into the page's notice.
    }
  };

  const handleIgnore = async (): Promise<void> => {
    if (!selectedError) return;
    try {
      await ignoreError.mutateAsync(selectedError.id);
    } catch {
      // Reported through `ignoreError.error`.
    }
  };

  const handleAcknowledge = async (): Promise<void> => {
    if (!selectedError) return;
    try {
      await acknowledgeError.mutateAsync(selectedError.id);
    } catch {
      // Reported through `acknowledgeError.error`.
    }
  };

  // ============================================================================
  // Helpers
  // ============================================================================

  const services = [...new Set(errorGroups.map((e) => e.service).filter(Boolean))];

  const getSeverityBadge = (severity: string): 'default' | 'info' | 'success' | 'warning' | 'error' => {
    const variants: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
      debug: 'default',
      info: 'info',
      warning: 'warning',
      error: 'warning',
      critical: 'error',
      fatal: 'error',
    };
    return variants[severity] || 'default';
  };

  const getStatusBadge = (status: string): 'default' | 'info' | 'success' | 'warning' | 'error' => {
    const variants: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
      new: 'info',
      acknowledged: 'warning',
      in_progress: 'warning',
      resolved: 'success',
      ignored: 'default',
    };
    return variants[status] || 'default';
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatRelativeTime = (date: string) => {
    const diff = Date.now() - new Date(date).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  // ============================================================================
  // Render
  // ============================================================================

  if (loading && !hasContent) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-gray-200 rounded w-1/4" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white rounded-xl p-6 h-24" />
          ))}
        </div>
        <div className="bg-white rounded-xl p-6 h-96" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Error Tracking</h1>
          <p className="mt-1 text-sm text-gray-500">
            Monitor and manage application errors across all services
          </p>
        </div>
        <Button onClick={() => loadData()} variant="secondary">
          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </Button>
      </div>

      {/* Whichever read or action failed, named. The page used to report a
          failure in a fixed toast at the bottom-right while four zeroed cards
          sat at the top (ADMIN-HIGH-128). */}
      <QueryFailureNotice errors={queryErrors} hasContent={hasContent} onRetry={loadData} />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="text-2xl font-bold text-gray-900">{formatCount(stats.totalErrors)}</div>
          <div className="text-sm text-gray-500">Total Errors</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-orange-600">{formatCount(stats.unresolvedErrors)}</div>
          <div className="text-sm text-gray-500">Unresolved</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-red-600">{formatCount(stats.criticalErrors)}</div>
          <div className="text-sm text-gray-500">Critical</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-blue-600">{formatCount(stats.todayErrors)}</div>
          <div className="text-sm text-gray-500">Today's Errors</div>
        </Card>
      </div>

      {/* Filters */}
      <Card className="p-4">
        <div className="space-y-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <Input
                placeholder="Search errors by message, type, or service..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full"
              />
            </div>
            <Select
              value={filterSeverity}
              onChange={(e) => setFilterSeverity(e.target.value)}
              options={[
                { value: 'all', label: 'All Severities' },
                { value: 'debug', label: 'Debug' },
                { value: 'info', label: 'Info' },
                { value: 'warning', label: 'Warning' },
                { value: 'error', label: 'Error' },
                { value: 'critical', label: 'Critical' },
                { value: 'fatal', label: 'Fatal' },
              ]}
            />
            <Select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              options={[
                { value: 'all', label: 'All Statuses' },
                { value: 'new', label: 'New' },
                { value: 'acknowledged', label: 'Acknowledged' },
                { value: 'in_progress', label: 'In Progress' },
                { value: 'resolved', label: 'Resolved' },
                { value: 'ignored', label: 'Ignored' },
              ]}
            />
            <Select
              value={filterService}
              onChange={(e) => setFilterService(e.target.value)}
              options={[
                { value: 'all', label: 'All Services' },
                ...services.map((s) => ({ value: s!, label: s! })),
              ]}
            />
          </div>
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
              <Input
                type="date"
                value={dateRange.start}
                onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
              <Input
                type="date"
                value={dateRange.end}
                onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Error List */}
      <Card className="overflow-hidden">
        {errorGroups.length === 0 ? (
          <div className="p-12 text-center">
            <svg className="mx-auto h-12 w-12 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-gray-900">No errors found</h3>
            <p className="mt-1 text-sm text-gray-500">
              {searchTerm || filterStatus !== 'all' || filterSeverity !== 'all' || filterService !== 'all'
                ? 'Try adjusting your filters'
                : 'All systems are running smoothly'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {errorGroups.map((errorGroup) => (
              <div
                key={errorGroup.id}
                className="p-6 hover:bg-gray-50 cursor-pointer transition-colors"
                onClick={() => loadErrorDetails(errorGroup)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    {/* Header with badges */}
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <Badge variant={getSeverityBadge(errorGroup.severity)} size="sm">
                        {errorGroup.severity.toUpperCase()}
                      </Badge>
                      <Badge variant={getStatusBadge(errorGroup.status)} size="sm">
                        {errorGroup.status.replace('_', ' ')}
                      </Badge>
                      {errorGroup.isRegression && (
                        <Badge variant="error" size="sm">
                          Regression
                        </Badge>
                      )}
                      {errorGroup.service && (
                        <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-gray-100 text-gray-700">
                          {errorGroup.service}
                        </span>
                      )}
                    </div>

                    {/* Error message */}
                    <h3 className="font-mono text-sm text-gray-900 mb-2 line-clamp-2">
                      {errorGroup.errorType && (
                        <span className="text-red-600 font-semibold">{errorGroup.errorType}: </span>
                      )}
                      {errorGroup.message}
                    </h3>

                    {/* Metadata */}
                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      <span>First seen {formatRelativeTime(errorGroup.firstSeenAt)}</span>
                      <span>Last seen {formatRelativeTime(errorGroup.lastSeenAt)}</span>
                      {errorGroup.assignedTo && (
                        <span className="flex items-center gap-1">
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                          </svg>
                          {errorGroup.assignedTo}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="ml-6 flex-shrink-0 text-right">
                    <div className="text-2xl font-bold text-gray-900">{errorGroup.occurrenceCount.toLocaleString()}</div>
                    <div className="text-xs text-gray-500">occurrences</div>
                    <div className="mt-2 text-sm text-gray-600">
                      {errorGroup.affectedTenants?.length ?? 0} tenants
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Error Detail Modal */}
      {selectedError && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-5xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              {/* Modal Header */}
              <div className="flex justify-between items-start mb-6">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-3">
                    <Badge variant={getSeverityBadge(selectedError.severity)}>
                      {selectedError.severity.toUpperCase()}
                    </Badge>
                    <Badge variant={getStatusBadge(selectedError.status)}>
                      {selectedError.status.replace('_', ' ')}
                    </Badge>
                    {selectedError.isRegression && <Badge variant="error">Regression</Badge>}
                  </div>
                  <h2 className="text-xl font-bold text-gray-900 font-mono">
                    {selectedError.errorType && (
                      <span className="text-red-600">{selectedError.errorType}: </span>
                    )}
                    {selectedError.message}
                  </h2>
                </div>
                <button
                  onClick={() => {
                    // Closing the modal disables the occurrences query; its
                    // cache entry stays keyed by the group id.
                    setSelectedErrorId(null);
                  }}
                  className="ml-4 text-gray-500 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-500 mb-1">Occurrences</div>
                  <div className="text-2xl font-bold text-gray-900">
                    {selectedError.occurrenceCount.toLocaleString()}
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-500 mb-1">Affected Tenants</div>
                  <div className="text-2xl font-bold text-gray-900">
                    {selectedError.affectedTenants?.length ?? 0}
                  </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-500 mb-1">Service</div>
                  <div className="text-lg font-bold text-gray-900">{selectedError.service || 'N/A'}</div>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="text-sm text-gray-500 mb-1">Fingerprint</div>
                  <div className="text-xs font-mono text-gray-900">{selectedError.fingerprint}</div>
                </div>
              </div>

              {/* Timeline */}
              <div className="mb-6 p-4 bg-blue-50 rounded-lg">
                <div className="flex justify-between text-sm">
                  <div>
                    <span className="text-gray-600">First seen:</span>
                    <span className="ml-2 font-medium text-gray-900">{formatDate(selectedError.firstSeenAt)}</span>
                  </div>
                  <div>
                    <span className="text-gray-600">Last seen:</span>
                    <span className="ml-2 font-medium text-gray-900">{formatDate(selectedError.lastSeenAt)}</span>
                  </div>
                  {selectedError.assignedTo && (
                    <div>
                      <span className="text-gray-600">Assigned to:</span>
                      <span className="ml-2 font-medium text-gray-900">{selectedError.assignedTo}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Stack Trace */}
              <div className="mb-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Stack Trace</h3>
                {loadingOccurrences ? (
                  <div className="bg-gray-900 text-gray-100 p-4 rounded-lg text-sm animate-pulse">
                    Loading stack trace...
                  </div>
                ) : errorOccurrences.length > 0 && errorOccurrences[0].stackTrace ? (
                  <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-xs overflow-x-auto leading-relaxed">
                    {errorOccurrences[0].stackTrace}
                  </pre>
                ) : (
                  <div className="bg-gray-100 text-gray-600 p-4 rounded-lg text-sm text-center">
                    No stack trace available
                  </div>
                )}
              </div>

              {/* Recent Occurrences */}
              {errorOccurrences.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Occurrences</h3>
                  <div className="border border-gray-200 rounded-lg divide-y">
                    {errorOccurrences.slice(0, 5).map((occurrence) => (
                      <div key={occurrence.id} className="p-3 hover:bg-gray-50">
                        <div className="flex justify-between items-start text-xs">
                          <div className="flex-1">
                            <div className="text-gray-900 font-medium mb-1">
                              {formatDate(occurrence.timestamp)}
                            </div>
                            <div className="flex gap-3 text-gray-500">
                              {occurrence.tenantId && <span>Tenant: {occurrence.tenantId}</span>}
                              {occurrence.userId && <span>User: {occurrence.userId}</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-3 pt-4 border-t">
                {selectedError.status !== 'acknowledged' && (
                  <Button onClick={handleAcknowledge} variant="primary">
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Acknowledge
                  </Button>
                )}
                {selectedError.status !== 'resolved' && (
                  <Button onClick={handleResolve} variant="success">
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Mark Resolved
                  </Button>
                )}
                {selectedError.status !== 'ignored' && (
                  <Button onClick={handleIgnore} variant="secondary">
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                    Ignore
                  </Button>
                )}
                <Button
                  onClick={() => {
                    // Closing the modal disables the occurrences query; its
                    // cache entry stays keyed by the group id.
                    setSelectedErrorId(null);
                  }}
                  variant="secondary"
                >
                  Close
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

    </div>
  );
};

export default ErrorTrackingPage;
