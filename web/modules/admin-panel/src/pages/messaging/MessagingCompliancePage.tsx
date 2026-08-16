import React, { useCallback, useState } from 'react';
import { Badge, Button, Card } from '@aquaculture/shared-ui';
import { messagingApi, type ComplianceStats, type LegalHold } from '../../services/api/messaging';
import { adminApiErrorMessage } from '../../services/http-client';

const EMPTY_STATS: ComplianceStats = {
  activeHoldsCount: 0,
  retentionPoliciesCount: 0,
  auditLogEntriesCount: 0,
};

const MessagingCompliancePage: React.FC = () => {
  const [tenantId, setTenantId] = useState('');
  const [stats, setStats] = useState<ComplianceStats>(EMPTY_STATS);
  const [legalHolds, setLegalHolds] = useState<readonly LegalHold[]>([]);
  const [loading, setLoading] = useState(false);
  const [releaseId, setReleaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCompliance = useCallback(async (): Promise<void> => {
    const scopedTenantId = tenantId.trim();
    if (!scopedTenantId) {
      setError('Tenant ID is required.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [nextStats, nextHolds] = await Promise.all([
        messagingApi.getComplianceStats(scopedTenantId),
        messagingApi.getLegalHolds(scopedTenantId),
      ]);
      setStats(nextStats);
      setLegalHolds(nextHolds);
    } catch (cause: unknown) {
      setError(adminApiErrorMessage(cause, 'Failed to load compliance state.'));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  const releaseLegalHold = useCallback(async (hold: LegalHold): Promise<void> => {
    setReleaseId(hold.id);
    setError(null);
    try {
      const released = await messagingApi.releaseLegalHold(hold.id, hold.tenantId);
      setLegalHolds((current) =>
        current.map((entry) => (entry.id === released.id ? released : entry)),
      );
      setStats((current) => ({
        ...current,
        activeHoldsCount: Math.max(0, current.activeHoldsCount - 1),
      }));
    } catch (cause: unknown) {
      setError(adminApiErrorMessage(cause, 'Failed to release legal hold.'));
    } finally {
      setReleaseId(null);
    }
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Messaging Compliance</h1>
        <p className="mt-1 text-sm text-gray-500">
          Tenant-scoped legal holds, retention policies, and compliance audit volume.
        </p>
      </div>

      <Card>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
          <label className="flex-1 text-xs font-medium text-gray-700">
            Tenant ID
            <input
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
            />
          </label>
          <Button
            variant="primary"
            size="sm"
            disabled={loading || !tenantId.trim()}
            onClick={() => void loadCompliance()}
          >
            {loading ? 'Loading…' : 'Load compliance'}
          </Button>
        </div>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {[
          ['Active legal holds', stats.activeHoldsCount],
          ['Retention policies', stats.retentionPoliciesCount],
          ['Audit entries', stats.auditLogEntriesCount],
        ].map(([label, value]) => (
          <Card key={label}>
            <div className="p-5">
              <p className="text-sm text-gray-500">{label}</p>
              <p className="mt-1 text-3xl font-bold text-gray-900">{value}</p>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <div className="border-b border-gray-200 p-4">
          <h2 className="font-semibold text-gray-900">Legal holds</h2>
        </div>
        {legalHolds.length === 0 ? (
          <p className="p-6 text-center text-sm text-gray-500">
            No legal holds loaded for this tenant.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-4 py-3">Channel</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {legalHolds.map((hold) => (
                  <tr key={hold.id}>
                    <td className="px-4 py-3 font-mono text-xs">{hold.tenantId}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {hold.channelId ?? 'Tenant-wide'}
                    </td>
                    <td className="px-4 py-3">{hold.reason}</td>
                    <td className="px-4 py-3">{new Date(hold.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <Badge variant={hold.isActive ? 'error' : 'default'}>
                        {hold.isActive ? 'Active' : 'Released'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {hold.isActive && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={releaseId === hold.id}
                          onClick={() => void releaseLegalHold(hold)}
                        >
                          {releaseId === hold.id ? 'Releasing…' : 'Release'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default MessagingCompliancePage;
