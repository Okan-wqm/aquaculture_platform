/**
 * The litigation-hold dashboard that reported a perfect score from two
 * requests that always failed (ADMIN-CRITICAL-147).
 *
 * Both reads went out with NO tenant id, because the client's docblocks
 * promised that omitting it returned "platform-wide stats" and "all tenants".
 * Neither route has that mode: each declares
 * `@TenantParam('query') tenantId: string` with the default
 * `optional: false`, so `VerifiedTenantPipe` answers with
 * `BadRequestException('tenantId is required')`.
 *
 * Every load therefore 400'd, and `stats = statsQuery.data ?? EMPTY_STATS`
 * rendered the placeholder: **Compliance Score 100%** in green, 0 messages
 * under legal hold, 0 active holds, and a green tick over "No legal holds".
 * An error banner sat above six cards that stated numbers.
 *
 * These tests pin the three properties that make that impossible: nothing is
 * read until a tenant is named, no card states a figure the page does not
 * have, and a failed holds read never draws the "no holds" state.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import MessagingCompliancePage from '../MessagingCompliancePage';
import { messagingApi } from '../../../services/api/messaging';
import { tenantsApi } from '../../../services/adminApi';
import type { ComplianceStats, LegalHold } from '../../../services/api/messaging';

vi.mock('../../../services/api/messaging', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api/messaging')>(
    '../../../services/api/messaging',
  );
  return {
    ...actual,
    messagingApi: {
      getComplianceStats: vi.fn(),
      getLegalHolds: vi.fn(),
      releaseLegalHold: vi.fn(),
    },
  };
});

vi.mock('../../../services/adminApi', async () => {
  const actual = await vi.importActual<typeof import('../../../services/adminApi')>(
    '../../../services/adminApi',
  );
  return { ...actual, tenantsApi: { list: vi.fn() } };
});

const complianceStats = vi.mocked(messagingApi.getComplianceStats);
const legalHolds = vi.mocked(messagingApi.getLegalHolds);
const releaseHold = vi.mocked(messagingApi.releaseLegalHold);
const tenantList = vi.mocked(tenantsApi.list);

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function stats(): ComplianceStats {
  return {
    messagesUnderLegalHold: 4_120,
    pendingRetentionCleanup: 900,
    activeExports: 2,
    complianceScore: 64,
    activeHoldsCount: 3,
    retentionPoliciesCount: 7,
    auditEntriesCount: 51_004,
  };
}

function hold(overrides: Partial<LegalHold> = {}): LegalHold {
  return {
    id: 'hold-1',
    tenantId: TENANT_ID,
    tenantName: 'Kuzey Su',
    channelId: null,
    channelName: null,
    reason: 'Matter 2026-14: preservation order',
    startedBy: 'okan',
    startedAt: '2026-08-01T00:00:00.000Z',
    releasedBy: null,
    releasedAt: null,
    isActive: true,
    ...overrides,
  };
}

/** The tenant roster `TenantSelect` reads, complete as `Tenant` declares it. */
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
      <MessagingCompliancePage />
    </QueryClientProvider>,
  );
}

/** Render, then pick the one tenant out of the selector. */
async function renderAndSelectTenant(): Promise<void> {
  renderPage();
  const actor = userEvent.setup();
  await actor.click(await screen.findByRole('button', { name: /Select a tenant/ }));
  await actor.click(await screen.findByRole('button', { name: /Kuzey Su enterprise/ }));
}

describe('MessagingCompliancePage before a tenant is chosen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantList.mockResolvedValue(tenantPage());
    complianceStats.mockResolvedValue(stats());
    legalHolds.mockResolvedValue([]);
  });

  it('reads nothing, because neither route accepts a request without a tenant', async () => {
    renderPage();

    await waitFor(() => expect(tenantList).toHaveBeenCalled());
    expect(complianceStats).not.toHaveBeenCalled();
    expect(legalHolds).not.toHaveBeenCalled();
  });

  it('states no compliance score at all', async () => {
    renderPage();

    expect(await screen.findByText('Choose a tenant')).toBeInTheDocument();
    // The regression: `EMPTY_STATS.complianceScore` rendered "100%" here.
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    expect(screen.queryByText('Compliance Score')).not.toBeInTheDocument();
  });
});

describe('MessagingCompliancePage with a tenant chosen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantList.mockResolvedValue(tenantPage());
    complianceStats.mockResolvedValue(stats());
    legalHolds.mockResolvedValue([hold()]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the tenant id and an abort signal on both reads', async () => {
    await renderAndSelectTenant();

    await waitFor(() => expect(complianceStats).toHaveBeenCalled());
    expect(complianceStats.mock.calls[0]?.[0]).toBe(TENANT_ID);
    expect(complianceStats.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(legalHolds.mock.calls[0]?.[0]).toBe(TENANT_ID);
    expect(legalHolds.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("shows the server's real score rather than a placeholder", async () => {
    await renderAndSelectTenant();

    expect(await screen.findByText('64%')).toBeInTheDocument();
  });

  it('dashes every card when the aggregate fails, and names the failure', async () => {
    complianceStats.mockRejectedValue(new Error('tenantId is required'));
    await renderAndSelectTenant();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('tenantId is required'))).toBe(true);
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    // Six cards, all unknown.
    expect((await screen.findAllByText('—')).length).toBeGreaterThanOrEqual(6);
  });

  it('never draws "no legal holds" when the holds read failed', async () => {
    legalHolds.mockRejectedValue(new Error('legal holds are unreachable'));
    await renderAndSelectTenant();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('legal holds are unreachable'))).toBe(true);
    expect(screen.queryByText(/No legal holds/)).not.toBeInTheDocument();
  });

  it('still reports a genuinely empty hold list as empty', async () => {
    legalHolds.mockResolvedValue([]);
    await renderAndSelectTenant();

    expect(await screen.findByText('No legal holds on this tenant')).toBeInTheDocument();
  });

  it('asks before releasing a hold, and does not release when refused', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    await renderAndSelectTenant();

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /Release the legal hold on Kuzey Su/ }));

    expect(window.confirm).toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it('says which sections have no producer instead of drawing an empty one', async () => {
    await renderAndSelectTenant();

    expect(await screen.findByText('Export jobs')).toBeInTheDocument();
    expect(screen.getByText('Audit operations per day')).toBeInTheDocument();
    // The regression: three locally-built empty arrays rendered "No export
    // jobs found." and "No audit data available" — an absence read as a zero.
    expect(screen.queryByText('No export jobs found.')).not.toBeInTheDocument();
    expect(screen.queryByText('No audit data available')).not.toBeInTheDocument();
  });
});
