import React, { useCallback, useState } from 'react';
import { Badge, Button, Card } from '@aquaculture/shared-ui';
import { messagingApi, type RetentionPolicy } from '../../services/api/messaging';
import { adminApiErrorMessage } from '../../services/http-client';

const MessagingRetentionPage: React.FC = () => {
  const [tenantId, setTenantId] = useState('');
  const [policies, setPolicies] = useState<readonly RetentionPolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPolicies = useCallback(async (): Promise<void> => {
    const scopedTenantId = tenantId.trim();
    if (!scopedTenantId) {
      setError('Tenant ID is required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setPolicies(await messagingApi.getRetentionPolicies(scopedTenantId));
    } catch (cause: unknown) {
      setError(adminApiErrorMessage(cause, 'Failed to load retention policies.'));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  const updatePolicy = useCallback(
    async (policy: RetentionPolicy, retentionDays: number): Promise<void> => {
      setSavingId(policy.id);
      setError(null);
      try {
        const updated = await messagingApi.updateRetentionPolicy(policy.id, {
          channelId: policy.channelId,
          retentionDays,
        });
        setPolicies((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry)),
        );
      } catch (cause: unknown) {
        setError(adminApiErrorMessage(cause, 'Failed to update retention policy.'));
      } finally {
        setSavingId(null);
      }
    },
    [],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Retention Policies</h1>
        <p className="mt-1 text-sm text-gray-500">
          Inspect and update tenant or channel retention periods in days.
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
            onClick={() => void loadPolicies()}
          >
            {loading ? 'Loading…' : 'Load policies'}
          </Button>
        </div>
      </Card>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <Card>
        {policies.length === 0 ? (
          <p className="p-6 text-center text-sm text-gray-500">No policies loaded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-4 py-3">Scope</th>
                  <th className="px-4 py-3">Retention days</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {policies.map((policy) => (
                  <tr key={policy.id}>
                    <td className="px-4 py-3 font-mono text-xs">{policy.tenantId}</td>
                    <td className="px-4 py-3">
                      {policy.channelId ? (
                        <span className="font-mono text-xs">{policy.channelId}</span>
                      ) : (
                        <Badge variant="info">Tenant default</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <input
                        aria-label={`Retention days for ${policy.id}`}
                        type="number"
                        min={1}
                        defaultValue={policy.retentionDays}
                        className="w-28 rounded border border-gray-300 px-2 py-1"
                        id={`retention-${policy.id}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={savingId === policy.id}
                        onClick={() => {
                          const input = document.getElementById(`retention-${policy.id}`);
                          if (input instanceof HTMLInputElement) {
                            void updatePolicy(policy, input.valueAsNumber);
                          }
                        }}
                      >
                        {savingId === policy.id ? 'Saving…' : 'Save'}
                      </Button>
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

export default MessagingRetentionPage;
