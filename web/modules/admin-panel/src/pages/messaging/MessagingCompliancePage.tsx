import React, { useCallback, useMemo, useState } from 'react';

import { Button, Card, useAuthContext } from '@aquaculture/shared-ui';
import {
  ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1,
  ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1,
} from '@platform/admin-http-contracts';

import { useAsyncData } from '../../hooks/useAsyncData';
import {
  messagingApi,
  type ComplianceStats,
  type LegalHold,
  type LegalHoldReleaseOperation,
} from '../../services/api/messaging';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EMPTY_STATS: ComplianceStats = {
  activeHoldsCount: 0,
  retentionPoliciesCount: 0,
  auditLogEntriesCount: 0,
};

function initialTenantId(): string {
  if (typeof window === 'undefined') return '';
  const value = new URLSearchParams(window.location.search).get('tenantId') ?? '';
  return UUID_V4.test(value) ? value : '';
}

function requestIdFor(storageKey: string): string {
  const previous = window.sessionStorage.getItem(storageKey);
  if (previous && UUID_V4.test(previous)) return previous;
  const requestId = window.crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, requestId);
  return requestId;
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const style =
    status === 'RELEASED'
      ? 'bg-green-100 text-green-800'
      : status === 'EXPIRED'
        ? 'bg-gray-100 text-gray-700'
        : 'bg-amber-100 text-amber-800';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}>{status}</span>
  );
}

const MessagingCompliancePage: React.FC = () => {
  const { user } = useAuthContext();
  const currentAdminId = user?.id ?? '';
  const [tenantId, setTenantId] = useState(initialTenantId);
  const tenantScopeValid = UUID_V4.test(tenantId);
  const [releaseTarget, setReleaseTarget] = useState<LegalHold | null>(null);
  const [releaseReason, setReleaseReason] = useState('');
  const [mutationId, setMutationId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const statsQuery = useAsyncData<ComplianceStats>(
    () => messagingApi.getComplianceStats(tenantId),
    {
      immediate: tenantScopeValid,
      cacheKey: tenantScopeValid ? `messaging-compliance-stats:${tenantId}` : undefined,
      cacheTTL: 15_000,
    },
  );
  const holdsQuery = useAsyncData<readonly LegalHold[]>(
    () => messagingApi.getLegalHolds(tenantId),
    {
      immediate: tenantScopeValid,
      cacheKey: tenantScopeValid ? `messaging-compliance-holds:${tenantId}` : undefined,
      cacheTTL: 15_000,
    },
  );
  const operationsQuery = useAsyncData<readonly LegalHoldReleaseOperation[]>(
    () => messagingApi.getLegalHoldReleaseOperations(tenantId),
    {
      immediate: tenantScopeValid,
      cacheKey: tenantScopeValid
        ? `messaging-compliance-release-operations:${tenantId}`
        : undefined,
      cacheTTL: 5_000,
    },
  );

  const stats = statsQuery.data ?? EMPTY_STATS;
  const legalHolds = holdsQuery.data ?? [];
  const operations = operationsQuery.data ?? [];
  const loading = statsQuery.loading || holdsQuery.loading || operationsQuery.loading;
  const queryError = statsQuery.error || holdsQuery.error || operationsQuery.error;

  const pendingByHold = useMemo(() => {
    const now = Date.now();
    return new Map(
      operations
        .filter(
          (operation) =>
            operation.status === 'PENDING' && new Date(operation.expiresAt).getTime() > now,
        )
        .map((operation) => [operation.holdId, operation]),
    );
  }, [operations]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!tenantScopeValid) return;
    setMutationError(null);
    await Promise.all([statsQuery.refresh(), holdsQuery.refresh(), operationsQuery.refresh()]);
  }, [holdsQuery, operationsQuery, statsQuery, tenantScopeValid]);

  const loadTenant = useCallback(async (): Promise<void> => {
    if (!tenantScopeValid) {
      setMutationError('Enter a valid tenant UUID before loading compliance data.');
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('tenantId', tenantId);
    window.history.replaceState(null, '', url);
    setMutationError(null);
    await Promise.all([statsQuery.fetch(), holdsQuery.fetch(), operationsQuery.fetch()]);
  }, [holdsQuery, operationsQuery, statsQuery, tenantId, tenantScopeValid]);

  const requestRelease = useCallback(async (): Promise<void> => {
    if (!releaseTarget) return;
    const normalizedReason = releaseReason.trim();
    if (
      normalizedReason.length < ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1 ||
      normalizedReason.length > ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1
    ) {
      setMutationError(
        `Release reason must contain ${ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1}-${ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1} characters.`,
      );
      return;
    }

    const storageKey = `admin:legal-hold-release:init:${tenantId}:${releaseTarget.id}`;
    setMutationId(releaseTarget.id);
    setMutationError(null);
    try {
      await messagingApi.createLegalHoldReleaseOperation(releaseTarget.id, {
        tenantId,
        requestId: requestIdFor(storageKey),
        releaseReason: normalizedReason,
      });
      window.sessionStorage.removeItem(storageKey);
      setReleaseTarget(null);
      setReleaseReason('');
      await operationsQuery.refresh();
    } catch (error: unknown) {
      setMutationError(error instanceof Error ? error.message : 'Release request failed.');
    } finally {
      setMutationId(null);
    }
  }, [operationsQuery, releaseReason, releaseTarget, tenantId]);

  const authorizeRelease = useCallback(
    async (operation: LegalHoldReleaseOperation): Promise<void> => {
      const storageKey = `admin:legal-hold-release:authorize:${tenantId}:${operation.id}:${currentAdminId}`;
      setMutationId(operation.id);
      setMutationError(null);
      try {
        const result = await messagingApi.authorizeLegalHoldReleaseOperation(operation.id, {
          tenantId,
          requestId: requestIdFor(storageKey),
        });
        window.sessionStorage.removeItem(storageKey);
        if (result.status === 'EXPIRED') {
          setMutationError(
            'This release operation expired. The hold remains active; create a new request.',
          );
        }
        await refresh();
      } catch (error: unknown) {
        setMutationError(error instanceof Error ? error.message : 'Release authorization failed.');
      } finally {
        setMutationId(null);
      }
    },
    [currentAdminId, refresh, tenantId],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Compliance</h1>
          <p className="mt-1 text-sm text-gray-500">
            Tenant-scoped legal-hold evidence and two-person release operations
          </p>
        </div>
        <Button
          onClick={() => void refresh()}
          disabled={!tenantScopeValid || loading}
          variant="secondary"
          size="sm"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3 p-5">
          <label className="min-w-[22rem] flex-1 text-sm font-medium text-gray-700">
            Tenant UUID
            <input
              aria-label="Tenant UUID"
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value.trim())}
              placeholder="00000000-0000-4000-8000-000000000000"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
            />
          </label>
          <Button
            onClick={() => void loadTenant()}
            disabled={!tenantScopeValid || loading}
            size="sm"
          >
            Load tenant
          </Button>
        </div>
      </Card>

      {(queryError || mutationError) && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {mutationError ?? queryError}
        </div>
      )}

      {!tenantScopeValid ? (
        <Card>
          <p className="p-8 text-center text-sm text-gray-500">
            Select an explicit tenant scope. Compliance data is never aggregated across tenant
            boundaries implicitly.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[
              ['Active holds', stats.activeHoldsCount],
              ['Retention policies', stats.retentionPoliciesCount],
              ['Immutable audit entries', stats.auditLogEntriesCount],
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
            <div className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold text-gray-800">Legal holds</h2>
                <span className="text-xs text-gray-500">
                  {legalHolds.filter((hold) => hold.isActive).length} active / {legalHolds.length}{' '}
                  total
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Scope</th>
                      <th className="px-3 py-2">Matter</th>
                      <th className="px-3 py-2">Reason</th>
                      <th className="px-3 py-2">Started</th>
                      <th className="px-3 py-2 text-right">Release control</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {legalHolds.map((hold) => {
                      const pending = pendingByHold.get(hold.id);
                      const ownRequest = pending?.initiatedBy === currentAdminId;
                      return (
                        <tr key={hold.id}>
                          <td className="px-3 py-3">
                            <StatusBadge status={hold.isActive ? 'ACTIVE' : 'RELEASED'} />
                          </td>
                          <td className="px-3 py-3 font-mono text-xs">
                            {hold.channelId ?? 'TENANT-WIDE'}
                          </td>
                          <td className="px-3 py-3 font-mono text-xs">{hold.legalMatterId}</td>
                          <td className="max-w-sm px-3 py-3 text-gray-700">{hold.reason}</td>
                          <td className="px-3 py-3 text-gray-500">
                            {new Date(hold.startedAt).toLocaleString()}
                          </td>
                          <td className="px-3 py-3 text-right">
                            {hold.isActive && !pending && (
                              <button
                                onClick={() => {
                                  setReleaseTarget(hold);
                                  setReleaseReason('');
                                }}
                                className="rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                              >
                                Request release
                              </button>
                            )}
                            {pending && ownRequest && (
                              <span className="text-xs text-amber-700">Awaiting another admin</span>
                            )}
                            {pending && !ownRequest && (
                              <button
                                onClick={() => void authorizeRelease(pending)}
                                disabled={mutationId === pending.id}
                                className="rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                              >
                                {mutationId === pending.id ? 'Authorizing…' : 'Authorize release'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {!loading && legalHolds.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-10 text-center text-gray-500">
                          No legal holds in this tenant.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>

          <Card>
            <div className="p-5">
              <h2 className="mb-4 font-semibold text-gray-800">Release operation journal</h2>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Hold</th>
                      <th className="px-3 py-2">Initiator</th>
                      <th className="px-3 py-2">Approver</th>
                      <th className="px-3 py-2">Expires</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {operations.map((operation) => (
                      <tr key={operation.id}>
                        <td className="px-3 py-3">
                          <StatusBadge status={operation.status} />
                        </td>
                        <td className="px-3 py-3 font-mono text-xs">{operation.holdId}</td>
                        <td className="px-3 py-3 font-mono text-xs">{operation.initiatedBy}</td>
                        <td className="px-3 py-3 font-mono text-xs">
                          {operation.authorizedBy ?? '—'}
                        </td>
                        <td className="px-3 py-3 text-gray-500">
                          {new Date(operation.expiresAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    {!loading && operations.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-10 text-center text-gray-500">
                          No release operations in this tenant.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </>
      )}

      {releaseTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="release-title"
            className="w-full max-w-xl rounded-xl bg-white p-6 shadow-xl"
          >
            <h2 id="release-title" className="text-lg font-semibold text-gray-900">
              Request legal-hold release
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              This creates a 15-minute pending operation. A different SUPER_ADMIN must countersign
              it with a fresh MFA step-up token; this action does not release the hold.
            </p>
            <label className="mt-4 block text-sm font-medium text-gray-700">
              Release justification
              <textarea
                autoFocus
                value={releaseReason}
                onChange={(event) => setReleaseReason(event.target.value)}
                maxLength={ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1}
                rows={5}
                className="mt-1 w-full rounded-md border border-gray-300 p-3 text-sm"
              />
            </label>
            <p className="mt-1 text-right text-xs text-gray-500">
              {releaseReason.trim().length} / {ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1}{' '}
              minimum
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setReleaseTarget(null)}
                disabled={mutationId === releaseTarget.id}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void requestRelease()}
                disabled={
                  mutationId === releaseTarget.id ||
                  releaseReason.trim().length < ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1
                }
              >
                {mutationId === releaseTarget.id ? 'Requesting…' : 'Create request'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MessagingCompliancePage;
