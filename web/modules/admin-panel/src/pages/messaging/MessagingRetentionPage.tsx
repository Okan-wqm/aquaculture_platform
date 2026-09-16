/**
 * Retention Policies — a button that deleted nothing, saved nothing, and said
 * it had (ADMIN-CRITICAL-151 / ADMIN-HIGH-121).
 *
 * This page sets how long a tenant's messages survive. Every one of its three
 * paths was broken, and two of them were broken silently.
 *
 * 1. **"+ Override" was a no-op that looked like a success.** The modal
 *    collected a channel id and a retention period; `handleAddOverride`
 *    discarded all three of its arguments (`_tenantId`, `_channelId`,
 *    `_retentionDays`), refetched the list, and closed the modal. The operator
 *    set a channel's deletion window and the UI behaved exactly as if it had
 *    been written. Its comment said the endpoint was "not yet available in
 *    admin gateway" — and `UpdateRetentionPolicyDto` has taken
 *    `{ channelId, retentionDays }` all along, with `channelId` documented
 *    "null means the policy applies to every channel of the tenant". The
 *    capability existed; only the wiring did not.
 *
 * 2. **"Edit" could never save.** It sent
 *    `{ defaultRetention: '1y', applyToAll: true }`. Neither key is on the
 *    DTO, the platform's ValidationPipe runs `forbidNonWhitelisted: true`, and
 *    `retentionDays` was absent — refused twice over. And it addressed the
 *    route with the POLICY id, where the path parameter is the TENANT id
 *    (`@TenantParam('param', { key: 'id' })`), so a well-formed body would
 *    still have answered `Tenant <policy-uuid> not found`.
 *
 * 3. **The list could never load, and would have crashed if it had.**
 *    `GET /messaging/retention/policies` requires `tenantId`; the client sent
 *    none, so every load 400'd — and the table then drew _"No tenant retention
 *    policies configured. Retention policies will appear once tenants enable
 *    messaging."_ The row type invented seven of its nine fields, three of
 *    them counts rendered through `.toLocaleString()`, so the first row that
 *    ever arrived would have thrown.
 *
 * 4. **"Indefinite" was offered and could not be sent.** The entity documents
 *    `retentionDays: -1` as indefinite and the nightly cleanup skips those
 *    policies — but the DTO's `@Min(1)` refused it, so the one option an
 *    operator picks for a legal-preservation channel was the one option the
 *    API rejected. Fixed in the DTO, not by removing the option.
 *
 * The header's "Next cleanup: 02:00 UTC" is the only thing on the page that
 * was true: `@ScheduledJob({ name: 'messaging-retention.cleanup', cron: '0 2 *
 * * *' })`.
 *
 * @see ADR-012 Phase 3 (Retention Policies)
 */

import React, { useState } from 'react';
import { Card, Button, Badge } from '@aquaculture/shared-ui';
import { messagingApi, type RetentionPolicy } from '../../services/api/messaging';
import { adminKeys, useAdminMutation, useAdminQuery } from '../../hooks';
import { TenantSelect } from '../../components/TenantSelect';
import { QueryFailureNotice } from '../../components/QueryFailureNotice';

// ============================================================================
// Constants
// ============================================================================

/** The nightly job's own cron: `0 2 * * *` in `retention-policy.service.ts`. */
const CLEANUP_SCHEDULE = '02:00 UTC';

/** Indefinite, as `RetentionPolicy.retentionDays` encodes it. */
const INDEFINITE = -1;

/**
 * The windows offered as presets, in days.
 *
 * Days, because that is what the column holds and what the DTO accepts. The
 * previous four labels — `90d`, `1y`, `3y`, `indefinite` — were a second
 * vocabulary that the wire never used.
 */
const RETENTION_PRESETS: ReadonlyArray<{ readonly days: number; readonly label: string }> = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 1095, label: '3 years' },
  { days: 2555, label: '7 years' },
  { days: INDEFINITE, label: 'Indefinite (never delete)' },
];

/** How a window reads. `-1` is indefinite; everything else is a day count. */
function retentionLabel(days: number): string {
  const preset = RETENTION_PRESETS.find((option) => option.days === days);
  if (preset) return preset.label;
  return `${days.toLocaleString()} days`;
}

// ============================================================================
// SetRetentionModal
// ============================================================================

interface SetRetentionModalProps {
  /** The channel this window applies to; `null` is the tenant default. */
  readonly channelId: string | null;
  /** The window in force now, so a reduction can be recognised. */
  readonly currentDays: number | null;
  readonly saving: boolean;
  readonly onSave: (channelId: string | null, retentionDays: number) => void;
  readonly onClose: () => void;
}

const SetRetentionModal: React.FC<SetRetentionModalProps> = ({
  channelId,
  currentDays,
  saving,
  onSave,
  onClose,
}) => {
  const [days, setDays] = useState(currentDays ?? 365);

  // A reduction is what deletes messages. Naming it is the whole point of the
  // warning; the previous one warned on every save, reduction or not.
  const isReduction =
    currentDays !== null &&
    currentDays !== days &&
    (currentDays === INDEFINITE || (days !== INDEFINITE && days < currentDays));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-1">
          {channelId === null ? 'Tenant default retention' : 'Channel retention override'}
        </h3>
        <p className="text-sm text-gray-500 mb-4 font-mono">
          {channelId === null ? 'Applies to every channel without an override' : channelId}
        </p>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="retention-window"
              className="block text-xs font-medium text-gray-500 mb-1"
            >
              Retention window
            </label>
            <select
              id="retention-window"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
            >
              {RETENTION_PRESETS.map((option) => (
                <option key={option.days} value={option.days}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {isReduction && (
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-xs text-yellow-700">
                This SHORTENS the window from {retentionLabel(currentDays)} to{' '}
                {retentionLabel(days)}. Messages older than the new window are deleted at the next
                cleanup ({CLEANUP_SCHEDULE}). Messages under legal hold are preserved.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 mt-6">
          <button
            onClick={() => onSave(channelId, days)}
            disabled={saving}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
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
// AddChannelOverrideModal
// ============================================================================

interface AddChannelOverrideModalProps {
  readonly saving: boolean;
  readonly onSave: (channelId: string, retentionDays: number) => void;
  readonly onClose: () => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AddChannelOverrideModal: React.FC<AddChannelOverrideModalProps> = ({
  saving,
  onSave,
  onClose,
}) => {
  const [channelId, setChannelId] = useState('');
  const [days, setDays] = useState(365);

  // The DTO validates `@IsUUID('4')`, so a malformed id is a 400. Checking it
  // here means the operator is told which field is wrong, by the field.
  const trimmed = channelId.trim();
  const idIsValid = UUID.test(trimmed);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Add channel override</h3>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="override-channel"
              className="block text-xs font-medium text-gray-500 mb-1"
            >
              Channel ID
            </label>
            <input
              id="override-channel"
              type="text"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              placeholder="Enter channel UUID..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
            />
            {trimmed !== '' && !idIsValid && (
              <p className="text-xs text-red-600 mt-1">
                Not a channel UUID. The endpoint validates this and would refuse it.
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="override-window"
              className="block text-xs font-medium text-gray-500 mb-1"
            >
              Retention window
            </label>
            <select
              id="override-window"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
            >
              {RETENTION_PRESETS.map((option) => (
                <option key={option.days} value={option.days}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-6">
          <button
            onClick={() => onSave(trimmed, days)}
            disabled={!idIsValid || saving}
            className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Add override'}
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
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ channelId: string | null; days: number | null } | null>(
    null,
  );
  const [addingOverride, setAddingOverride] = useState(false);

  const policiesQuery = useAdminQuery<RetentionPolicy[]>(
    adminKeys.messaging.retention(tenantId ?? ''),
    ({ signal }) => messagingApi.getRetentionPolicies(tenantId ?? '', signal),
    { enabled: tenantId !== null },
  );

  const setRetention = useAdminMutation(
    ({ channelId, retentionDays }: { channelId: string | null; retentionDays: number }) =>
      messagingApi.updateRetentionPolicy(tenantId ?? '', { channelId, retentionDays }),
    {
      invalidateKeys: [adminKeys.messaging.retention(tenantId ?? '')],
      mutationOptions: {
        onSuccess: () => {
          setEditing(null);
          setAddingOverride(false);
        },
      },
    },
  );

  const policies = policiesQuery.data ?? [];
  const tenantDefault = policies.find((policy) => policy.channelId === null) ?? null;
  const overrides = policies.filter((policy) => policy.channelId !== null);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Retention Policies</h1>
          <p className="text-sm text-gray-500 mt-1">
            How long one tenant&apos;s messages survive: the default window, and any channel that
            overrides it.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="w-72">
            <label
              htmlFor="retention-tenant"
              className="block text-xs font-medium text-gray-600 mb-1"
            >
              Tenant
            </label>
            <div id="retention-tenant">
              <TenantSelect value={tenantId} onChange={(next) => setTenantId(next || null)} />
            </div>
          </div>
          <div className="text-xs text-gray-400 border border-gray-200 rounded-lg px-3 py-1.5">
            Next cleanup: {CLEANUP_SCHEDULE}
          </div>
          <Button
            onClick={() => void policiesQuery.refetch()}
            disabled={tenantId === null || policiesQuery.isFetching}
            variant="secondary"
            size="sm"
          >
            {policiesQuery.isFetching ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </div>

      <QueryFailureNotice
        errors={[policiesQuery.error, setRetention.error]}
        hasContent={policies.length > 0}
        onRetry={() => void policiesQuery.refetch()}
      />

      {tenantId === null ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-700">Choose a tenant</p>
          <p className="text-xs text-gray-500 mt-1">
            Retention policies are held per tenant and the route refuses a request without one.
            Nothing is listed until a tenant is selected.
          </p>
        </div>
      ) : (
        <>
          {/* Tenant default */}
          <Card>
            <div className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-700">Tenant default</h3>
                  <p className="text-xs text-gray-500 mt-1">
                    Applies to every channel without an override of its own.
                  </p>
                </div>
                {policiesQuery.isPending ? (
                  <span className="text-sm text-gray-400">Loading...</span>
                ) : tenantDefault === null ? (
                  // Not "365 days": no row means no policy has been set, and
                  // the service's column default is not something this page
                  // can claim to have read.
                  <div className="text-right">
                    <p className="text-sm text-gray-500">Not set</p>
                    <button
                      onClick={() => setEditing({ channelId: null, days: null })}
                      className="text-xs px-2 py-1 rounded font-medium text-blue-600 hover:bg-blue-50"
                    >
                      Set a default
                    </button>
                  </div>
                ) : (
                  <div className="text-right">
                    <Badge variant={tenantDefault.retentionDays === INDEFINITE ? 'info' : 'default'}>
                      {retentionLabel(tenantDefault.retentionDays)}
                    </Badge>
                    <div className="mt-1">
                      <button
                        onClick={() =>
                          setEditing({ channelId: null, days: tenantDefault.retentionDays })
                        }
                        className="text-xs px-2 py-1 rounded font-medium text-blue-600 hover:bg-blue-50"
                      >
                        Change
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Channel overrides */}
          <Card>
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-700">Channel overrides</h3>
                <button
                  onClick={() => setAddingOverride(true)}
                  className="text-xs px-2 py-1 rounded font-medium text-purple-600 hover:bg-purple-50"
                >
                  + Override
                </button>
              </div>

              {policiesQuery.isPending ? (
                <p className="text-sm text-gray-400 py-8 text-center">Loading policies...</p>
              ) : policiesQuery.isError ? (
                // The banner above carries the reason. Nothing is drawn here:
                // "no overrides" on a deletion-window surface is a claim.
                null
              ) : overrides.length === 0 ? (
                <p className="text-sm text-gray-500 py-8 text-center">
                  No channel overrides. Every channel follows the tenant default.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Channel
                        </th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Window
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Set
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Action
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {overrides.map((policy) => (
                        <tr key={policy.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-xs text-gray-700 font-mono">
                            {policy.channelId}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <Badge
                              variant={
                                policy.retentionDays === INDEFINITE ? 'info' : 'default'
                              }
                            >
                              {retentionLabel(policy.retentionDays)}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500 text-right">
                            {new Date(policy.updatedAt).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() =>
                                setEditing({
                                  channelId: policy.channelId,
                                  days: policy.retentionDays,
                                })
                              }
                              aria-label={`Change the window for channel ${policy.channelId}`}
                              className="text-xs px-2 py-1 rounded font-medium text-blue-600 hover:bg-blue-50"
                            >
                              Change
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
        </>
      )}

      {editing && (
        <SetRetentionModal
          channelId={editing.channelId}
          currentDays={editing.days}
          saving={setRetention.isPending}
          onSave={(channelId, retentionDays) => setRetention.mutate({ channelId, retentionDays })}
          onClose={() => setEditing(null)}
        />
      )}

      {addingOverride && (
        <AddChannelOverrideModal
          saving={setRetention.isPending}
          onSave={(channelId, retentionDays) => setRetention.mutate({ channelId, retentionDays })}
          onClose={() => setAddingOverride(false)}
        />
      )}
    </div>
  );
};

export default MessagingRetentionPage;
