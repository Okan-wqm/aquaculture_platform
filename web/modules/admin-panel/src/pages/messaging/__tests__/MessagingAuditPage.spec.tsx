/**
 * The forensic trail that could not display a single correct row
 * (ADMIN-CRITICAL-150).
 *
 * `GET /messaging/audit` declares `@TenantParam('query') tenantId: string`,
 * and the page's tenant box was an optional free-text filter defaulting to
 * `''`, sent as `undefined`. The DEFAULT state of the page therefore refused
 * with `BadRequestException('tenantId is required')`, and the table drew
 * "No audit entries found. Audit entries will appear once messaging activity
 * begins." — explaining an absence it had not established.
 *
 * With a valid tenant it was worse: the route answers
 * `{items, hasMore, cursor, totalCount}`, the client declared an offset page
 * with `data`, so `entries` became `undefined` and the render threw.
 *
 * The row type invented `timestamp` (the column is `createdAt`), `tenantName`,
 * `userName`, `channelId` and `messageId`, and typed `details` a string when
 * it is `jsonb | null` — so the cell showed `[object Object]` and the CSV
 * export called `.replace` on an object. The pager sent `page`/`pageSize`,
 * which the route does not have; it takes `limit`/`cursor`. And none of the
 * seven action filter values is a member of `ComplianceAction`.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import MessagingAuditPage from '../MessagingAuditPage';
import { messagingApi } from '../../../services/api/messaging';
import { tenantsApi } from '../../../services/adminApi';
import type {
  MessagingAuditEntry,
  MessagingAuditPage as AuditPage,
} from '../../../services/api/messaging';

vi.mock('../../../services/api/messaging', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api/messaging')>(
    '../../../services/api/messaging',
  );
  return { ...actual, messagingApi: { getAuditLog: vi.fn() } };
});

vi.mock('../../../services/adminApi', async () => {
  const actual = await vi.importActual<typeof import('../../../services/adminApi')>(
    '../../../services/adminApi',
  );
  return { ...actual, tenantsApi: { list: vi.fn() } };
});

const auditLog = vi.mocked(messagingApi.getAuditLog);
const tenantList = vi.mocked(tenantsApi.list);

const TENANT_ID = '22222222-2222-4222-8222-222222222222';

/** Complete, as `messaging.compliance_audit_logs` holds it — no cast. */
function entry(overrides: Partial<MessagingAuditEntry> = {}): MessagingAuditEntry {
  return {
    id: 'audit-1',
    tenantId: TENANT_ID,
    userId: '33333333-3333-4333-8333-333333333333',
    action: 'legal_hold_toggle',
    resourceType: 'channel',
    resourceId: '44444444-4444-4444-8444-444444444444',
    details: { released: true, matter: '2026-14' },
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    createdAt: '2026-09-01T10:15:00.000Z',
    ...overrides,
  };
}

function auditPage(overrides: Partial<AuditPage> = {}): AuditPage {
  return {
    items: [entry()],
    hasMore: false,
    cursor: null,
    totalCount: 1,
    ...overrides,
  };
}

function tenantPage(): Awaited<ReturnType<typeof tenantsApi.list>> {
  return {
    data: [
      {
        id: TENANT_ID,
        name: 'Kuzey Su',
        slug: 'kuzey-su',
        status: 'active',
        tier: 'enterprise',
        userCount: 24,
        farmCount: 3,
        sensorCount: 48,
        isTrialActive: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    total: 1,
    page: 1,
    limit: 500,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessagingAuditPage />
    </QueryClientProvider>,
  );
}

async function renderAndSelectTenant(): Promise<void> {
  renderPage();
  const actor = userEvent.setup();
  await actor.click(await screen.findByRole('button', { name: /Select a tenant/ }));
  await actor.click(await screen.findByRole('button', { name: /Kuzey Su enterprise/ }));
}

describe('MessagingAuditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantList.mockResolvedValue(tenantPage());
    auditLog.mockResolvedValue(auditPage());
  });

  it('reads nothing until a tenant is named, because the route refuses otherwise', async () => {
    renderPage();

    await waitFor(() => expect(tenantList).toHaveBeenCalled());
    expect(auditLog).not.toHaveBeenCalled();
    expect(await screen.findByText('Choose a tenant')).toBeInTheDocument();
  });

  it("sends the route's own parameters — tenantId, limit, cursor — and an abort signal", async () => {
    await renderAndSelectTenant();

    await waitFor(() => expect(auditLog).toHaveBeenCalled());
    const request = auditLog.mock.calls[0]?.[0];
    expect(request).toMatchObject({ tenantId: TENANT_ID, limit: 25 });
    // `page` and `pageSize` are not parameters this route has; sending them
    // made every page return the same rows.
    expect(request).not.toHaveProperty('page');
    expect(request).not.toHaveProperty('pageSize');
    expect(auditLog.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('renders the row the table actually receives', async () => {
    await renderAndSelectTenant();

    // Scoped to the row, because the action label also appears in the filter's
    // option list — and that list existing is the point of the next test.
    const row = (await screen.findByText('203.0.113.7')).closest('tr');
    expect(row).not.toBeNull();

    // `createdAt`, not `timestamp` — the old field produced "Invalid Date".
    expect(row).toHaveTextContent(new Date('2026-09-01T10:15:00.000Z').toLocaleString());
    expect(screen.queryByText('Invalid Date')).not.toBeInTheDocument();
    // The action label comes from the enum the column holds.
    expect(row).toHaveTextContent('Legal hold changed');
    // `resourceType` + `resourceId` — the fields that say what was acted on,
    // where the page used to show two blank channel/message columns.
    expect(row).toHaveTextContent('channel');
    expect(row).toHaveTextContent('44444444-4444-4444-8444-444444444444');
    // jsonb details, not `[object Object]`.
    expect(row).toHaveTextContent('released=true');
    expect(row).not.toHaveTextContent('[object Object]');
  });

  it('shows an em dash for a row that recorded no details', async () => {
    auditLog.mockResolvedValue(auditPage({ items: [entry({ details: null, ipAddress: null })] }));
    await renderAndSelectTenant();

    expect((await screen.findAllByText('—')).length).toBeGreaterThanOrEqual(2);
  });

  it('offers the compliance actions an auditor comes for', async () => {
    await renderAndSelectTenant();

    const actionFilter = await screen.findByLabelText('Action');
    const offered = Array.from(actionFilter.querySelectorAll('option')).map((o) => o.value);
    // The pre-fix list was send/edit/delete/create_channel/join_channel/
    // leave_channel/upload_file — none of them a member of ComplianceAction.
    expect(offered).toContain('message_export');
    expect(offered).toContain('data_anonymize');
    expect(offered).toContain('retention_set');
    expect(offered).toContain('legal_hold_toggle');
    expect(offered).not.toContain('upload_file');
  });

  it('names a failed read and draws no table at all', async () => {
    auditLog.mockRejectedValue(new Error('tenantId is required'));
    await renderAndSelectTenant();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('tenantId is required'))).toBe(true);
    // The regression: the empty state claimed entries "will appear once
    // messaging activity begins".
    expect(
      screen.queryByText(/will appear once messaging activity begins/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No audit entries match these filters/)).not.toBeInTheDocument();
  });

  it('distinguishes a successful empty read from a failed one', async () => {
    auditLog.mockResolvedValue(auditPage({ items: [], totalCount: 0 }));
    await renderAndSelectTenant();

    expect(await screen.findByText('No audit entries match these filters.')).toBeInTheDocument();
    expect(screen.getByText('The read succeeded and returned nothing.')).toBeInTheDocument();
  });

  it('pages by cursor, carrying the returned cursor into the next request', async () => {
    auditLog.mockResolvedValue(auditPage({ hasMore: true, cursor: 'cursor-2', totalCount: 40 }));
    await renderAndSelectTenant();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Next' }));

    await waitFor(() => expect(auditLog).toHaveBeenCalledTimes(2));
    expect(auditLog.mock.calls[1]?.[0]).toMatchObject({ cursor: 'cursor-2' });
  });

  it('keeps Next disabled when the route says there is no more', async () => {
    await renderAndSelectTenant();

    expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });
});
