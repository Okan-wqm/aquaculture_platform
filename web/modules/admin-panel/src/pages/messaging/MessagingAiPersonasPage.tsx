import React, { useCallback, useState } from 'react';
import { Badge, Button, Card } from '@aquaculture/shared-ui';
import { messagingApi, type AiPersonaDefinition } from '../../services/api/messaging';
import { adminApiErrorMessage } from '../../services/http-client';

const MessagingAiPersonasPage: React.FC = () => {
  const [tenantId, setTenantId] = useState('');
  const [personas, setPersonas] = useState<readonly AiPersonaDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPersonas = useCallback(async (): Promise<void> => {
    const scopedTenantId = tenantId.trim();
    if (!scopedTenantId) {
      setError('Tenant ID is required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setPersonas(await messagingApi.getPersonas(scopedTenantId));
    } catch (cause: unknown) {
      setError(adminApiErrorMessage(cause, 'Failed to load AI personas.'));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">AI Personas</h1>
        <p className="mt-1 text-sm text-gray-500">
          Read-only persona registry state exposed by the messaging admin API.
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
            onClick={() => void loadPersonas()}
          >
            {loading ? 'Loading…' : 'Load personas'}
          </Button>
        </div>
      </Card>
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {personas.map((persona) => (
          <Card key={persona.id}>
            <div className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-gray-900">{persona.name}</h2>
                  <p className="mt-1 text-sm text-gray-500">{persona.description}</p>
                </div>
                <Badge variant={persona.isActive ? 'success' : 'default'}>
                  {persona.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <p className="mt-4 font-mono text-xs text-gray-500">{persona.id}</p>
            </div>
          </Card>
        ))}
      </div>
      {!loading && personas.length === 0 && (
        <Card>
          <p className="p-6 text-center text-sm text-gray-500">No personas loaded.</p>
        </Card>
      )}
    </div>
  );
};

export default MessagingAiPersonasPage;
