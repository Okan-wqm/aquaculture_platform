/**
 * Audit Trail Page
 *
 * Comprehensive audit logging interface with retention policies and alert management.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  FileText,
  Search,
  Filter,
  Download,
  RefreshCw,
  Eye,
  Shield,
  Clock,
  AlertTriangle,
  Settings,
  Bell,
  Plus,
  Edit2,
  Trash2,
  Save,
  X,
  Calendar,
  Database,
  Archive,
  CheckCircle2,
  XCircle,
  Info,
} from 'lucide-react';
import { securityApi } from '../../services/adminApi';

// ============================================================================
// Types
// ============================================================================

type AuditAction =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'login'
  | 'logout'
  | 'permission_change'
  | 'export'
  | 'import'
  | 'config_change';

type AuditSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

interface AuditEntry {
  id: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  entityName?: string;
  severity: AuditSeverity;
  tenantId: string;
  tenantName?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  changes?: {
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface RetentionPolicy {
  id: string;
  name: string;
  entityTypes: string[];
  retentionDays: number;
  archiveBeforeDelete: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt?: string;
}

interface AlertRule {
  id: string;
  name: string;
  condition: string;
  threshold?: number;
  actions: string[];
  severity: AuditSeverity;
  enabled: boolean;
  triggeredCount: number;
  lastTriggered?: string;
  createdAt: string;
}

interface AuditStats {
  totalEntries: number;
  byAction: Record<string, number>;
  bySeverity: Record<string, number>;
  byEntityType: Record<string, number>;
  last24Hours: number;
  last7Days: number;
  retentionPoliciesCount: number;
  alertRulesCount: number;
}

// ============================================================================
// API Service - Using centralized securityApi with auth headers
// ============================================================================

async function fetchAuditEntries(params: {
  page?: number;
  limit?: number;
  action?: string;
  entityType?: string;
  severity?: string;
  searchQuery?: string;
  startDate?: string;
  endDate?: string;
}): Promise<{ data: AuditEntry[]; total: number; page: number; limit: number }> {
  const apiParams: Record<string, unknown> = {};
  if (params.page) apiParams.page = params.page;
  if (params.limit) apiParams.limit = params.limit;
  if (params.entityType && params.entityType !== 'all') apiParams.entityType = params.entityType;
  if (params.startDate) apiParams.startDate = params.startDate;
  if (params.endDate) apiParams.endDate = params.endDate;

  return securityApi.getAuditTrail(apiParams);
}

async function fetchAuditSummary(): Promise<AuditStats> {
  const token = localStorage.getItem('access_token');
  const response = await fetch('/api/security/audit/summary', {
    headers: {
      Authorization: token ? `Bearer ${token}` : '',
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch audit summary');
  }
  return response.json();
}

async function fetchRetentionPolicies(): Promise<RetentionPolicy[]> {
  return securityApi.getRetentionPolicies();
}

async function fetchAlertRules(): Promise<AlertRule[]> {
  const token = localStorage.getItem('access_token');
  const response = await fetch('/api/security/audit/alert-rules', {
    headers: {
      Authorization: token ? `Bearer ${token}` : '',
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch alert rules');
  }
  return response.json();
}

// ============================================================================
// Components
// ============================================================================

const getActionColor = (action: AuditAction) => {
  switch (action) {
    case 'create':
      return 'bg-green-100 text-green-800';
    case 'update':
      return 'bg-blue-100 text-blue-800';
    case 'delete':
      return 'bg-red-100 text-red-800';
    case 'login':
    case 'logout':
      return 'bg-purple-100 text-purple-800';
    case 'permission_change':
      return 'bg-orange-100 text-orange-800';
    case 'export':
    case 'import':
      return 'bg-yellow-100 text-yellow-800';
    case 'config_change':
      return 'bg-indigo-100 text-indigo-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

const getSeverityColor = (severity: AuditSeverity) => {
  switch (severity) {
    case 'critical':
      return 'bg-red-100 text-red-800 border-red-200';
    case 'high':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    case 'medium':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    case 'low':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200';
  }
};

const getSeverityIcon = (severity: AuditSeverity) => {
  switch (severity) {
    case 'critical':
      return <XCircle className="w-4 h-4 text-red-600" />;
    case 'high':
      return <AlertTriangle className="w-4 h-4 text-orange-600" />;
    case 'medium':
      return <AlertTriangle className="w-4 h-4 text-yellow-600" />;
    case 'low':
      return <Info className="w-4 h-4 text-blue-600" />;
    default:
      return <Info className="w-4 h-4 text-gray-600" />;
  }
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatTimeAgo = (dateString: string) => {
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

// Audit Entry Detail Modal
const AuditDetailModal: React.FC<{
  entry: AuditEntry;
  onClose: () => void;
}> = ({ entry, onClose }) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">Audit Entry Details</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-6 space-y-6">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-gray-500">ID</label>
              <p className="text-sm text-gray-900 font-mono">{entry.id}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Timestamp</label>
              <p className="text-sm text-gray-900">{formatDate(entry.createdAt)}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Action</label>
              <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${getActionColor(entry.action)}`}>
                {entry.action}
              </span>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Severity</label>
              <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(entry.severity)}`}>
                {getSeverityIcon(entry.severity)}
                {entry.severity}
              </span>
            </div>
          </div>

          {/* Entity Info */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Entity Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-gray-500">Type</label>
                <p className="text-sm text-gray-900">{entry.entityType}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">ID</label>
                <p className="text-sm text-gray-900 font-mono">{entry.entityId}</p>
              </div>
              {entry.entityName && (
                <div className="col-span-2">
                  <label className="text-xs text-gray-500">Name</label>
                  <p className="text-sm text-gray-900">{entry.entityName}</p>
                </div>
              )}
            </div>
          </div>

          {/* User Info */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">User Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-gray-500">User</label>
                <p className="text-sm text-gray-900">{entry.userName || 'System'}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Email</label>
                <p className="text-sm text-gray-900">{entry.userEmail || 'N/A'}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">Tenant</label>
                <p className="text-sm text-gray-900">{entry.tenantName || 'N/A'}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500">IP Address</label>
                <p className="text-sm text-gray-900 font-mono">{entry.ipAddress || 'N/A'}</p>
              </div>
            </div>
          </div>

          {/* Changes */}
          {entry.changes && entry.changes.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-3">Changes</h3>
              <div className="space-y-2">
                {entry.changes.map((change, idx) => (
                  <div key={idx} className="bg-gray-50 rounded-lg p-3">
                    <p className="text-sm font-medium text-gray-700">{change.field}</p>
                    <div className="grid grid-cols-2 gap-4 mt-2">
                      <div>
                        <span className="text-xs text-red-600">Old:</span>
                        <pre className="text-xs text-gray-600 mt-1 overflow-auto">
                          {JSON.stringify(change.oldValue, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <span className="text-xs text-green-600">New:</span>
                        <pre className="text-xs text-gray-600 mt-1 overflow-auto">
                          {JSON.stringify(change.newValue, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Metadata */}
          {entry.metadata && Object.keys(entry.metadata).length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-3">Metadata</h3>
              <pre className="text-xs text-gray-600 bg-gray-50 p-3 rounded-lg overflow-auto">
                {JSON.stringify(entry.metadata, null, 2)}
              </pre>
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

export const AuditTrailPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'entries' | 'retention' | 'alerts'>('entries');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [retentionPolicies, setRetentionPolicies] = useState<RetentionPolicy[]>([]);
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [entriesResult, summaryResult, policiesResult, rulesResult] = await Promise.all([
        fetchAuditEntries({
          page,
          limit,
          action: actionFilter,
          severity: severityFilter,
          entityType: entityTypeFilter,
          searchQuery: searchTerm || undefined,
          startDate: dateRange.start || undefined,
          endDate: dateRange.end || undefined,
        }),
        fetchAuditSummary(),
        fetchRetentionPolicies(),
        fetchAlertRules(),
      ]);
      setEntries(entriesResult.data);
      setTotal(entriesResult.total);
      setStats(summaryResult);
      setRetentionPolicies(policiesResult);
      setAlertRules(rulesResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit data');
      console.error('Failed to load audit data:', err);
    } finally {
      setLoading(false);
    }
  }, [page, limit, actionFilter, severityFilter, entityTypeFilter, searchTerm, dateRange]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleExport = () => {
    const csvContent = [
      ['ID', 'Timestamp', 'Action', 'Entity Type', 'Entity ID', 'Severity', 'User', 'IP'].join(','),
      ...entries.map((e) =>
        [
          e.id,
          formatDate(e.createdAt),
          e.action,
          e.entityType,
          e.entityId,
          e.severity,
          e.userName || '',
          e.ipAddress || '',
        ].join(','),
      ),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-trail-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  if (loading && entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error && entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <AlertTriangle className="w-12 h-12 text-red-500 mb-4" />
        <p className="text-red-600 mb-4">{error}</p>
        <button
          onClick={loadData}
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
          <h1 className="text-2xl font-bold text-gray-900">Audit Trail</h1>
          <p className="text-sm text-gray-500 mt-1">
            Comprehensive audit logging with retention policies and alerts
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
            onClick={loadData}
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
                <FileText className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Entries</p>
                <p className="text-2xl font-bold text-gray-900">
                  {(stats?.totalEntries ?? 0).toLocaleString()}
                </p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <Clock className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Last 24 Hours</p>
                <p className="text-2xl font-bold text-gray-900">{stats?.last24Hours ?? 0}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Archive className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Retention Policies</p>
                <p className="text-2xl font-bold text-gray-900">{stats?.retentionPoliciesCount ?? 0}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-orange-100 rounded-lg">
                <Bell className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Alert Rules</p>
                <p className="text-2xl font-bold text-gray-900">{stats?.alertRulesCount ?? 0}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-8">
          {[
            { id: 'entries', label: 'Audit Entries', icon: FileText },
            { id: 'retention', label: 'Retention Policies', icon: Archive },
            { id: 'alerts', label: 'Alert Rules', icon: Bell },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id as typeof activeTab)}
              className={`flex items-center gap-2 px-1 py-4 border-b-2 font-medium text-sm ${
                activeTab === id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'entries' && (
        <div className="space-y-4">
          {/* Search & Filters */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by entity, user, or action..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <select
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Actions</option>
                <option value="create">Create</option>
                <option value="read">Read</option>
                <option value="update">Update</option>
                <option value="delete">Delete</option>
                <option value="login">Login</option>
                <option value="logout">Logout</option>
              </select>
              <select
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Severities</option>
                <option value="info">Info</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          {/* Entries Table */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Timestamp
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Action
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Entity
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    User
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Severity
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    IP Address
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      No audit entries found
                    </td>
                  </tr>
                ) : (
                  entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{formatTimeAgo(entry.createdAt)}</div>
                        <div className="text-xs text-gray-500">{formatDate(entry.createdAt)}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${getActionColor(entry.action)}`}>
                          {entry.action}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-gray-900">{entry.entityType}</div>
                        <div className="text-xs text-gray-500 font-mono">{entry.entityId}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{entry.userName || 'System'}</div>
                        <div className="text-xs text-gray-500">{entry.tenantName}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(entry.severity)}`}>
                          {getSeverityIcon(entry.severity)}
                          {entry.severity}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="text-sm font-mono text-gray-600">{entry.ipAddress || '-'}</span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        <button
                          onClick={() => setSelectedEntry(entry)}
                          className="text-blue-600 hover:text-blue-800"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            {/* Pagination */}
            <div className="bg-gray-50 px-4 py-3 border-t border-gray-200 flex items-center justify-between">
              <div className="text-sm text-gray-500">
                Showing {entries.length} of {total} entries
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
                  disabled={entries.length < limit}
                  className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'retention' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
              <Plus className="w-4 h-4" />
              Add Policy
            </button>
          </div>

          <div className="grid gap-4">
            {retentionPolicies.length === 0 ? (
              <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                No retention policies configured
              </div>
            ) : (
              retentionPolicies.map((policy) => (
                <div key={policy.id} className="bg-white rounded-lg border border-gray-200 p-6">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-semibold text-gray-900">{policy.name}</h3>
                        <span
                          className={`px-2 py-1 rounded-full text-xs font-medium ${
                            policy.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {policy.enabled ? 'Active' : 'Disabled'}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        Entity types: {policy.entityTypes.join(', ')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="p-2 text-gray-400 hover:text-gray-600">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button className="p-2 text-gray-400 hover:text-red-600">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <span className="text-gray-500">Retention Period:</span>{' '}
                      <span className="text-gray-900 font-medium">{policy.retentionDays} days</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Archive Before Delete:</span>{' '}
                      <span className="text-gray-900 font-medium">
                        {policy.archiveBeforeDelete ? 'Yes' : 'No'}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">Created:</span>{' '}
                      <span className="text-gray-900">{formatDate(policy.createdAt)}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === 'alerts' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
              <Plus className="w-4 h-4" />
              Add Rule
            </button>
          </div>

          <div className="grid gap-4">
            {alertRules.length === 0 ? (
              <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
                No alert rules configured
              </div>
            ) : (
              alertRules.map((rule) => (
                <div key={rule.id} className="bg-white rounded-lg border border-gray-200 p-6">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-semibold text-gray-900">{rule.name}</h3>
                        <span
                          className={`px-2 py-1 rounded-full text-xs font-medium ${
                            rule.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {rule.enabled ? 'Active' : 'Disabled'}
                        </span>
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${getSeverityColor(rule.severity)}`}>
                          {getSeverityIcon(rule.severity)}
                          {rule.severity}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">Condition: {rule.condition}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="p-2 text-gray-400 hover:text-gray-600">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button className="p-2 text-gray-400 hover:text-red-600">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-gray-500">Threshold:</span>{' '}
                      <span className="text-gray-900 font-medium">{rule.threshold || 'N/A'}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Actions:</span>{' '}
                      <span className="text-gray-900">{rule.actions.join(', ')}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Triggered:</span>{' '}
                      <span className="text-gray-900 font-medium">{rule.triggeredCount} times</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Last Triggered:</span>{' '}
                      <span className="text-gray-900">
                        {rule.lastTriggered ? formatTimeAgo(rule.lastTriggered) : 'Never'}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {selectedEntry && (
        <AuditDetailModal
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  );
};

export default AuditTrailPage;
