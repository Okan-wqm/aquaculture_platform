/**
 * The GDPR export that was fetched and thrown away (ADMIN-HIGH-153).
 *
 * `POST /messaging/tenants/:id/export` performs the export inside the request
 * and replies with `data`: the rows already serialised as JSON or CSV. Nothing
 * stores it server-side and there is no second endpoint to fetch it from, so
 * that response is the only copy that will ever exist.
 *
 * admin-api declared the reply as `{exportId, status}` — a field name the reply
 * does not use, five fields short — and the panel's own type listed six of the
 * seven, omitting `data`. So the page rendered "Export job accepted / Records:
 * 12,431" and discarded the export. An operator answering a portability
 * request ran it, watched it succeed, and had no file.
 *
 * The tenant was also typed by hand into a free-text UUID box, where a
 * valid-but-wrong id exports a DIFFERENT tenant's entire messaging history.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import MessagingTenantsPage from '../MessagingTenantsPage';
import { messagingApi } from '../../../services/api/messaging';
import { tenantsApi } from '../../../services/adminApi';
import { saveBlob } from '../../../services/blob-client';
import type { ExportTriggerResult } from '../../../services/api/messaging';
import type { MessagingTenantsOverview } from '../../../services/types/messaging';

vi.mock('../../../services/api/messaging', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api/messaging')>(
    '../../../services/api/messaging',
  );
  return { ...actual, messagingApi: { getTenantsOverview: vi.fn(), triggerExport: vi.fn() } };
});

vi.mock('../../../services/adminApi', async () => {
  const actual = await vi.importActual<typeof import('../../../services/adminApi')>(
    '../../../services/adminApi',
  );
  return { ...actual, tenantsApi: { list: vi.fn() } };
});

vi.mock('../../../services/blob-client', () => ({ saveBlob: vi.fn() }));

const overview = vi.mocked(messagingApi.getTenantsOverview);
const triggerExport = vi.mocked(messagingApi.triggerExport);
const tenantList = vi.mocked(tenantsApi.list);
const save = vi.mocked(saveBlob);

const TENANT_ID = '99999999-9999-4999-8999-999999999999';

function overviewPage(overrides: Partial<MessagingTenantsOverview> = {}): MessagingTenantsOverview {
  return {
    tenants: [
      {
        tenantId: TENANT_ID,
        messageCount24h: 900,
        messageCount7d: 5_400,
        totalMessages: 120_000,
        activeChannels: 12,
      },
    ],
    generatedAt: '2026-09-10T09:00:00.000Z',
    ...overrides,
  };
}

/** Complete, as the contract declares it — `data` included. */
function exportResult(overrides: Partial<ExportTriggerResult> = {}): ExportTriggerResult {
  return {
    jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'completed',
    format: 'json',
    recordCount: 12_431,
    data: '[{"id":"m-1","content":"hello"}]',
    isUnderLegalHold: true,
    exportedAt: '2026-09-10T09:30:00.000Z',
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

/**
 * Read a Blob's text.
 *
 * `Blob.text()` is not implemented in this jsdom, so the file is read the way
 * a browser would read it — which is also the only way to prove the export
 * PAYLOAD reached the download rather than an empty Blob of the right name.
 */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the blob'));
    reader.readAsText(blob);
  });
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessagingTenantsPage />
    </QueryClientProvider>,
  );
}

describe('MessagingTenantsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantList.mockResolvedValue(tenantPage());
    overview.mockResolvedValue(overviewPage());
    triggerExport.mockResolvedValue(exportResult());
  });

  it('forwards an abort signal to the overview read', async () => {
    renderPage();

    await waitFor(() => expect(overview).toHaveBeenCalled());
    expect(overview.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('hands over the exported file instead of discarding it', async () => {
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: /Select a tenant/ }));
    await actor.click(await screen.findByRole('button', { name: /Kuzey Su enterprise/ }));
    await actor.click(screen.getByRole('button', { name: 'Export and download' }));

    // The regression: `data` was not even in the client's type, and the page
    // showed a record count and dropped the only copy of the export.
    await waitFor(() => expect(save).toHaveBeenCalled());
    const [blob, filename] = save.mock.calls[0] ?? [];
    expect(await blobText(blob as Blob)).toBe('[{"id":"m-1","content":"hello"}]');
    expect(filename).toContain(TENANT_ID);
    expect(filename).toMatch(/\.json$/);
  });

  it('saves a CSV export as a CSV file', async () => {
    triggerExport.mockResolvedValue(exportResult({ format: 'csv', data: 'id,content\nm-1,hello' }));
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: /Select a tenant/ }));
    await actor.click(await screen.findByRole('button', { name: /Kuzey Su enterprise/ }));
    await actor.selectOptions(screen.getByLabelText('Format'), 'csv');
    await actor.click(screen.getByRole('button', { name: 'Export and download' }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[1]).toMatch(/\.csv$/);
    expect(await blobText(save.mock.calls[0]?.[0] as Blob)).toBe('id,content\nm-1,hello');
    expect(triggerExport.mock.calls[0]).toEqual([TENANT_ID, 'csv']);
  });

  it('cannot export until a tenant is picked, and picks it rather than typing it', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: 'Export and download' })).toBeDisabled();
    // The free-text UUID box is gone: a valid-but-wrong id exported another
    // tenant's whole messaging history.
    expect(screen.queryByPlaceholderText(/550e8400/)).not.toBeInTheDocument();
  });

  it('reports the legal-hold flag the export came back with', async () => {
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: /Select a tenant/ }));
    await actor.click(await screen.findByRole('button', { name: /Kuzey Su enterprise/ }));
    await actor.click(screen.getByRole('button', { name: 'Export and download' }));

    expect(await screen.findByText('Under legal hold')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText(/12,431 record\(s\) downloaded/)).toBeInTheDocument();
  });

  it('names a refused export and saves nothing', async () => {
    triggerExport.mockRejectedValue(new Error('export rejected: capability support-ops required'));
    renderPage();
    const actor = userEvent.setup();

    await actor.click(await screen.findByRole('button', { name: /Select a tenant/ }));
    await actor.click(await screen.findByRole('button', { name: /Kuzey Su enterprise/ }));
    await actor.click(screen.getByRole('button', { name: 'Export and download' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('capability support-ops required'))).toBe(
      true,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('names a failed overview read and claims nothing about tenant activity', async () => {
    overview.mockRejectedValue(new Error('tenant overview is unreachable'));
    renderPage();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('tenant overview is unreachable'))).toBe(
      true,
    );
    expect(
      screen.queryByText('No tenant messaging activity recorded yet.'),
    ).not.toBeInTheDocument();
  });

  it('still reports genuinely empty tenant activity as empty', async () => {
    overview.mockResolvedValue(overviewPage({ tenants: [] }));
    renderPage();

    expect(
      await screen.findByText('No tenant messaging activity recorded yet.'),
    ).toBeInTheDocument();
  });
});
