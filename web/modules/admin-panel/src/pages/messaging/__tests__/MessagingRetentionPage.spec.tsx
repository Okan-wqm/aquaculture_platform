/**
 * The page that sets how long a tenant's messages survive, and the button that
 * set nothing while looking like it had (ADMIN-CRITICAL-151).
 *
 * "+ Override" collected a channel id and a window, then `handleAddOverride`
 * discarded all three of its arguments, refetched, and closed the modal — a
 * false success on a data-deletion setting, over an endpoint that had accepted
 * `{channelId, retentionDays}` all along.
 *
 * "Edit" could never save: it sent `{defaultRetention, applyToAll}`, neither
 * key on the DTO, with `forbidNonWhitelisted: true` and no `retentionDays`;
 * and it addressed the route with the POLICY id where the path parameter is
 * the TENANT id.
 *
 * The list could never load — the route requires `tenantId` and the client
 * sent none — and would have crashed if it had, on seven invented row fields,
 * three of them counts rendered through `.toLocaleString()`.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import MessagingRetentionPage from '../MessagingRetentionPage';
import { messagingApi } from '../../../services/api/messaging';
import { tenantsApi } from '../../../services/adminApi';
import type { RetentionPolicy } from '../../../services/api/messaging';

vi.mock('../../../services/api/messaging', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api/messaging')>(
    '../../../services/api/messaging',
  );
  return {
    ...actual,
    messagingApi: { getRetentionPolicies: vi.fn(), updateRetentionPolicy: vi.fn() },
  };
});

vi.mock('../../../services/adminApi', async () => {
  const actual = await vi.importActual<typeof import('../../../services/adminApi')>(
    '../../../services/adminApi',
  );
  return { ...actual, tenantsApi: { list: vi.fn() } };
});

const policies = vi.mocked(messagingApi.getRetentionPolicies);
const setPolicy = vi.mocked(messagingApi.updateRetentionPolicy);
const tenantList = vi.mocked(tenantsApi.list);

const TENANT_ID = '55555555-5555-4555-8555-555555555555';
const CHANNEL_ID = '66666666-6666-4666-8666-666666666666';

/** Complete, as `messaging.retention_policies` holds it — no cast. */
function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    id: 'policy-1',
    tenantId: TENANT_ID,
    channelId: null,
    retentionDays: 365,
    createdBy: '77777777-7777-4777-8777-777777777777',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
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
      <MessagingRetentionPage />
    </QueryClientProvider>,
  );
}

async function renderAndSelectTenant(): Promise<void> {
  renderPage();
  const actor = userEvent.setup();
  await actor.click(await screen.findByRole('button', { name: /Select a tenant/ }));
  await actor.click(await screen.findByRole('button', { name: /Kuzey Su enterprise/ }));
}

describe('MessagingRetentionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantList.mockResolvedValue(tenantPage());
    policies.mockResolvedValue([policy()]);
    setPolicy.mockResolvedValue(policy({ retentionDays: 90 }));
  });

  it('reads nothing until a tenant is named, because the route refuses otherwise', async () => {
    renderPage();

    await waitFor(() => expect(tenantList).toHaveBeenCalled());
    expect(policies).not.toHaveBeenCalled();
    expect(await screen.findByText('Choose a tenant')).toBeInTheDocument();
  });

  it('sends the tenant id and an abort signal', async () => {
    await renderAndSelectTenant();

    await waitFor(() => expect(policies).toHaveBeenCalled());
    expect(policies.mock.calls[0]?.[0]).toBe(TENANT_ID);
    expect(policies.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('reads the window off the row in days, not off an invented label', async () => {
    await renderAndSelectTenant();

    // `retentionDays: 365`, rendered through the preset table. The old type
    // declared `defaultRetention: '1y'`, a field the wire never carried.
    expect(await screen.findByText('1 year')).toBeInTheDocument();
  });

  it('writes a channel override through the endpoint that has always accepted one', async () => {
    await renderAndSelectTenant();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: '+ Override' }));
    await actor.type(await screen.findByLabelText('Channel ID'), CHANNEL_ID);
    await actor.click(screen.getByRole('button', { name: 'Add override' }));

    // The regression: the handler discarded its arguments and closed the
    // modal, so this call never happened and the operator saw a success.
    await waitFor(() => expect(setPolicy).toHaveBeenCalled());
    expect(setPolicy.mock.calls[0]?.[0]).toBe(TENANT_ID);
    expect(setPolicy.mock.calls[0]?.[1]).toEqual({ channelId: CHANNEL_ID, retentionDays: 365 });
  });

  it('refuses to submit an override whose channel id is not a uuid', async () => {
    await renderAndSelectTenant();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: '+ Override' }));
    await actor.type(await screen.findByLabelText('Channel ID'), 'general');

    expect(screen.getByRole('button', { name: 'Add override' })).toBeDisabled();
    expect(screen.getByText(/Not a channel UUID/)).toBeInTheDocument();
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('addresses the tenant default with the TENANT id and a retentionDays body', async () => {
    await renderAndSelectTenant();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: 'Change' }));
    await actor.selectOptions(await screen.findByLabelText('Retention window'), '90');
    await actor.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setPolicy).toHaveBeenCalled());
    // Not the policy id, and not `{defaultRetention, applyToAll}`.
    expect(setPolicy.mock.calls[0]?.[0]).toBe(TENANT_ID);
    expect(setPolicy.mock.calls[0]?.[1]).toEqual({ channelId: null, retentionDays: 90 });
  });

  it('offers indefinite, and can send it', async () => {
    await renderAndSelectTenant();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: 'Change' }));
    await actor.selectOptions(await screen.findByLabelText('Retention window'), '-1');
    await actor.click(screen.getByRole('button', { name: 'Save' }));

    // The DTO's `@Min(1)` used to refuse the one window a legal-preservation
    // channel needs.
    await waitFor(() => expect(setPolicy).toHaveBeenCalled());
    expect(setPolicy.mock.calls[0]?.[1]).toEqual({ channelId: null, retentionDays: -1 });
  });

  it('warns only when the window is being SHORTENED', async () => {
    await renderAndSelectTenant();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: 'Change' }));
    // 365 -> 365: nothing is being deleted that was not already.
    expect(screen.queryByText(/This SHORTENS the window/)).not.toBeInTheDocument();

    await actor.selectOptions(await screen.findByLabelText('Retention window'), '90');
    expect(screen.getByText(/This SHORTENS the window/)).toBeInTheDocument();

    await actor.selectOptions(screen.getByLabelText('Retention window'), '1095');
    expect(screen.queryByText(/This SHORTENS the window/)).not.toBeInTheDocument();
  });

  it("names a failed read and claims nothing about the tenant's windows", async () => {
    policies.mockRejectedValue(new Error('tenantId is required'));
    await renderAndSelectTenant();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('tenantId is required'))).toBe(true);
    // The regression: "Retention policies will appear once tenants enable
    // messaging." — an explanation for an absence the page had not shown.
    expect(screen.queryByText(/will appear once tenants enable messaging/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No channel overrides/)).not.toBeInTheDocument();
  });

  it('says a missing default is not set, rather than showing a number it did not read', async () => {
    policies.mockResolvedValue([]);
    await renderAndSelectTenant();

    expect(await screen.findByText('Not set')).toBeInTheDocument();
    expect(screen.getByText(/No channel overrides/)).toBeInTheDocument();
  });

  it("names a refused write, where the old page's own write path was silent", async () => {
    setPolicy.mockRejectedValue(new Error('retentionDays must not be equal to 0'));
    await renderAndSelectTenant();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: 'Change' }));
    await actor.click(screen.getByRole('button', { name: 'Save' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('must not be equal to 0'))).toBe(true);
  });
});
