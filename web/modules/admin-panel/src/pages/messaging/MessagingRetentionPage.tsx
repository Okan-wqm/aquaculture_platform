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
import {
  Card,
  Button,
  Badge,
  DataTable,
  Modal,
  type DataTableColumn,
  PageHeader,
} from '@aquaculture/shared-ui';
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
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title={channelId === null ? 'Tenant default retention' : 'Channel retention override'}
      description={
        channelId === null ? (
          'Applies to every channel without an override'
        ) : (
          <span className="font-mono">{channelId}</span>
        )
      }
      bodyClassName="p-6"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm font-semibold rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(channelId, days)}
            disabled={saving}
            className="flex-1 px-4 py-2 bg-info-600 text-white text-sm font-semibold rounded-lg hover:bg-info-700 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor="retention-window"
            className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
          >
            Retention window
          </label>
          <select
            id="retention-window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden"
          >
            {RETENTION_PRESETS.map((option) => (
              <option key={option.days} value={option.days}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {isReduction && (
          <div className="p-3 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg">
            <p className="text-xs text-warning-700 dark:text-warning-300">
              This SHORTENS the window from {retentionLabel(currentDays)} to {retentionLabel(days)}.
              Messages older than the new window are deleted at the next cleanup ({CLEANUP_SCHEDULE}
              ). Messages under legal hold are preserved.
            </p>
          </div>
        )}
      </div>
    </Modal>
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
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title="Add channel override"
      bodyClassName="p-6"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm font-semibold rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(trimmed, days)}
            disabled={!idIsValid || saving}
            className="flex-1 px-4 py-2 bg-info-600 text-white text-sm font-semibold rounded-lg hover:bg-info-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Add override'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor="override-channel"
            className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
          >
            Channel ID
          </label>
          <input
            id="override-channel"
            type="text"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            placeholder="Enter channel UUID..."
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden"
          />
          {trimmed !== '' && !idIsValid && (
            <p className="text-xs text-error-600 dark:text-error-400 mt-1">
              Not a channel UUID. The endpoint validates this and would refuse it.
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="override-window"
            className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
          >
            Retention window
          </label>
          <select
            id="override-window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-info-500 focus:border-info-500 outline-hidden"
          >
            {RETENTION_PRESETS.map((option) => (
              <option key={option.days} value={option.days}>
                {option.label}
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

  const overrideColumns: DataTableColumn<RetentionPolicy>[] = [
    {
      key: 'channel',
      header: 'Channel',
      render: (_value, policy) => (
        <span className="text-xs text-gray-700 dark:text-gray-300 font-mono">
          {policy.channelId}
        </span>
      ),
    },
    {
      key: 'window',
      header: 'Window',
      align: 'center',
      render: (_value, policy) => (
        <Badge variant={policy.retentionDays === INDEFINITE ? 'info' : 'default'}>
          {retentionLabel(policy.retentionDays)}
        </Badge>
      ),
    },
    {
      key: 'set',
      header: 'Set',
      align: 'right',
      render: (_value, policy) => new Date(policy.updatedAt).toLocaleDateString(),
    },
    {
      key: 'action',
      header: 'Action',
      align: 'right',
      render: (_value, policy) => (
        <button
          onClick={() =>
            setEditing({
              channelId: policy.channelId,
              days: policy.retentionDays,
            })
          }
          aria-label={`Change the window for channel ${policy.channelId}`}
          className="text-xs px-2 py-1 rounded font-medium text-info-600 dark:text-info-400 hover:bg-info-50 dark:hover:bg-info-900/30"
        >
          Change
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Retention Policies"
        description="How long one tenant's messages survive: the default window, and any channel that overrides it."
        actions={
          <div className="flex items-end gap-3">
            <div className="w-72">
              <label
                htmlFor="retention-tenant"
                className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1"
              >
                Tenant
              </label>
              <div id="retention-tenant">
                <TenantSelect value={tenantId} onChange={(next) => setTenantId(next || null)} />
              </div>
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5">
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
        }
      />

      <QueryFailureNotice
        errors={[policiesQuery.error, setRetention.error]}
        hasContent={policies.length > 0}
        onRetry={() => void policiesQuery.refetch()}
      />

      {tenantId === null ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-8 text-center">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Choose a tenant</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
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
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                    Tenant default
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Applies to every channel without an override of its own.
                  </p>
                </div>
                {policiesQuery.isPending ? (
                  <span className="text-sm text-gray-400 dark:text-gray-500">Loading...</span>
                ) : tenantDefault === null ? (
                  // Not "365 days": no row means no policy has been set, and
                  // the service's column default is not something this page
                  // can claim to have read.
                  <div className="text-right">
                    <p className="text-sm text-gray-500 dark:text-gray-400">Not set</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing({ channelId: null, days: null })}
                    >
                      Set a default
                    </Button>
                  </div>
                ) : (
                  <div className="text-right">
                    <Badge
                      variant={tenantDefault.retentionDays === INDEFINITE ? 'info' : 'default'}
                    >
                      {retentionLabel(tenantDefault.retentionDays)}
                    </Badge>
                    <div className="mt-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEditing({ channelId: null, days: tenantDefault.retentionDays })
                        }
                      >
                        Change
                      </Button>
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
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  Channel overrides
                </h3>
                <button
                  onClick={() => setAddingOverride(true)}
                  className="text-xs px-2 py-1 rounded font-medium text-accent-600 dark:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-900/30"
                >
                  + Override
                </button>
              </div>

              {policiesQuery.isPending ? (
                <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">
                  Loading policies...
                </p>
              ) : policiesQuery.isError ? // The banner above carries the reason. Nothing is drawn here:
              // "no overrides" on a deletion-window surface is a claim.
              null : overrides.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
                  No channel overrides. Every channel follows the tenant default.
                </p>
              ) : (
                <DataTable<RetentionPolicy>
                  data={overrides}
                  columns={overrideColumns}
                  keyExtractor={(policy) => policy.id}
                  emptyMessage="No channel overrides"
                  searchable={false}
                  sortable={false}
                  stickyHeader={false}
                  className="shadow-none rounded-none"
                />
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
