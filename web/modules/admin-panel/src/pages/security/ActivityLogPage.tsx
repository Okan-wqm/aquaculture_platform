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
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Info,
  AlertCircle,
  XCircle,
} from 'lucide-react';
import React, { useState, useEffect, useCallback } from 'react';

import { securityApi } from '../../services/adminApi';

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

async function fetchActivities(params: {
  page?: number;
  limit?: number;
  category?: string;
  severity?: string;
  searchQuery?: string;
  startDate?: string;
  endDate?: string;
}): Promise<{ data: ActivityLog[]; total: number; page: number; limit: number }> {
  const apiParams: Record<string, unknown> = {};
  if (params.page) apiParams.page = params.page;
  if (params.limit) apiParams.limit = params.limit;
  if (params.category && params.category !== 'all') apiParams.category = params.category;
  if (params.severity && params.severity !== 'all') apiParams.severity = params.severity;
  if (params.searchQuery) apiParams.searchQuery = params.searchQuery;
  if (params.startDate) apiParams.startDate = params.startDate;
  if (params.endDate) apiParams.endDate = params.endDate;

  const result = await securityApi.getActivityLogs(apiParams);
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
      // `userAgent` is not a column — it lives inside the `deviceInfo` jsonb,
      // which is where the ingest writes it. This used to read `log.userAgent`
      // and render undefined for every row.
      userAgent: log.deviceInfo?.userAgent,
      // The `?? log.location` fallback was on a field the entity has never had.
      geoLocation: log.geoLocation ?? undefined,
      entityType: log.entityType ?? undefined,
      entityId: log.entityId ?? undefined,
      entityName: log.entityName ?? undefined,
      previousValue: log.previousValue ?? undefined,
      newValue: log.newValue ?? undefined,
      metadata: log.metadata ?? undefined,
      duration: log.duration ?? undefined,
      success: log.success,
      errorMessage: log.errorMessage ?? undefined,
      createdAt: log.createdAt,
    })),
    total: result.total,
    page: result.page,
    limit: result.limit,
  };
}

async function fetchActivityStats(): Promise<ActivityStats> {
  const stats = await securityApi.getActivityStatsOverview();
  const failedCount = stats.bySuccess.failure ?? 0;
  return {
    totalActivities: stats.totalActivities,
    byCategory: stats.byCategory,
    bySeverity: stats.bySeverity,
    uniqueUsers: stats.topUsers.length,
    uniqueIps: stats.topIPs.length,
    averageResponseTime: 0,
    errorRate: stats.totalActivities > 0
      ? (failedCount / stats.totalActivities) * 100
      : 0,
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
      return 'bg-blue-100 text-blue-800';
    case 'system_event':
      return 'bg-purple-100 text-purple-800';
    case 'api_call':
      return 'bg-green-100 text-green-800';
    case 'data_access':
      return 'bg-orange-100 text-orange-800';
    case 'security_event':
      return 'bg-red-100 text-red-800';
    case 'configuration':
      return 'bg-yellow-100 text-yellow-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

const getSeverityIcon = (severity: ActivitySeverity): React.ReactElement => {
  switch (severity) {
    case 'critical':
      return <XCircle className="w-4 h-4 text-red-600" />;
    case 'error':
      return <AlertCircle className="w-4 h-4 text-orange-600" />;
    case 'warning':
      return <AlertTriangle className="w-4 h-4 text-yellow-600" />;
    case 'debug':
      return <Info className="w-4 h-4 text-blue-600" />;
    default:
      return <Info className="w-4 h-4 text-gray-600" />;
  }
};

const getSeverityColor = (severity: ActivitySeverity): string => {
  switch (severity) {
    case 'critical':
      return 'bg-red-100 text-red-800 border-red-200';
    case 'error':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    case 'warning':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    case 'debug':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200';
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">Activity Details</h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-600"
            >
              <XCircle className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-6 space-y-6">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-sm font-medium text-gray-500">ID</span>
              <p className="text-sm text-gray-900 font-mono">{activity.id}</p>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-500">Timestamp</span>
              <p className="text-sm text-gray-900">{formatDate(activity.createdAt)}</p>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-500">Category</span>
              <span
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getCategoryColor(activity.category)}`}
              >
                {getCategoryIcon(activity.category)}
                {activity.category.replace('_', ' ')}
              </span>
            </div>
            <div>
              <span className="text-sm font-medium text-gray-500">Severity</span>
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
            <span className="text-sm font-medium text-gray-500">Action</span>
            <p className="text-sm text-gray-900">{activity.action}</p>
          </div>

          {/* User Info */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">User Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-xs text-gray-500">User</span>
                <p className="text-sm text-gray-900">{activity.userName || 'N/A'}</p>
              </div>
              <div>
                <span className="text-xs text-gray-500">Email</span>
                <p className="text-sm text-gray-900">{activity.userEmail || 'N/A'}</p>
              </div>
              <div>
                <span className="text-xs text-gray-500">Tenant</span>
                <p className="text-sm text-gray-900">{activity.tenantName || 'N/A'}</p>
              </div>
              <div>
                <span className="text-xs text-gray-500">IP Address</span>
                <p className="text-sm text-gray-900 font-mono">{activity.ipAddress || 'N/A'}</p>
              </div>
            </div>
          </div>

          {/* Location */}
          {activity.geoLocation && (
            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                <MapPin className="w-4 h-4" />
                Location
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-xs text-gray-500">Country</span>
                  <p className="text-sm text-gray-900">{activity.geoLocation.country || 'N/A'}</p>
                </div>
                <div>
                  <span className="text-xs text-gray-500">City</span>
                  <p className="text-sm text-gray-900">{activity.geoLocation.city || 'N/A'}</p>
                </div>
              </div>
            </div>
          )}

          {/* Target Entity */}
          {activity.entityType && (
            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-700 mb-3">Target Entity</h3>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <span className="text-xs text-gray-500">Type</span>
                  <p className="text-sm text-gray-900">{activity.entityType}</p>
                </div>
                <div>
                  <span className="text-xs text-gray-500">ID</span>
                  <p className="text-sm text-gray-900 font-mono">{activity.entityId}</p>
                </div>
                <div>
                  <span className="text-xs text-gray-500">Name</span>
                  <p className="text-sm text-gray-900">{activity.entityName}</p>
                </div>
              </div>
            </div>
          )}

          {/* Status */}
          <div className="flex items-center gap-4">
            <div>
              <span className="text-sm font-medium text-gray-500">Status</span>
              <span
                className={`ml-2 inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                  activity.success
                    ? 'bg-green-100 text-green-800'
                    : 'bg-red-100 text-red-800'
                }`}
              >
                {activity.success ? 'Success' : 'Failed'}
              </span>
            </div>
            {activity.duration !== undefined && (
              <div>
                <span className="text-sm font-medium text-gray-500">Duration</span>
                <span className="ml-2 text-sm text-gray-900">{activity.duration}ms</span>
              </div>
            )}
          </div>

          {/* Error Message */}
          {activity.errorMessage && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <h3 className="text-sm font-medium text-red-800 mb-2">Error Message</h3>
              <p className="text-sm text-red-700">{activity.errorMessage}</p>
            </div>
          )}

          {/* User Agent */}
          {activity.userAgent && (
            <div>
              <span className="text-sm font-medium text-gray-500">User Agent</span>
              <p className="text-xs text-gray-600 font-mono break-all bg-gray-50 p-2 rounded">
                {activity.userAgent}
              </p>
            </div>
          )}
        </div>
        <div className="p-6 border-t border-gray-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const ActivityLogPage: React.FC = () => {
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedActivity, setSelectedActivity] = useState<ActivityLog | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [showFilters, setShowFilters] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [activitiesResult, statsResult] = await Promise.allSettled([
      fetchActivities({
        page,
        limit,
        category: categoryFilter,
        severity: severityFilter,
        searchQuery: searchTerm || undefined,
        startDate: dateRange.start || undefined,
        endDate: dateRange.end || undefined,
      }),
      fetchActivityStats(),
    ]);
    const failures: string[] = [];

    if (activitiesResult.status === 'fulfilled') {
      setActivities(activitiesResult.value.data);
      setTotal(activitiesResult.value.total);
    } else {
      failures.push(
        activitiesResult.reason instanceof Error
          ? activitiesResult.reason.message
          : 'Failed to load activities',
      );
    }

    if (statsResult.status === 'fulfilled') {
      setStats(statsResult.value);
    } else {
      failures.push(
        statsResult.reason instanceof Error
          ? statsResult.reason.message
          : 'Failed to load activity statistics',
      );
    }

    setError(failures.length > 0 ? failures.join('; ') : null);
    setLoading(false);
  }, [page, limit, categoryFilter, severityFilter, searchTerm, dateRange]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const toggleRowExpand = (id: string): void => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedRows(newExpanded);
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

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `activity-log-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  if (loading && activities.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error && activities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <AlertTriangle className="w-12 h-12 text-red-500 mb-4" />
        <p className="text-red-600 mb-4">{error}</p>
        <button
          onClick={() => void loadData()}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Activity Log</h1>
          <p className="text-sm text-gray-500 mt-1">
            Monitor all system activities, user actions, and security events
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            <Download className="w-4 h-4" />
            Export
          </button>
          <button
            onClick={() => void loadData()}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Activity className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Activities</p>
                <p className="text-2xl font-bold text-gray-900">
                  {(stats.totalActivities ?? 0).toLocaleString()}
                </p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <User className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Unique Users</p>
                <p className="text-2xl font-bold text-gray-900">{stats.uniqueUsers ?? 0}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Clock className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Avg Response</p>
                <p className="text-2xl font-bold text-gray-900">{stats.averageResponseTime ?? 0}ms</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-100 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Error Rate</p>
                <p className="text-2xl font-bold text-gray-900">{(stats.errorRate ?? 0).toFixed(1)}%</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Search & Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
            <input
              type="text"
              placeholder="Search by action, user, or IP..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="all">All Categories</option>
            <option value="user_action">User Actions</option>
            <option value="system_event">System Events</option>
            <option value="api_call">API Calls</option>
            <option value="data_access">Data Access</option>
            <option value="security_event">Security Events</option>
            <option value="configuration">Config Changes</option>
          </select>
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="all">All Severities</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
            <option value="critical">Critical</option>
          </select>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-4 py-2 border rounded-lg ${
              showFilters
                ? 'border-blue-500 text-blue-600 bg-blue-50'
                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Filter className="w-4 h-4" />
            Filters
          </button>
        </div>

        {/* Advanced Filters */}
        {showFilters && (
          <div className="mt-4 pt-4 border-t border-gray-200 grid grid-cols-4 gap-4">
            <div>
              <span className="block text-sm font-medium text-gray-700 mb-1">
                Start Date
              </span>
              <input
                type="date"
                value={dateRange.start}
                onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <span className="block text-sm font-medium text-gray-700 mb-1">
                End Date
              </span>
              <input
                type="date"
                value={dateRange.end}
                onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>
        )}
      </div>

      {/* Activity Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="w-8 px-4 py-3"></th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Timestamp
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Category
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Action
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  IP Address
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Severity
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {activities.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    No activities found
                  </td>
                </tr>
              ) : (
                activities.map((activity) => (
                  <React.Fragment key={activity.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => toggleRowExpand(activity.id)}
                          className="text-gray-500 hover:text-gray-600"
                        >
                          {expandedRows.has(activity.id) ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{formatTimeAgo(activity.createdAt)}</div>
                        <div className="text-xs text-gray-500">
                          {formatDate(activity.createdAt)}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getCategoryColor(activity.category)}`}
                        >
                          {getCategoryIcon(activity.category)}
                          {activity.category.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-gray-900 max-w-xs truncate">
                          {activity.action}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{activity.userName || '-'}</div>
                        <div className="text-xs text-gray-500">{activity.tenantName}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="text-sm font-mono text-gray-600">
                          {activity.ipAddress || '-'}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(activity.severity)}`}
                        >
                          {getSeverityIcon(activity.severity)}
                          {activity.severity}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                            activity.success
                              ? 'bg-green-100 text-green-800'
                              : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {activity.success ? 'Success' : 'Failed'}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <button
                          onClick={() => setSelectedActivity(activity)}
                          className="text-blue-600 hover:text-blue-800"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                    {expandedRows.has(activity.id) && (
                      <tr className="bg-gray-50">
                        <td colSpan={9} className="px-8 py-4">
                          <div className="grid grid-cols-4 gap-4 text-sm">
                            <div>
                              <span className="text-gray-500">Target:</span>{' '}
                              <span className="text-gray-900">
                                {activity.entityType} - {activity.entityName}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-500">Duration:</span>{' '}
                              <span className="text-gray-900">{activity.duration}ms</span>
                            </div>
                            <div>
                              <span className="text-gray-500">Location:</span>{' '}
                              <span className="text-gray-900">
                                {activity.geoLocation?.city}, {activity.geoLocation?.country}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-500">Tenant:</span>{' '}
                              <span className="text-gray-900">{activity.tenantName}</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="bg-gray-50 px-4 py-3 border-t border-gray-200 flex items-center justify-between">
          <div className="text-sm text-gray-500">
            Showing {activities.length} of {total} activities
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-sm text-gray-600">Page {page}</span>
            <button
              onClick={() => setPage(page + 1)}
              disabled={activities.length < limit}
              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50"
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
