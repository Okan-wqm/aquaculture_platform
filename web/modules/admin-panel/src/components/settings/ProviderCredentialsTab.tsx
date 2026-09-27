/**
 * ProviderCredentialsTab — the platform operator's surface for the company
 * marine data provider credential (Copernicus Data Space Ecosystem, "CDSE").
 *
 * WHY this exists (ADMIN-HIGH-135): PR #1044 moved the Sentinel/Copernicus
 * credential from a per-tenant settings page to one company credential in
 * config-service, but left the write reachable only through a hand-written
 * SUPER_ADMIN GraphQL call. This tab is that write, done properly: the
 * credential's fields go to a typed config-service mutation, the storage key
 * and bundle shape stay in the backend, and the stored value is never read
 * back — only that one is stored, its revision and when it changed.
 *
 * The inputs are write-only: they start empty whether or not a credential is
 * stored, and clear after a successful save.
 */

import React, { useState } from 'react';
import { Alert, Badge, Button, Card, Input } from '@aquaculture/shared-ui';

import {
  useMarineProviderCredentialStatus,
  useSetMarineProviderCdseCredential,
} from '../../hooks/useMarineProviderCredential';
import type { MarineProviderCredentialStatus } from '../../hooks/useMarineProviderCredential';

/** Recorded in configuration history for every save from this tab. */
const SAVE_REASON = 'admin-panel provider credentials save';

interface CdseFormState {
  clientId: string;
  clientSecret: string;
  instanceId: string;
}

const EMPTY_FORM: CdseFormState = { clientId: '', clientSecret: '', instanceId: '' };

function formatUpdatedAt(updatedAt: string | null): string {
  if (updatedAt === null) return '';
  const parsed = new Date(updatedAt);
  return Number.isNaN(parsed.getTime()) ? updatedAt : parsed.toLocaleString();
}

const StatusLine: React.FC<{ status: MarineProviderCredentialStatus }> = ({ status }) => (
  <div
    className="flex flex-wrap items-center gap-2 text-sm text-gray-600"
    data-testid="cdse-status"
  >
    {status.configured ? (
      <>
        <Badge variant="success">Credential stored</Badge>
        <span>
          revision {status.version}
          {status.updatedAt !== null && <> · updated {formatUpdatedAt(status.updatedAt)}</>}
        </span>
      </>
    ) : (
      <>
        <Badge variant="warning">No credential stored</Badge>
        <span>Environmental monitoring cannot fetch Sentinel-2 scenes until one is saved.</span>
      </>
    )}
  </div>
);

export const ProviderCredentialsTab: React.FC = () => {
  const statusQuery = useMarineProviderCredentialStatus('CDSE');
  const setCredential = useSetMarineProviderCdseCredential();

  const [form, setForm] = useState<CdseFormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const canSave =
    form.clientId.trim().length > 0 &&
    form.clientSecret.trim().length > 0 &&
    !setCredential.isPending;

  const handleSave = async (): Promise<void> => {
    setError(null);
    setSuccess(null);
    const instanceId = form.instanceId.trim();
    try {
      const status = await setCredential.mutateAsync({
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret,
        ...(instanceId.length === 0 ? {} : { instanceId }),
        reason: SAVE_REASON,
      });
      setForm(EMPTY_FORM);
      setSuccess(`CDSE credential saved (revision ${status.version ?? '?'})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert type="success" dismissible onDismiss={() => setSuccess(null)}>
          {success}
        </Alert>
      )}

      <Card className="p-6">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            Copernicus Data Space Ecosystem (CDSE)
          </h3>
          <p className="mt-1 text-sm text-gray-600">
            The company credential farm-service uses for Sentinel-2 scene metadata and imagery on
            every tenant&apos;s sea-cage environment panel. One credential serves the whole
            platform; tenants never see or configure it.
          </p>
        </div>

        {statusQuery.isPending && (
          <p className="text-sm text-gray-500" data-testid="cdse-status-loading">
            Checking stored credential…
          </p>
        )}
        {statusQuery.isError && (
          <Alert type="error">
            The stored credential status could not be read: {statusQuery.error.message}
          </Alert>
        )}
        {statusQuery.data && <StatusLine status={statusQuery.data} />}

        <div className="mt-6 grid grid-cols-1 gap-4">
          <Input
            label="Client ID"
            value={form.clientId}
            onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            placeholder="sh-00000000-0000-0000-0000-000000000000"
            autoComplete="off"
            required
          />
          <Input
            label="Client Secret"
            type="password"
            value={form.clientSecret}
            onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
            placeholder={
              statusQuery.data?.configured
                ? 'Enter a new secret to rotate the stored credential'
                : 'Enter the CDSE client secret'
            }
            autoComplete="new-password"
            required
          />
          <Input
            label="Instance ID (optional)"
            value={form.instanceId}
            onChange={(e) => setForm({ ...form, instanceId: e.target.value })}
            placeholder="Only for Sentinel Hub configuration instances"
            autoComplete="off"
          />
        </div>

        <p className="mt-3 text-xs text-gray-500">
          Saving replaces the stored credential atomically and records the change in the
          configuration history. Farm-service picks the new credential up on its next provider
          request; no restart is needed.
        </p>

        <div className="mt-4 flex justify-end">
          <Button
            onClick={() => void handleSave()}
            loading={setCredential.isPending}
            disabled={!canSave}
          >
            {statusQuery.data?.configured ? 'Rotate Credential' : 'Save Credential'}
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default ProviderCredentialsTab;
