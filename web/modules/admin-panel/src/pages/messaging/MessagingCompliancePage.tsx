/**
 * Messaging Compliance Page
 *
 * SUPER_ADMIN compliance dashboard for the messaging service.
 * Shows retention policies, legal holds, export jobs, compliance stats,
 * and an audit log operations-per-day chart.
 *
 * @see ADR-012 Phase 3 (Compliance)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

interface ComplianceStats {
  messagesUnderLegalHold: number;
  pendingRetentionCleanup: number;
  activeExports: number;
  complianceScore: number;
  activeHoldsCount: number;
  retentionPoliciesCount: number;
  auditEntriesCount: number;
}

interface LegalHold {
  id: string;
  tenantId: string;
  tenantName: string;
  channelId: string | null;
  channelName: string | null;
  reason: string;
  startedBy: string;
  startedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  isActive: boolean;
}

interface ExportRecord {
  id: string;
  tenantName: string;
  format: 'json' | 'csv';
  recordCount: number;
  status: 'pending' | 'completed' | 'failed';
  isUnderLegalHold: boolean;
  createdAt: string;
  downloadUrl?: string;
}

interface RetentionBucket {
  label: string;
  tenantCount: number;
  color: string;
}

interface DailyAuditData {
  date: string;
  count: number;
}

// ============================================================================
// Mock Data (TODO: Replace with admin API calls)
// ============================================================================

const MOCK_STATS: ComplianceStats = {
  messagesUnderLegalHold: 0,
  pendingRetentionCleanup: 0,
  activeExports: 0,
  complianceScore: 100,
  activeHoldsCount: 0,
  retentionPoliciesCount: 0,
  auditEntriesCount: 0,
};

const MOCK_LEGAL_HOLDS: LegalHold[] = [];
const MOCK_EXPORTS: ExportRecord[] = [];
const MOCK_RETENTION_BUCKETS: RetentionBucket[] = [
  { label: '90 days', tenantCount: 0, color: 'bg-blue-500' },
  { label: '1 year', tenantCount: 0, color: 'bg-green-500' },
  { label: '3 years', tenantCount: 0, color: 'bg-yellow-500' },
  { label: 'Indefinite', tenantCount: 0, color: 'bg-purple-500' },
];
const MOCK_DAILY_AUDIT: DailyAuditData[] = [];

// ============================================================================
// StatCard Component
// ============================================================================

const StatCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'purple';
}> = ({ title, value, subtitle, color = 'blue' }) => {
  const colorMap = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
  };

  return (
    <div className={`rounded-xl border p-5 ${colorMap[color]}`}>
      <p className="text-sm font-medium opacity-80">{title}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
      {subtitle && <p className="text-xs mt-1 opacity-60">{subtitle}</p>}
    </div>
  );
};

// ============================================================================
// StatusBadge Component
// ============================================================================

const HoldStatusBadge: React.FC<{ active: boolean }> = ({ active }) => (
  <span
    className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
      active ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'
    }`}
  >
    {active ? 'ACTIVE' : 'RELEASED'}
  </span>
);

const ExportStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, string> = {
    completed: 'bg-green-100 text-green-800',
    pending: 'bg-yellow-100 text-yellow-800',
    failed: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${map[status] ?? 'bg-gray-100 text-gray-800'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
};

// ============================================================================
// Audit Operations Chart (SVG bar chart)
// ============================================================================

const AuditOperationsChart: React.FC<{ data: DailyAuditData[]; height?: number }> = ({
  data,
  height = 160,
}) => {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-gray-400 text-sm" style={{ height }}>
        No audit data available
      </div>
    );
  }
  const maxVal = Math.max(...data.map((d) => d.count), 1);
  const barWidth = Math.max(12, Math.floor(400 / data.length) - 4);
  return (
    <svg viewBox={`0 0 ${data.length * (barWidth + 4)} ${height}`} className="w-full" style={{ height }}>
      {data.map((d, i) => {
        const barHeight = (d.count / maxVal) * (height - 20);
        return (
          <g key={d.date}>
            <rect
              x={i * (barWidth + 4)}
              y={height - 20 - barHeight}
              width={barWidth}
              height={barHeight}
              rx={3}
              className="fill-indigo-500"
            />
            <text
              x={i * (barWidth + 4) + barWidth / 2}
              y={height - 4}
              textAnchor="middle"
              className="fill-gray-500"
              fontSize="7"
            >
              {d.date.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ============================================================================
// RetentionChart Component
// ============================================================================

const RetentionChart: React.FC<{ buckets: RetentionBucket[] }> = ({ buckets }) => {
  const maxCount = Math.max(...buckets.map((b) => b.tenantCount), 1);

  if (buckets.every((b) => b.tenantCount === 0)) {
    return (
      <div className="flex items-center justify-center text-gray-400 text-sm py-8">
        No retention data available
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {buckets.map((bucket) => (
        <div key={bucket.label} className="flex items-center gap-3">
          <span className="text-xs text-gray-600 w-20 text-right">{bucket.label}</span>
          <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
            <div
              className={`h-full rounded-full ${bucket.color} transition-all duration-500`}
              style={{ width: `${(bucket.tenantCount / maxCount) * 100}%` }}
            />
          </div>
          <span className="text-xs text-gray-500 w-8">{bucket.tenantCount}</span>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const MessagingCompliancePage: React.FC = () => {
  const [stats, setStats] = useState<ComplianceStats>(MOCK_STATS);
  const [legalHolds, setLegalHolds] = useState<LegalHold[]>(MOCK_LEGAL_HOLDS);
  const [exports, setExports] = useState<ExportRecord[]>(MOCK_EXPORTS);
  const [retentionBuckets, setRetentionBuckets] = useState<RetentionBucket[]>(MOCK_RETENTION_BUCKETS);
  const [dailyAudit, setDailyAudit] = useState<DailyAuditData[]>(MOCK_DAILY_AUDIT);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // TODO: Replace with actual admin API calls
      // const [statsRes, holdsRes, exportsRes, retentionRes, auditRes] = await Promise.all([
      //   adminApi.get('/admin/messaging/compliance/stats'),
      //   adminApi.get('/admin/messaging/compliance/legal-holds'),
      //   adminApi.get('/admin/messaging/compliance/exports'),
      //   adminApi.get('/admin/messaging/compliance/retention-overview'),
      //   adminApi.get('/admin/messaging/compliance/audit-daily'),
      // ]);
      // setStats(statsRes.data);
      // setLegalHolds(holdsRes.data);
      // setExports(exportsRes.data);
      // setRetentionBuckets(retentionRes.data);
      // setDailyAudit(auditRes.data);

      setStats(MOCK_STATS);
      setLegalHolds(MOCK_LEGAL_HOLDS);
      setExports(MOCK_EXPORTS);
      setRetentionBuckets(MOCK_RETENTION_BUCKETS);
      setDailyAudit(MOCK_DAILY_AUDIT);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch compliance data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleToggleHold = useCallback(async (holdId: string, isActive: boolean) => {
    try {
      // TODO: Replace with actual admin API call
      // await adminApi.patch(`/admin/messaging/compliance/legal-holds/${holdId}`, {
      //   activate: !isActive,
      // });
      setLegalHolds((prev) =>
        prev.map((h) =>
          h.id === holdId
            ? {
                ...h,
                isActive: !isActive,
                releasedAt: !isActive ? null : new Date().toISOString(),
                releasedBy: isActive ? 'current-admin' : null,
              }
            : h,
        ),
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to toggle legal hold:', error);
    }
  }, []);

  const handleDownloadExport = useCallback((exportId: string) => {
    const exportRecord = exports.find((e) => e.id === exportId);
    if (exportRecord?.downloadUrl) {
      window.open(exportRecord.downloadUrl, '_blank', 'noopener,noreferrer');
    }
  }, [exports]);

  const scoreColor = stats.complianceScore >= 90 ? 'green' : stats.complianceScore >= 70 ? 'yellow' : 'red';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Compliance</h1>
          <p className="text-sm text-gray-500 mt-1">
            Legal holds, data exports, retention compliance, and audit log summary
          </p>
        </div>
        <Button
          onClick={() => void fetchData()}
          disabled={loading}
          variant="secondary"
          size="sm"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          title="Under Legal Hold"
          value={stats.messagesUnderLegalHold.toLocaleString()}
          subtitle="messages"
          color="red"
        />
        <StatCard
          title="Active Holds"
          value={stats.activeHoldsCount}
          color="yellow"
        />
        <StatCard
          title="Pending Cleanup"
          value={stats.pendingRetentionCleanup.toLocaleString()}
          subtitle="messages"
          color="purple"
        />
        <StatCard
          title="Retention Policies"
          value={stats.retentionPoliciesCount}
          color="blue"
        />
        <StatCard
          title="Active Exports"
          value={stats.activeExports}
          color="green"
        />
        <StatCard
          title="Compliance Score"
          value={`${stats.complianceScore}%`}
          color={scoreColor as 'green' | 'yellow' | 'red'}
        />
      </div>

      {/* Charts Row: Audit Summary + Retention Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Audit Operations Per Day</h3>
            <AuditOperationsChart data={dailyAudit} />
            <div className="mt-3 flex justify-between items-center">
              <span className="text-xs text-gray-400">Last 14 days</span>
              <span className="text-xs text-gray-500">
                Total: {stats.auditEntriesCount.toLocaleString()} entries
              </span>
            </div>
          </div>
        </Card>

        <Card>
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Retention Distribution</h3>
            <RetentionChart buckets={retentionBuckets} />
            <div className="mt-4 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Messages Under Hold</span>
                <Badge variant={stats.messagesUnderLegalHold > 0 ? 'error' : 'success'}>
                  {stats.messagesUnderLegalHold.toLocaleString()}
                </Badge>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Pending Retention Cleanup</span>
                <Badge variant={stats.pendingRetentionCleanup > 1000 ? 'warning' : 'success'}>
                  {stats.pendingRetentionCleanup.toLocaleString()}
                </Badge>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Legal Holds Table */}
      <Card>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">Legal Holds</h3>
            <span className="text-xs text-gray-400">
              {legalHolds.filter((h) => h.isActive).length} active / {legalHolds.length} total
            </span>
          </div>
          {legalHolds.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <svg className="w-10 h-10 text-green-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-gray-500">No legal holds</p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Scope</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Reason</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Started</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Released</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {legalHolds.map((hold) => (
                    <tr key={hold.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <HoldStatusBadge active={hold.isActive} />
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{hold.tenantName}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {hold.channelName ?? 'Tenant-wide'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">{hold.reason}</td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {new Date(hold.startedAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {hold.releasedAt ? new Date(hold.releasedAt).toLocaleDateString() : '--'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => void handleToggleHold(hold.id, hold.isActive)}
                          className={`text-xs px-2 py-1 rounded font-medium ${
                            hold.isActive
                              ? 'text-red-600 hover:bg-red-50'
                              : 'text-green-600 hover:bg-green-50'
                          }`}
                        >
                          {hold.isActive ? 'Release' : 'Reactivate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* Exports Table */}
      <Card>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">Export Jobs</h3>
            <span className="text-xs text-gray-400">
              {exports.filter((e) => e.status === 'completed').length} completed
            </span>
          </div>
          {exports.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              No export jobs found.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Format</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Records</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Legal Hold</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Exported</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {exports.map((exp) => (
                    <tr key={exp.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{exp.tenantName}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 uppercase">{exp.format}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{exp.recordCount.toLocaleString()}</td>
                      <td className="px-4 py-3 text-center">
                        <ExportStatusBadge status={exp.status} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        {exp.isUnderLegalHold && (
                          <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-800">
                            HOLD
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 text-right">
                        {new Date(exp.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {exp.status === 'completed' && exp.downloadUrl && (
                          <button
                            onClick={() => handleDownloadExport(exp.id)}
                            className="text-xs px-2 py-1 rounded font-medium text-blue-600 hover:bg-blue-50"
                          >
                            Download
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

export default MessagingCompliancePage;
