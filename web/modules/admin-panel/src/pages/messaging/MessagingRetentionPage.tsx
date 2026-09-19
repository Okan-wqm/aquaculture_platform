/**
 * Messaging Retention Page
 *
 * Retention policy management for SUPER_ADMIN.
 * Per-tenant retention settings, channel-level overrides, and cleanup history.
 * Wired to real admin API: GET/PUT /messaging/retention/policies
 *
 * @see ADR-012 Phase 3 (Retention Policies)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge, DataTable, Modal, type DataTableColumn } from '@aquaculture/shared-ui';
import { messagingApi, type RetentionPolicy } from '../../services/adminApi';
import type { ApiError } from '../../services/http-client';

// ============================================================================
// Types
// ============================================================================

interface EditModalState {
  policyId: string;
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
// EditRetentionModal Component
// ============================================================================

const EditRetentionModal: React.FC<{
  tenant: EditModalState;
  onSave: (policyId: string, retention: string, applyToAll: boolean) => void;
  onClose: () => void;
}> = ({ tenant, onSave, onClose }) => {
  const [selectedRetention, setSelectedRetention] = useState(tenant.currentRetention);
  const [applyToAll, setApplyToAll] = useState(true);

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title="Edit Retention Policy"
      description={tenant.tenantName}
      bodyClassName="p-6"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(tenant.policyId, selectedRetention, applyToAll)}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors"
          >
            Save
          </button>
        </>
      }
    >
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          Retention Period
        </label>
        <select
          value={selectedRetention}
          onChange={(e) => setSelectedRetention(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
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
    </Modal>
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
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title="Add Channel Override"
      description={tenant.tenantName}
      bodyClassName="p-6"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
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
        </>
      }
    >
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Channel ID</label>
        <input
          type="text"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          placeholder="Enter channel UUID..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Retention Period</label>
        <select
          value={retentionDays}
          onChange={(e) => setRetentionDays(Number(e.target.value))}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
        >
          {RETENTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.days}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
    </Modal>
  );
};

// ============================================================================
// Main Component
// ============================================================================

const MessagingRetentionPage: React.FC = () => {
  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editModal, setEditModal] = useState<EditModalState | null>(null);
  const [overrideModal, setOverrideModal] = useState<OverrideModalState | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await messagingApi.getRetentionPolicies();
      setPolicies(data);
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message || 'Failed to fetch retention policies');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleSaveRetention = useCallback(
    async (policyId: string, retention: string, applyToAll: boolean) => {
      try {
        const updated = await messagingApi.updateRetentionPolicy(policyId, {
          defaultRetention: retention,
          applyToAll,
        });
        setPolicies((prev) =>
          prev.map((p) => (p.id === policyId ? updated : p)),
        );
        setEditModal(null);
      } catch (err) {
        const apiErr = err as ApiError;
        setError(apiErr.message || 'Failed to update retention policy');
      }
    },
    [],
  );

  const handleAddOverride = useCallback(
    async (_tenantId: string, _channelId: string, _retentionDays: number) => {
      // WHY: Channel override endpoint not yet available in admin gateway.
      // This handler is wired for future implementation; it currently just refreshes policies.
      await fetchData();
      setOverrideModal(null);
    },
    [fetchData],
  );

  const retentionPolicyColumns: DataTableColumn<RetentionPolicy>[] = [
    {
      key: 'tenant',
      header: 'Tenant',
      render: (_value, p) => (
        <>
          <p className="text-sm font-medium text-gray-900">{p.tenantName}</p>
          <p className="text-xs text-gray-400 font-mono">{p.tenantId.slice(0, 8)}...</p>
        </>
      ),
    },
    {
      key: 'defaultPolicy',
      header: 'Default Policy',
      align: 'center',
      render: (_value, p) => (
        <Badge variant="info">
          {RETENTION_LABELS[p.defaultRetention] ?? p.defaultRetention}
        </Badge>
      ),
    },
    {
      key: 'channelOverrides',
      header: 'Channel Overrides',
      align: 'center',
      render: (_value, p) => p.channelOverridesCount,
    },
    {
      key: 'totalMessages',
      header: 'Total Messages',
      align: 'right',
      render: (_value, p) => p.messagesCount.toLocaleString(),
    },
    {
      key: 'expired',
      header: 'Expired',
      align: 'right',
      render: (_value, p) => (
        <span className={p.expiredCount > 0 ? 'text-orange-600 font-medium' : 'text-gray-400'}>
          {p.expiredCount.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'lastCleanup',
      header: 'Last Cleanup',
      align: 'right',
      render: (_value, p) => p.lastCleanup ? new Date(p.lastCleanup).toLocaleDateString() : 'Never',
    },
    {
      key: 'nextCleanup',
      header: 'Next Cleanup',
      align: 'right',
      render: (_value, p) => new Date(p.nextCleanup).toLocaleDateString(),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, p) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() =>
              setEditModal({
                policyId: p.id,
                tenantName: p.tenantName,
                currentRetention: p.defaultRetention,
              })
            }
            className="text-xs px-2 py-1 rounded font-medium text-blue-600 hover:bg-blue-50"
          >
            Edit
          </button>
          <button
            onClick={() =>
              setOverrideModal({
                tenantId: p.tenantId,
                tenantName: p.tenantName,
              })
            }
            className="text-xs px-2 py-1 rounded font-medium text-purple-600 hover:bg-purple-50"
          >
            + Override
          </button>
        </div>
      ),
    }
  ];

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

      {/* Error Banner */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Retention Table */}
      <Card>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Per-Tenant Retention</h3>
          {policies.length === 0 && !loading ? (
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
            <DataTable<RetentionPolicy>
              data={policies}
              columns={retentionPolicyColumns}
              keyExtractor={(p) => p.tenantId}
              emptyMessage="No retention policies"
              searchable={false}
              sortable={false}
              stickyHeader={false}
              className="shadow-none rounded-none"
            />
          )}
        </div>
      </Card>

      {/* Edit Modal */}
      {editModal && (
        <EditRetentionModal
          tenant={editModal}
          onSave={(policyId, retention, applyToAll) =>
            void handleSaveRetention(policyId, retention, applyToAll)
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
