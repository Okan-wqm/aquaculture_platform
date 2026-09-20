/**
 * Activity Log Page
 *
 * Comprehensive activity logging interface with filtering, search, and real-time updates.
 */

import {
  Activity,
  Search,
  Filter,
  Download,
  RefreshCw,
  Eye,
  User,
  Server,
  Globe,
  Database,
  Shield,
  Clock,
  MapPin,
  Monitor,
  AlertTriangle,
  Info,
  AlertCircle,
  XCircle,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import {
  DataTable,
  Modal,
  PageHeader,
  Select,
  ToggleButton,
  type DataTableColumn,
} from '@aquaculture/shared-ui';

import { securityApi } from '../../services/adminApi';
import { adminKeys, useAdminQuery } from '../../hooks';
import { QueryFailureNotice } from '../../components';
import { saveBlob } from '../../services/blob-client';

// ============================================================================
// Types
// ============================================================================

type ActivityCategory =
  | 'user_action'
  | 'system_event'
  | 'api_call'
  | 'data_access'
  | 'security_event'
  | 'configuration'
  | 'authentication';

type ActivitySeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

interface GeoLocation {
  country?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}

interface ActivityLog {
  id: string;
  category: ActivityCategory;
  action: string;
  severity: ActivitySeverity;
  tenantId?: string;
  tenantName?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  geoLocation?: GeoLocation;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  duration?: number;
  success: boolean;
  errorMessage?: string;
  createdAt: string;
}

interface ActivityStats {
  totalActivities: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  uniqueUsers: number;
  uniqueIps: number;
  averageResponseTime: number;
  errorRate: number;
}

// ============================================================================
// API Service - Using centralized securityApi with auth headers
// ============================================================================

/** One page of activity rows. */
const ACTIVITY_PAGE_SIZE = 50;

/**
 * A stable empty array. `?? []` would hand a NEW array on every render, so
 * every memo and effect keyed on `activities` would see a changed reference
 * while nothing about the data changed.
 */
const EMPTY_ACTIVITIES: readonly ActivityLog[] = [];

async function fetchActivities(
  params: {
    page?: number;
    limit?: number;
    category?: string;
    severity?: string;
    searchQuery?: string;
    startDate?: string;
    endDate?: string;
  },
  signal?: AbortSignal,
): Promise<{ data: ActivityLog[]; total: number; page: number; limit: number }> {
  const apiParams: Record<string, unknown> = {};
  if (params.page) apiParams.page = params.page;
  if (params.limit) apiParams.limit = params.limit;
  if (params.category && params.category !== 'all') apiParams.category = params.category;
  if (params.severity && params.severity !== 'all') apiParams.severity = params.severity;
  if (params.searchQuery) apiParams.searchQuery = params.searchQuery;
  if (params.startDate) apiParams.startDate = params.startDate;
  if (params.endDate) apiParams.endDate = params.endDate;

  const result = await securityApi.getActivityLogs(apiParams, signal);
  return {
    data: result.data.map((log) => ({
      id: log.id,
      category: log.category,
      action: log.action,
      severity: log.severity,
      tenantId: log.tenantId ?? undefined,
      tenantName: log.tenantName ?? undefined,
      userId: log.userId ?? undefined,
      userName: log.userName ?? undefined,
      userEmail: log.userEmail ?? undefined,
      ipAddress: log.ipAddress ?? undefined,
      userAgent: log.userAgent ?? undefined,
      geoLocation: log.geoLocation ?? log.location,
      entityType: log.entityType ?? undefined,
      entityId: log.entityId ?? undefined,
      entityName: log.entityName ?? undefined,
      previousValue: log.previousValue ?? undefined,
      newValue: log.newValue ?? undefined,
      metadata: log.metadata ?? undefined,
      duration: log.duration ?? undefined,
      success: log.success,
      errorMessage: log.errorMessage ?? undefined,
      createdAt: log.createdAt || log.timestamp || '',
    })),
    total: result.total,
    page: result.page,
    limit: result.limit,
  };
}

async function fetchActivityStats(signal?: AbortSignal): Promise<ActivityStats> {
  const stats = await securityApi.getActivityStatsOverview(signal);
  const failedCount = stats.bySuccess.failure ?? 0;
  return {
    totalActivities: stats.totalActivities,
    byCategory: stats.byCategory,
    bySeverity: stats.bySeverity,
    uniqueUsers: stats.topUsers.length,
    uniqueIps: stats.topIPs.length,
    averageResponseTime: 0,
    errorRate: stats.totalActivities > 0 ? (failedCount / stats.totalActivities) * 100 : 0,
  };
}

// ============================================================================
// Components
// ============================================================================

const getCategoryIcon = (category: ActivityCategory): React.ReactElement => {
  switch (category) {
    case 'user_action':
      return <User className="w-4 h-4" />;
    case 'system_event':
      return <Server className="w-4 h-4" />;
    case 'api_call':
      return <Globe className="w-4 h-4" />;
    case 'data_access':
      return <Database className="w-4 h-4" />;
    case 'security_event':
      return <Shield className="w-4 h-4" />;
    case 'configuration':
      return <Monitor className="w-4 h-4" />;
    default:
      return <Activity className="w-4 h-4" />;
  }
};

const getCategoryColor = (category: ActivityCategory): string => {
  switch (category) {
    case 'user_action':
      return 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200';
    case 'system_event':
      return 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200';
    case 'api_call':
      return 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200';
    case 'data_access':
      return 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200';
    case 'security_event':
      return 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200';
    case 'configuration':
      return 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200';
    default:
      return 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200';
  }
};

const getSeverityIcon = (severity: ActivitySeverity): React.ReactElement => {
  switch (severity) {
    case 'critical':
      return <XCircle className="w-4 h-4 text-error-600 dark:text-error-400" />;
    case 'error':
      return <AlertCircle className="w-4 h-4 text-accent-600 dark:text-accent-400" />;
    case 'warning':
      return <AlertTriangle className="w-4 h-4 text-warning-600 dark:text-warning-400" />;
    case 'debug':
      return <Info className="w-4 h-4 text-info-600 dark:text-info-400" />;
    default:
      return <Info className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
  }
};

const getSeverityColor = (severity: ActivitySeverity): string => {
  switch (severity) {
    case 'critical':
      return 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200 border-error-200 dark:border-error-800';
    case 'error':
      return 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200 border-accent-200 dark:border-accent-800';
    case 'warning':
      return 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200 border-warning-200 dark:border-warning-800';
    case 'debug':
      return 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200 border-info-200 dark:border-info-800';
    default:
      return 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 border-gray-200 dark:border-gray-700';
  }
};

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

const formatTimeAgo = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};

// Activity Detail Modal
const ActivityDetailModal: React.FC<{
  activity: ActivityLog;
  onClose: () => void;
}> = ({ activity, onClose }) => {
  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title="Activity Details"
      bodyClassName="p-6 space-y-6"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          Close
        </button>
      }
    >
      {/* Basic Info */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <span className="text-sm font-medium text-gray-500 dark:text-gray-400">ID</span>
          <p className="text-sm text-gray-900 dark:text-gray-100 font-mono">{activity.id}</p>
        </div>
        <div>
          <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Timestamp</span>
          <p className="text-sm text-gray-900 dark:text-gray-100">
            {formatDate(activity.createdAt)}
          </p>
        </div>
        <div>
          <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Category</span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getCategoryColor(activity.category)}`}
          >
            {getCategoryIcon(activity.category)}
            {activity.category.replace('_', ' ')}
          </span>
        </div>
        <div>
          <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Severity</span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(activity.severity)}`}
          >
            {getSeverityIcon(activity.severity)}
            {activity.severity}
          </span>
        </div>
      </div>

      {/* Action */}
      <div>
        <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Action</span>
        <p className="text-sm text-gray-900 dark:text-gray-100">{activity.action}</p>
      </div>

      {/* User Info */}
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          User Information
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400">User</span>
            <p className="text-sm text-gray-900 dark:text-gray-100">{activity.userName || 'N/A'}</p>
          </div>
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400">Email</span>
            <p className="text-sm text-gray-900 dark:text-gray-100">
              {activity.userEmail || 'N/A'}
            </p>
          </div>
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400">Tenant</span>
            <p className="text-sm text-gray-900 dark:text-gray-100">
              {activity.tenantName || 'N/A'}
            </p>
          </div>
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400">IP Address</span>
            <p className="text-sm text-gray-900 dark:text-gray-100 font-mono">
              {activity.ipAddress || 'N/A'}
            </p>
          </div>
        </div>
      </div>

      {/* Location */}
      {activity.geoLocation && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
            <MapPin className="w-4 h-4" />
            Location
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400">Country</span>
              <p className="text-sm text-gray-900 dark:text-gray-100">
                {activity.geoLocation.country || 'N/A'}
              </p>
            </div>
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400">City</span>
              <p className="text-sm text-gray-900 dark:text-gray-100">
                {activity.geoLocation.city || 'N/A'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Target Entity */}
      {activity.entityType && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            Target Entity
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400">Type</span>
              <p className="text-sm text-gray-900 dark:text-gray-100">{activity.entityType}</p>
            </div>
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400">ID</span>
              <p className="text-sm text-gray-900 dark:text-gray-100 font-mono">
                {activity.entityId}
              </p>
            </div>
            <div>
              <span className="text-xs text-gray-500 dark:text-gray-400">Name</span>
              <p className="text-sm text-gray-900 dark:text-gray-100">{activity.entityName}</p>
            </div>
          </div>
        </div>
      )}

      {/* Status */}
      <div className="flex items-center gap-4">
        <div>
          <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Status</span>
          <span
            className={`ml-2 inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
              activity.success
                ? 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200'
                : 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200'
            }`}
          >
            {activity.success ? 'Success' : 'Failed'}
          </span>
        </div>
        {activity.duration !== undefined && (
          <div>
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Duration</span>
            <span className="ml-2 text-sm text-gray-900 dark:text-gray-100">
              {activity.duration}ms
            </span>
          </div>
        )}
      </div>

      {/* Error Message */}
      {activity.errorMessage && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-error-800 dark:text-error-200 mb-2">
            Error Message
          </h3>
          <p className="text-sm text-error-700 dark:text-error-300">{activity.errorMessage}</p>
        </div>
      )}

      {/* User Agent */}
      {activity.userAgent && (
        <div>
          <span className="text-sm font-medium text-gray-500 dark:text-gray-400">User Agent</span>
          <p className="text-xs text-gray-600 dark:text-gray-400 font-mono break-all bg-gray-50 dark:bg-gray-800 p-2 rounded">
            {activity.userAgent}
          </p>
        </div>
      )}
    </Modal>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const ActivityLogPage: React.FC = () => {
  const [selectedActivity, setSelectedActivity] = useState<ActivityLog | null>(null);
  const [page, setPage] = useState(1);
  const limit = ACTIVITY_PAGE_SIZE;

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [showFilters, setShowFilters] = useState(false);

  // The list and the header statistics are two INDEPENDENT queries, which is
  // what `Promise.allSettled` was reaching for by hand: one failing must not
  // blank the other. Each now carries its own error, and the page joins them
  // for display exactly as it did — but a stats outage no longer costs a
  // re-fetch of the list, because they have separate keys and lifetimes.
  const activityFilter = useMemo(
    () => ({
      page,
      limit,
      category: categoryFilter,
      severity: severityFilter,
      searchQuery: searchTerm || undefined,
      startDate: dateRange.start || undefined,
      endDate: dateRange.end || undefined,
    }),
    [page, limit, categoryFilter, severityFilter, searchTerm, dateRange],
  );

  const activityQuery = useAdminQuery(
    [...adminKeys.security.all(), 'activities', activityFilter],
    ({ signal }) => fetchActivities(activityFilter, signal),
    {
      // Every keystroke in the search box is a new key. Without this the table
      // blanks between keys; with it the previous page stays on screen until
      // the next one lands, and the superseded request is aborted rather than
      // left to decode into a view that has moved on.
      placeholderData: (previous) => previous,
      staleTime: 30_000,
    },
  );

  const statsQuery = useAdminQuery(
    [...adminKeys.security.all(), 'activity-stats'],
    ({ signal }) => fetchActivityStats(signal),
    { staleTime: 60_000 },
  );

  const activities = activityQuery.data?.data ?? EMPTY_ACTIVITIES;
  const total = activityQuery.data?.total ?? 0;
  const stats = statsQuery.data ?? null;
  const loading = activityQuery.isPending;
  const error =
    [activityQuery.error?.message, statsQuery.error?.message].filter(Boolean).join('; ') || null;
  const loadData = (): void => {
    void activityQuery.refetch();
    void statsQuery.refetch();
  };

  const handleExport = (): void => {
    const csvContent = [
      ['ID', 'Timestamp', 'Category', 'Action', 'Severity', 'User', 'IP', 'Status'].join(','),
      ...activities.map((a) =>
        [
          a.id,
          formatDate(a.createdAt),
          a.category,
          `"${a.action}"`,
          a.severity,
          a.userName || '',
          a.ipAddress || '',
          a.success ? 'Success' : 'Failed',
        ].join(','),
      ),
    ].join('\n');

    saveBlob(
      new Blob([csvContent], { type: 'text/csv' }),
      `activity-log-${new Date().toISOString().split('T')[0]}.csv`,
    );
  };

  if (loading && activities.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-info-600 dark:text-info-400" />
      </div>
    );
  }

  if (error !== null && activities.length === 0) {
    // The full-page branch of the same component, so the two states cannot
    // drift apart in wording or in what they offer.
    return (
      <QueryFailureNotice
        errors={[activityQuery.error, statsQuery.error]}
        hasContent={false}
        onRetry={loadData}
      />
    );
  }

  const activityColumns: DataTableColumn<ActivityLog>[] = [
    {
      key: 'createdAt',
      header: 'Timestamp',
      render: (_value, activity) => (
        <>
          <div className="text-sm text-gray-900 dark:text-gray-100">
            {formatTimeAgo(activity.createdAt)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {formatDate(activity.createdAt)}
          </div>
        </>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (_value, activity) => (
        <span
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getCategoryColor(activity.category)}`}
        >
          {getCategoryIcon(activity.category)}
          {activity.category.replace('_', ' ')}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (_value, activity) => (
        <div className="text-sm text-gray-900 dark:text-gray-100 max-w-xs truncate">
          {activity.action}
        </div>
      ),
    },
    {
      key: 'userName',
      header: 'User',
      render: (_value, activity) => (
        <>
          <div className="text-sm text-gray-900 dark:text-gray-100">{activity.userName || '-'}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{activity.tenantName}</div>
        </>
      ),
    },
    {
      key: 'ipAddress',
      header: 'IP Address',
      render: (_value, activity) => (
        <span className="text-sm font-mono text-gray-600 dark:text-gray-400">
          {activity.ipAddress || '-'}
        </span>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      render: (_value, activity) => (
        <span
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(activity.severity)}`}
        >
          {getSeverityIcon(activity.severity)}
          {activity.severity}
        </span>
      ),
    },
    {
      key: 'success',
      header: 'Status',
      render: (_value, activity) => (
        <span
          className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
            activity.success
              ? 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200'
              : 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200'
          }`}
        >
          {activity.success ? 'Success' : 'Failed'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, activity) => (
        <button
          type="button"
          onClick={() => setSelectedActivity(activity)}
          className="text-info-600 dark:text-info-400 hover:text-info-800 dark:hover:text-info-200"
          aria-label="View activity"
        >
          <Eye className="w-4 h-4" />
        </button>
      ),
    },
  ];

  const renderActivityDetails = (activity: ActivityLog): React.ReactNode => (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
      <div>
        <span className="text-gray-500 dark:text-gray-400">Target:</span>{' '}
        <span className="text-gray-900 dark:text-gray-100">
          {activity.entityType} - {activity.entityName}
        </span>
      </div>
      <div>
        <span className="text-gray-500 dark:text-gray-400">Duration:</span>{' '}
        <span className="text-gray-900 dark:text-gray-100">{activity.duration}ms</span>
      </div>
      <div>
        <span className="text-gray-500 dark:text-gray-400">Location:</span>{' '}
        <span className="text-gray-900 dark:text-gray-100">
          {activity.geoLocation?.city}, {activity.geoLocation?.country}
        </span>
      </div>
      <div>
        <span className="text-gray-500 dark:text-gray-400">Tenant:</span>{' '}
        <span className="text-gray-900 dark:text-gray-100">{activity.tenantName}</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* One component decides banner-vs-full-page for every admin page
          (ADMIN-HIGH-105) — the condition three pages had each written and
          each got wrong in the same direction. */}
      <QueryFailureNotice
        errors={[activityQuery.error, statsQuery.error]}
        hasContent={activities.length > 0}
        onRetry={loadData}
      />

      {/* Header */}
      <PageHeader
        title="Activity Log"
        description="Monitor all system activities, user actions, and security events"
        actions={
          <div className="flex items-center gap-3">
            <button
              onClick={handleExport}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <Download className="w-4 h-4" />
              Export
            </button>
            <button
              onClick={() => void loadData()}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-info-600 rounded-lg hover:bg-info-700 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        }
      />

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-info-100 dark:bg-info-900/40 rounded-lg">
                <Activity className="w-5 h-5 text-info-600 dark:text-info-400" />
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Total Activities</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {(stats.totalActivities ?? 0).toLocaleString()}
                </p>
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-success-100 dark:bg-success-900/40 rounded-lg">
                <User className="w-5 h-5 text-success-600 dark:text-success-400" />
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Unique Users</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {stats.uniqueUsers ?? 0}
                </p>
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-accent-100 dark:bg-accent-900/40 rounded-lg">
                <Clock className="w-5 h-5 text-accent-600 dark:text-accent-400" />
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Avg Response</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {stats.averageResponseTime ?? 0}ms
                </p>
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-error-100 dark:bg-error-900/40 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-error-600 dark:text-error-400" />
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Error Rate</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {(stats.errorRate ?? 0).toFixed(1)}%
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Search & Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 dark:text-gray-400" />
            <input
              type="text"
              placeholder="Search by action, user, or IP..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-info-500"
            />
          </div>
          <Select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            options={[
              { value: 'all', label: 'All Categories' },
              { value: 'user_action', label: 'User Actions' },
              { value: 'system_event', label: 'System Events' },
              { value: 'api_call', label: 'API Calls' },
              { value: 'data_access', label: 'Data Access' },
              { value: 'security_event', label: 'Security Events' },
              { value: 'configuration', label: 'Config Changes' },
            ]}
          />
          <Select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            options={[
              { value: 'all', label: 'All Severities' },
              { value: 'info', label: 'Info' },
              { value: 'debug', label: 'Debug' },
              { value: 'warning', label: 'Warning' },
              { value: 'error', label: 'Error' },
              { value: 'critical', label: 'Critical' },
            ]}
          />
          <ToggleButton
            onClick={() => setShowFilters(!showFilters)}
            pressed={showFilters}
            className="flex items-center gap-2 px-4 py-2 border rounded-lg"
            pressedClassName="border-info-500 text-info-600 dark:text-info-400 bg-info-50 dark:bg-info-900/20"
            idleClassName="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <Filter className="w-4 h-4" />
            Filters
          </ToggleButton>
        </div>

        {/* Advanced Filters */}
        {showFilters && (
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Start Date
              </span>
              <input
                type="date"
                value={dateRange.start}
                onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-info-500"
              />
            </div>
            <div>
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                End Date
              </span>
              <input
                type="date"
                value={dateRange.end}
                onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-info-500"
              />
            </div>
          </div>
        )}
      </div>

      {/* Activity Table */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <DataTable<ActivityLog>
          data={activities}
          columns={activityColumns}
          keyExtractor={(activity) => activity.id}
          emptyMessage="No activities found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
          compact
          expandable
          renderExpandedRow={renderActivityDetails}
          className="rounded-none shadow-none"
        />

        {/* Pagination */}
        <div className="bg-gray-50 dark:bg-gray-800 px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Showing {activities.length} of {total} activities
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-sm text-gray-600 dark:text-gray-400">Page {page}</span>
            <button
              onClick={() => setPage(page + 1)}
              disabled={activities.length < limit}
              className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Detail Modal */}
      {selectedActivity && (
        <ActivityDetailModal
          activity={selectedActivity}
          onClose={() => setSelectedActivity(null)}
        />
      )}
    </div>
  );
};

export default ActivityLogPage;
