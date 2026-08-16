import React, { useCallback, useState } from 'react';
import { Badge, Button, Card } from '@aquaculture/shared-ui';
import { messagingApi, type MessagingAuditEntry } from '../../services/api/messaging';
import { adminApiErrorMessage } from '../../services/http-client';

const MessagingAuditPage: React.FC = () => {
  const [tenantId, setTenantId] = useState('');
  const [action, setAction] = useState('');
  const [entries, setEntries] = useState<readonly MessagingAuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(
    async (nextCursor?: string): Promise<void> => {
      const scopedTenantId = tenantId.trim();
      if (!scopedTenantId) {
        setError('Tenant ID is required.');
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const result = await messagingApi.getAuditLog({
          tenantId: scopedTenantId,
          action: action.trim() || undefined,
          cursor: nextCursor,
          limit: 25,
        });
        setEntries(result.items);
        setCursor(result.cursor);
        setHasMore(result.hasMore);
        setTotalCount(result.totalCount);
      } catch (cause: unknown) {
        setError(adminApiErrorMessage(cause, 'Failed to load audit entries.'));
      } finally {
        setLoading(false);
      }
    },
    [action, tenantId],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Messaging Audit</h1>
        <p className="mt-1 text-sm text-gray-500">
          Cursor-paginated tenant messaging compliance events.
        </p>
      </div>
      <Card>
        <div className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="text-xs font-medium text-gray-700">
            Tenant ID
            <input
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="text-xs font-medium text-gray-700">
            Action
            <input
              value={action}
              onChange={(event) => setAction(event.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <Button
            variant="primary"
            size="sm"
            disabled={loading || !tenantId.trim()}
            onClick={() => void loadEntries()}
          >
            {loading ? 'Loading…' : 'Load audit'}
          </Button>
        </div>
      </Card>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <Card>
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="font-semibold text-gray-900">Audit entries</h2>
          <Badge variant="info">{totalCount.toLocaleString()} total</Badge>
        </div>
        {entries.length === 0 ? (
          <p className="p-6 text-center text-sm text-gray-500">No audit entries loaded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Resource type</th>
                  <th className="px-4 py-3">Entry ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-4 py-3">{new Date(entry.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3 font-medium">{entry.action}</td>
                    <td className="px-4 py-3">{entry.resourceType}</td>
                    <td className="px-4 py-3 font-mono text-xs">{entry.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasMore && cursor && (
          <div className="flex justify-end border-t border-gray-200 p-4">
            <Button
              variant="secondary"
              size="sm"
              disabled={loading}
              onClick={() => void loadEntries(cursor)}
            >
              Next page
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
};

export default MessagingAuditPage;
