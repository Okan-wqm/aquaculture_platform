/**
 * Messaging Retention Page
 *
 * Retention policy management for SUPER_ADMIN.
 * Per-tenant retention settings, channel-level overrides, and cleanup history.
 *
 * @see ADR-012 Phase 3 (Retention Policies)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

interface TenantRetention {
  tenantId: string;
  tenantName: string;
  defaultRetention: '90d' | '1y' | '3y' | 'indefinite';
  channelOverridesCount: number;
  lastCleanup: string | null;
  nextCleanup: string;
  messagesCount: number;
  expiredCount: number;
}

interface ChannelOverride {
  channelId: string;
  channelName: string;
  retentionDays: number;
  createdAt: string;
}

interface CleanupRun {
  id: string;
  tenantName: string;
  runAt: string;
  messagesDeleted: number;
  storageFreedMB: number;
  status: 'success' | 'failed' | 'partial';
  durationMs: number;
}

interface EditModalState {
  tenantId: string;
  tenantName: string;
  currentRetention: string;
}

interface OverrideModalState {
  tenantId: string;
  tenantName: string;
}

// ============================================================================
// Constants
// ============================================================================

const RETENTION_OPTIONS = [
  { value: '90d', label: '90 Days', days: 90 },
  { value: '1y', label: '1 Year', days: 365 },
  { value: '3y', label: '3 Years', days: 1095 },
  { value: 'indefinite', label: 'Indefinite', days: -1 },
];

const RETENTION_LABELS: Record<string, string> = {
  '90d': '90 Days',
  '1y': '1 Year',
  '3y': '3 Years',
  indefinite: 'Indefinite',
};

// ============================================================================
// Mock Data (TODO: Replace with admin API calls)
// ============================================================================

const MOCK_TENANTS: TenantRetention[] = [];
const MOCK_CLEANUP_HISTORY: CleanupRun[] = [];

// ============================================================================
// EditRetentionModal Component
// ============================================================================

const EditRetentionModal: React.FC<{
  tenant: EditModalState;
  onSave: (tenantId: string, retention: string, applyToAll: boolean) => void;
  onClose: () => void;
}> = ({ tenant, onSave, onClose }) => {
  const [selectedRetention, setSelectedRetention] = useState(tenant.currentRetention);
  const [applyToAll, setApplyToAll] = useState(true);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-1">Edit Retention Policy</h3>
        <p className="text-sm text-gray-500 mb-4">{tenant.tenantName}</p>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Retention Period
            </label>
            <select
              value={selectedRetention}
              onChange={(e) => setSelectedRetention(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            >
              {RETENTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Apply to all channels (override existing channel-level settings)
          </label>

          <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-xs text-yellow-700">
              Warning: Reducing the retention period will cause older messages to be deleted
              during the next nightly cleanup (02:00 UTC). Messages under legal hold will be preserved.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-6">
          <button
            onClick={() => onSave(tenant.tenantId, selectedRetention, applyToAll)}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors"
          >
            Save
          </button>
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// AddChannelOverrideModal Component
// ============================================================================

const AddChannelOverrideModal: React.FC<{
  tenant: OverrideModalState;
  onSave: (tenantId: string, channelId: string, retentionDays: number) => void;
  onClose: () => void;
}> = ({ tenant, onSave, onClose }) => {
  const [channelId, setChannelId] = useState('');
  const [retentionDays, setRetentionDays] = useState(365);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-1">Add Channel Override</h3>
        <p className="text-sm text-gray-500 mb-4">{tenant.tenantName}</p>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Channel ID</label>
            <input
              type="text"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              placeholder="Enter channel UUID..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Retention Period</label>
            <select
              value={retentionDays}
              onChange={(e) => setRetentionDays(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            >
              {RETENTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.days}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-6">
          <button
            onClick={() => {
              if (channelId.trim()) {
                onSave(tenant.tenantId, channelId.trim(), retentionDays);
              }
            }}
            disabled={!channelId.trim()}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add Override
          </button>
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const MessagingRetentionPage: React.FC = () => {
  const [tenants, setTenants] = useState<TenantRetention[]>(MOCK_TENANTS);
  const [cleanupHistory, setCleanupHistory] = useState<CleanupRun[]>(MOCK_CLEANUP_HISTORY);
  const [loading, setLoading] = useState(false);
  const [editModal, setEditModal] = useState<EditModalState | null>(null);
  const [overrideModal, setOverrideModal] = useState<OverrideModalState | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // TODO: Replace with actual admin API calls
      // const [tenantsRes, cleanupRes] = await Promise.all([
      //   adminApi.get('/admin/messaging/retention/tenants'),
      //   adminApi.get('/admin/messaging/retention/cleanup-history'),
      // ]);
      // setTenants(tenantsRes.data);
      // setCleanupHistory(cleanupRes.data);

      setTenants(MOCK_TENANTS);
      setCleanupHistory(MOCK_CLEANUP_HISTORY);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to fetch retention data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleSaveRetention = useCallback(
    async (tenantId: string, retention: string, applyToAll: boolean) => {
      try {
        // TODO: Replace with actual admin API call
        // await adminApi.patch(`/admin/messaging/retention/tenants/${tenantId}`, {
        //   defaultRetention: retention,
        //   applyToAll,
        // });
        setTenants((prev) =>
          prev.map((t) =>
            t.tenantId === tenantId
              ? {
                  ...t,
                  defaultRetention: retention as TenantRetention['defaultRetention'],
                  channelOverridesCount: applyToAll ? 0 : t.channelOverridesCount,
                }
              : t,
          ),
        );
        setEditModal(null);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to update retention:', error);
      }
    },
    [],
  );

  const handleAddOverride = useCallback(
    async (tenantId: string, channelId: string, retentionDays: number) => {
      try {
        // TODO: Replace with actual admin API call
        // await adminApi.post(`/admin/messaging/retention/tenants/${tenantId}/overrides`, {
        //   channelId,
        //   retentionDays,
        // });
        setTenants((prev) =>
          prev.map((t) =>
            t.tenantId === tenantId
              ? { ...t, channelOverridesCount: t.channelOverridesCount + 1 }
              : t,
          ),
        );
        setOverrideModal(null);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to add channel override:', error);
      }
    },
    [],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Retention Policies</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage message retention periods, channel-level overrides, and cleanup schedules
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-gray-400 border border-gray-200 rounded-lg px-3 py-1.5">
            Next cleanup: 02:00 UTC
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
      </div>

      {/* Retention Table */}
      <Card>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Per-Tenant Retention</h3>
          {tenants.length === 0 && !loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="text-center">
                <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-gray-500">No tenant retention policies configured.</p>
                <p className="text-xs text-gray-400 mt-1">
                  Retention policies will appear once tenants enable messaging.
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Default Policy</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Channel Overrides</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Total Messages</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Expired</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Last Cleanup</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Next Cleanup</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {tenants.map((t) => (
                    <tr key={t.tenantId} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{t.tenantName}</p>
                        <p className="text-xs text-gray-400 font-mono">{t.tenantId.slice(0, 8)}...</p>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant="info">
                          {RETENTION_LABELS[t.defaultRetention] ?? t.defaultRetention}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-center">
                        {t.channelOverridesCount}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">
                        {t.messagesCount.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-sm text-right">
                        <span className={t.expiredCount > 0 ? 'text-orange-600 font-medium' : 'text-gray-400'}>
                          {t.expiredCount.toLocaleString()}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 text-right">
                        {t.lastCleanup ? new Date(t.lastCleanup).toLocaleDateString() : 'Never'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 text-right">
                        {new Date(t.nextCleanup).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() =>
                              setEditModal({
                                tenantId: t.tenantId,
                                tenantName: t.tenantName,
                                currentRetention: t.defaultRetention,
                              })
                            }
                            className="text-xs px-2 py-1 rounded font-medium text-blue-600 hover:bg-blue-50"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() =>
                              setOverrideModal({
                                tenantId: t.tenantId,
                                tenantName: t.tenantName,
                              })
                            }
                            className="text-xs px-2 py-1 rounded font-medium text-purple-600 hover:bg-purple-50"
                          >
                            + Override
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* Cleanup History */}
      <Card>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Cleanup History (Last 10 Runs)</h3>
          {cleanupHistory.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <svg className="w-10 h-10 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                <p className="text-sm text-gray-500">No cleanup runs yet</p>
                <p className="text-xs text-gray-400 mt-1">
                  Cleanup runs nightly at 02:00 UTC
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Run At</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Messages Deleted</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Storage Freed</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {cleanupHistory.map((run) => (
                    <tr key={run.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{run.tenantName}</td>
                      <td className="px-4 py-3 text-sm text-gray-500">{new Date(run.runAt).toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{run.messagesDeleted.toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{run.storageFreedMB.toFixed(1)} MB</td>
                      <td className="px-4 py-3 text-sm text-gray-500 text-right">{run.durationMs}ms</td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant={run.status === 'success' ? 'success' : run.status === 'partial' ? 'warning' : 'error'}>
                          {run.status.charAt(0).toUpperCase() + run.status.slice(1)}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* Edit Modal */}
      {editModal && (
        <EditRetentionModal
          tenant={editModal}
          onSave={(tenantId, retention, applyToAll) =>
            void handleSaveRetention(tenantId, retention, applyToAll)
          }
          onClose={() => setEditModal(null)}
        />
      )}

      {/* Add Override Modal */}
      {overrideModal && (
        <AddChannelOverrideModal
          tenant={overrideModal}
          onSave={(tenantId, channelId, retentionDays) =>
            void handleAddOverride(tenantId, channelId, retentionDays)
          }
          onClose={() => setOverrideModal(null)}
        />
      )}
    </div>
  );
};

export default MessagingRetentionPage;
