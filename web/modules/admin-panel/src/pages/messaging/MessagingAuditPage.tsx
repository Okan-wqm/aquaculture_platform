/**
 * Messaging Audit Log — the forensic trail that could not display a single
 * correct row in any state (ADMIN-CRITICAL-150 / ADMIN-HIGH-121).
 *
 * `GET /messaging/audit` declares `@TenantParam('query') tenantId: string`,
 * and the page's tenant box was an optional free-text filter defaulting to
 * `''`, sent as `undefined`. So the DEFAULT state of the page — no filters —
 * refused at the pipe with `BadRequestException('tenantId is required')`, and
 * the table then rendered its empty state: _"No audit entries found. Audit
 * entries will appear once messaging activity begins."_ On an audit trail,
 * that second sentence explains an absence the page had not established.
 *
 * Type a valid tenant id in and it got worse. The route answers
 * `{ items, hasMore, cursor, totalCount }`; the client declared
 * `PaginatedResult<T>`, an OFFSET page with a `data` array. `result.data` was
 * `undefined`, so `entries` became `undefined` and the next render threw on
 * `entries.length` — a blank screen where the audit log should be.
 *
 * Underneath that, the row type was fiction. `messaging.compliance_audit_logs`
 * holds `{id, tenantId, userId, action, resourceType, resourceId, details,
 * ipAddress, userAgent, createdAt}`. The client declared `timestamp` (so
 * `new Date(entry.timestamp)` was `Invalid Date`), `tenantName` and `userName`
 * (absent — two blank columns), `channelId` and `messageId` (absent; the row
 * names its subject with `resourceType` + `resourceId`), and `details` as a
 * `string` when it is `jsonb | null` — so the cell showed `[object Object]`
 * and the CSV export called `.replace` on an object and THREW. `ipAddress` and
 * `userAgent`, the two fields that say where an action came from, were not
 * shown at all.
 *
 * The pager sent `page` and `pageSize`. The route takes `limit` and `cursor`.
 * Neither of the two it was sent exists, so every "page" returned the same
 * first rows and Previous/Next moved nothing.
 *
 * And the seven action filter values — `send`, `edit`, `delete`,
 * `create_channel`, `join_channel`, `leave_channel`, `upload_file` — are not
 * members of `ComplianceAction`. Every action filter returned nothing,
 * permanently, while the four an auditor looks for (`message_export`,
 * `data_anonymize`, `retention_set`, `legal_hold_toggle`) were never offered.
 * The vocabulary now comes from the entity, pinned by
 * `tests/invariants/messaging-compliance-action-parity.spec.ts`.
 *
 * @see ADR-012 Phase 3
 */

import React, { useMemo, useState } from 'react';
import { Card, Button } from '@aquaculture/shared-ui';
import {
  messagingApi,
  MESSAGING_COMPLIANCE_ACTIONS,
  type MessagingAuditEntry,
  type MessagingAuditPage as AuditPage,
  type MessagingComplianceAction,
} from '../../services/api/messaging';
import { saveBlob } from '../../services/blob-client';
import { adminKeys, useAdminQuery } from '../../hooks';
import { TenantSelect } from '../../components/TenantSelect';
import { QueryFailureNotice } from '../../components/QueryFailureNotice';

// ============================================================================
// Types
// ============================================================================

interface AuditFilters {
  readonly userId: string;
  readonly action: MessagingComplianceAction | '';
  readonly startDate: string;
  readonly endDate: string;
}

// ============================================================================
// Constants
// ============================================================================

const INITIAL_FILTERS: AuditFilters = {
  userId: '',
  action: '',
  startDate: '',
  endDate: '',
};

const PAGE_SIZE = 25;

/** How each recordable action reads, and how it is coloured. */
const ACTION_PRESENTATION: Record<
  MessagingComplianceAction,
  { readonly label: string; readonly badge: string }
> = {
  message_send: { label: 'Message sent', badge: 'bg-blue-100 text-blue-800' },
  message_edit: { label: 'Message edited', badge: 'bg-yellow-100 text-yellow-800' },
  message_delete: { label: 'Message deleted', badge: 'bg-red-100 text-red-800' },
  channel_create: { label: 'Channel created', badge: 'bg-green-100 text-green-800' },
  channel_archive: { label: 'Channel archived', badge: 'bg-gray-100 text-gray-800' },
  member_add: { label: 'Member added', badge: 'bg-purple-100 text-purple-800' },
  member_remove: { label: 'Member removed', badge: 'bg-orange-100 text-orange-800' },
  // The four an auditor comes here for. The previous filter offered none.
  message_export: { label: 'Messages exported', badge: 'bg-indigo-100 text-indigo-800' },
  data_anonymize: { label: 'Data anonymised', badge: 'bg-pink-100 text-pink-800' },
  retention_set: { label: 'Retention changed', badge: 'bg-teal-100 text-teal-800' },
  legal_hold_toggle: { label: 'Legal hold changed', badge: 'bg-red-100 text-red-800' },
};

/**
 * One CSV field, quoted.
 *
 * Every field, not just `details`. The previous export quoted `details` alone,
 * so a tenant or resource value containing a comma silently added a column and
 * shifted every field after it — in a file handed to an auditor as the record.
 */
const csvField = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/** `details` as one readable line, or nothing when the row carries none. */
function detailsLine(details: Record<string, unknown> | null): string {
  if (details === null) return '';
  return Object.entries(details)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('; ');
}

// ============================================================================
// Main Component
// ============================================================================

const MessagingAuditPage: React.FC = () => {
  /**
   * Which tenant's log this is. Required, not a filter: the route refuses a
   * request without one, and the audit rows live in that tenant's schema.
   */
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [filters, setFilters] = useState<AuditFilters>(INITIAL_FILTERS);

  /**
   * The cursor trail, so Previous can go back.
   *
   * The route is CURSOR-paginated: it returns the cursor for the NEXT page and
   * has no notion of an offset, so a page number cannot be turned into a
   * request. The trail's last entry is the cursor of the page on screen —
   * `null` for the first — and Previous pops it.
   */
  const [cursorTrail, setCursorTrail] = useState<readonly (string | null)[]>([null]);
  const cursor = cursorTrail[cursorTrail.length - 1] ?? null;

  const requestFilters = useMemo(
    () => ({
      tenantId: tenantId ?? '',
      limit: PAGE_SIZE,
      ...(cursor === null ? {} : { cursor }),
      ...(filters.userId === '' ? {} : { userId: filters.userId }),
      ...(filters.action === '' ? {} : { action: filters.action }),
      ...(filters.startDate === '' ? {} : { startDate: filters.startDate }),
      ...(filters.endDate === '' ? {} : { endDate: filters.endDate }),
    }),
    [tenantId, cursor, filters],
  );

  const auditQuery = useAdminQuery<AuditPage>(
    adminKeys.messaging.audit(requestFilters),
    ({ signal }) => messagingApi.getAuditLog(requestFilters, signal),
    { enabled: tenantId !== null },
  );

  const page = auditQuery.data;
  const entries: readonly MessagingAuditEntry[] = page?.items ?? [];

  const applyFilter = <K extends keyof AuditFilters>(field: K, value: AuditFilters[K]): void => {
    setFilters((prev) => ({ ...prev, [field]: value }));
    // A new filter is a new result set; the old cursors point into the old one.
    setCursorTrail([null]);
  };

  const resetFilters = (): void => {
    setFilters(INITIAL_FILTERS);
    setCursorTrail([null]);
  };

  const selectTenant = (next: string): void => {
    setTenantId(next === '' ? null : next);
    setCursorTrail([null]);
  };

  const exportCsv = (): void => {
    if (!page || entries.length === 0) return;

    // The export says what it is: one page of a cursor-paginated log, under
    // the filters that produced it. The previous file was named
    // `messaging-audit-<date>.csv` and held 25 rows out of `totalCount`, with
    // nothing on it to say so.
    const scope = [
      ['Messaging compliance audit log — ONE PAGE of a cursor-paginated read'],
      [`Tenant`, tenantId ?? ''],
      [`Rows in this file`, String(entries.length)],
      [`Rows matching the filters`, String(page.totalCount)],
      [`Filter: user`, filters.userId],
      [`Filter: action`, filters.action],
      [`Filter: from`, filters.startDate],
      [`Filter: to`, filters.endDate],
      [],
    ];
    const headers = [
      'Recorded at',
      'Tenant',
      'User',
      'Action',
      'Resource type',
      'Resource id',
      'Details',
      'IP address',
      'User agent',
    ];
    const rows = entries.map((entry) => [
      entry.createdAt,
      entry.tenantId,
      entry.userId,
      entry.action,
      entry.resourceType,
      entry.resourceId,
      detailsLine(entry.details),
      entry.ipAddress ?? '',
      entry.userAgent ?? '',
    ]);

    const csv = [...scope, headers, ...rows]
      .map((row) => row.map(csvField).join(','))
      .join('\n');
    saveBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
      `messaging-audit-${tenantId ?? 'no-tenant'}-page-${cursorTrail.length}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`,
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Messaging Audit Log</h1>
          <p className="text-sm text-gray-500 mt-1">
            Every recorded messaging operation for one tenant, newest first.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="w-72">
            <label htmlFor="audit-tenant" className="block text-xs font-medium text-gray-600 mb-1">
              Tenant
            </label>
            <div id="audit-tenant">
              <TenantSelect value={tenantId} onChange={selectTenant} />
            </div>
          </div>
          <Button
            onClick={exportCsv}
            variant="secondary"
            size="sm"
            disabled={entries.length === 0}
          >
            Export this page
          </Button>
          <Button
            onClick={() => void auditQuery.refetch()}
            disabled={tenantId === null || auditQuery.isFetching}
            variant="secondary"
            size="sm"
          >
            {auditQuery.isFetching ? 'Loading...' : 'Refresh'}
          </Button>
        </div>
      </div>

      <QueryFailureNotice
        errors={[auditQuery.error]}
        hasContent={entries.length > 0}
        onRetry={() => void auditQuery.refetch()}
      />

      {tenantId === null ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-700">Choose a tenant</p>
          <p className="text-xs text-gray-500 mt-1">
            The audit log is held per tenant and the route refuses a request without one. No
            table is shown until a tenant is selected — an empty table here would read as an
            absence of activity rather than an absence of a question.
          </p>
        </div>
      ) : (
        <>
          {/* Filters */}
          <Card>
            <div className="p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label
                    htmlFor="audit-user"
                    className="block text-xs font-medium text-gray-500 mb-1"
                  >
                    User ID
                  </label>
                  <input
                    id="audit-user"
                    type="text"
                    placeholder="Filter by user..."
                    value={filters.userId}
                    onChange={(e) => applyFilter('userId', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
                  />
                </div>
                <div>
                  <label
                    htmlFor="audit-action"
                    className="block text-xs font-medium text-gray-500 mb-1"
                  >
                    Action
                  </label>
                  <select
                    id="audit-action"
                    value={filters.action}
                    onChange={(e) =>
                      applyFilter('action', e.target.value as MessagingComplianceAction | '')
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
                  >
                    <option value="">All Actions</option>
                    {MESSAGING_COMPLIANCE_ACTIONS.map((action) => (
                      <option key={action} value={action}>
                        {ACTION_PRESENTATION[action].label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="audit-from"
                    className="block text-xs font-medium text-gray-500 mb-1"
                  >
                    Start Date
                  </label>
                  <input
                    id="audit-from"
                    type="date"
                    value={filters.startDate}
                    onChange={(e) => applyFilter('startDate', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
                  />
                </div>
                <div>
                  <label htmlFor="audit-to" className="block text-xs font-medium text-gray-500 mb-1">
                    End Date
                  </label>
                  <input
                    id="audit-to"
                    type="date"
                    value={filters.endDate}
                    onChange={(e) => applyFilter('endDate', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
                  />
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  onClick={resetFilters}
                  className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                >
                  Reset Filters
                </button>
              </div>
            </div>
          </Card>

          {/* Table */}
          <Card>
            <div className="overflow-x-auto">
              {auditQuery.isPending ? (
                <div className="flex items-center justify-center py-16">
                  <p className="text-sm text-gray-400">Loading audit entries...</p>
                </div>
              ) : auditQuery.isError ? (
                // The banner above carries the reason. Nothing is drawn here:
                // an empty table on an audit trail asserts that nothing
                // happened.
                null
              ) : entries.length === 0 ? (
                <div className="flex items-center justify-center py-16">
                  <div className="text-center">
                    <p className="text-sm text-gray-500">
                      No audit entries match these filters.
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      The read succeeded and returned nothing.
                    </p>
                  </div>
                </div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Recorded At
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        User
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Action
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Resource
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Details
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        From
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {entries.map((entry) => (
                      <tr key={entry.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
                          {new Date(entry.createdAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600 font-mono">
                          {entry.userId}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-0.5 text-xs font-semibold rounded-full ${ACTION_PRESENTATION[entry.action].badge}`}
                          >
                            {ACTION_PRESENTATION[entry.action].label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          <p>{entry.resourceType}</p>
                          <p className="text-xs text-gray-400 font-mono">{entry.resourceId}</p>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">
                          {/* `details` is jsonb: rendered bare it was
                              `[object Object]`, and null is not "no detail
                              recorded" written as an empty string. */}
                          {entry.details === null ? '—' : detailsLine(entry.details)}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                          {entry.ipAddress ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination — cursor, because that is what the route offers */}
            {page && entries.length > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
                <p className="text-sm text-gray-500">
                  Page {cursorTrail.length} · showing {entries.length} of {page.totalCount}{' '}
                  matching {page.totalCount === 1 ? 'entry' : 'entries'}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCursorTrail((trail) => trail.slice(0, -1))}
                    disabled={cursorTrail.length <= 1}
                    className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() =>
                      setCursorTrail((trail) =>
                        page.cursor === null ? trail : [...trail, page.cursor],
                      )
                    }
                    disabled={!page.hasMore || page.cursor === null}
                    className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
};

export default MessagingAuditPage;
