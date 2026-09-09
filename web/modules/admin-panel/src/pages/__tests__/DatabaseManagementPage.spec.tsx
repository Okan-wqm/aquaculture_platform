/**
 * DatabaseManagementPage on the admin data layer (ADMIN-HIGH-121), and the
 * four platform totals it computed in the browser (ADMIN-HIGH-132).
 *
 * The Schemas tab printed "Total Schemas", "Active", "Total Size" and "Total
 * Tables" above the list — and derived all four from that list, which is
 * fetched with `limit: 100`:
 *
 * ```ts
 * {schemas.length}
 * {schemas.filter((s) => s.status === 'active').length}
 * {formatBytes(schemas.reduce((sum, s) => sum + (s.sizeBytes || 0), 0))}
 * {schemas.reduce((sum, s) => sum + (s.tableCount || 0), 0)}
 * ```
 *
 * Past a hundred tenants none of those is a total. The server has owned the
 * aggregate all along — `GET /database/schemas/summary` — but the admin-panel's
 * hand-written type for it named four fields the server has never returned
 * (`total`, `active`, `suspended`, `deleted`), and nothing caught that because
 * the method had no caller and the route's inline return type left `"200": {}`
 * in the OpenAPI artifact.
 *
 * Also covered: the "Create Schema" button that had no `onClick`, and the
 * isolation check whose result went to `alert()`.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import DatabaseManagementPage from '../DatabaseManagementPage';
import { databaseApi } from '../../services/api/database';
import type { SchemaMigration } from '../../services/types/database';

vi.mock('../../services/api/database', () => ({
  databaseApi: {
    getSchemaSummary: vi.fn(),
    getSchemas: vi.fn(),
    validateSchemaIsolation: vi.fn(),
    getAvailableMigrations: vi.fn(),
    getMigrationHistory: vi.fn(),
    getDatabaseHealth: vi.fn(),
    getConnectionStats: vi.fn(),
    getStorageByTenant: vi.fn(),
    getSlowQueries: vi.fn(),
    getIndexRecommendations: vi.fn(),
  },
}));

const summaryMock = vi.mocked(databaseApi.getSchemaSummary);
const schemasMock = vi.mocked(databaseApi.getSchemas);
const validateMock = vi.mocked(databaseApi.validateSchemaIsolation);
const plansMock = vi.mocked(databaseApi.getAvailableMigrations);
const historyMock = vi.mocked(databaseApi.getMigrationHistory);

type SchemaRow = Awaited<ReturnType<typeof databaseApi.getSchemas>>['data'][number];

function schemaRow(): SchemaRow {
  return {
    tenantId: 'tenant-1',
    schemaName: 'tenant_0001',
    status: 'active',
    currentVersion: '1.4.0',
    sizeBytes: 4096,
    tableCount: 12,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as SchemaRow;
}

/** One page of whatever the caller is listing — the platform page contract. */
function page<T>(
  rows: T[],
  limit: number,
): {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
} {
  return {
    data: rows,
    total: rows.length,
    page: 1,
    limit,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

/** The estate is far larger than the page: 412 schemas, 100 rows listed. */
function summary(): Awaited<ReturnType<typeof databaseApi.getSchemaSummary>> {
  return {
    totalSchemas: 412,
    activeSchemas: 380,
    suspendedSchemas: 32,
    totalSizeBytes: 5_368_709_120,
    totalTableCount: 9_744,
    avgSizeBytes: 13_030_847,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DatabaseManagementPage />
    </QueryClientProvider>,
  );
}

/** The summary card carrying `label` — the label's div, one level up. */
function card(label: string): HTMLElement {
  const parent = screen.getByText(label).parentElement;
  if (!parent) throw new Error(`no card for ${label}`);
  return parent;
}

describe('DatabaseManagementPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    summaryMock.mockResolvedValue(summary());
    schemasMock.mockResolvedValue(page([schemaRow()], 100));
    validateMock.mockResolvedValue({ valid: true, issues: [] });
    plansMock.mockResolvedValue([]);
    historyMock.mockResolvedValue(page<SchemaMigration>([], 50));
  });

  it('forwards the abort signal to both schema reads', async () => {
    renderPage();

    await waitFor(() => expect(summaryMock).toHaveBeenCalled());
    expect(summaryMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(schemasMock).toHaveBeenCalled());
    expect(schemasMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("shows the server's platform totals, not the listed page's subtotals", async () => {
    renderPage();

    // The regression: one listed row would have produced 1 / 1 / 4 KB / 12 —
    // so every card is asserted inside its own card, not page-wide, where the
    // single row's own `tableCount: 12` would satisfy a loose matcher.
    await screen.findByText('412');
    expect(within(card('Total Schemas')).getByText('412')).toBeInTheDocument();
    expect(within(card('Active')).getByText('380')).toBeInTheDocument();
    expect(within(card('Total Tables')).getByText('9,744')).toBeInTheDocument();
    expect(within(card('Total Size')).getByText('5 GB')).toBeInTheDocument();
  });

  it('says how much of the estate the list is showing', async () => {
    renderPage();

    expect(await screen.findByText(/showing 1 of 412/)).toBeInTheDocument();
  });

  it('renders an em dash rather than a zero when the aggregate fails', async () => {
    summaryMock.mockRejectedValue(new Error('summary unavailable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('summary unavailable');
    expect(within(card('Total Schemas')).getByText('—')).toBeInTheDocument();
  });

  it('offers no Create Schema button, because no route creates one', async () => {
    renderPage();

    await screen.findByText('412');
    expect(screen.queryByRole('button', { name: 'Create Schema' })).not.toBeInTheDocument();
  });

  it('renders the isolation issues in the panel instead of an alert() dialog', async () => {
    validateMock.mockResolvedValue({
      valid: false,
      issues: ['public.users is reachable from tenant_0001'],
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View' }));
    await user.click(screen.getByRole('button', { name: 'Validate Isolation' }));

    expect(
      await screen.findByText('public.users is reachable from tenant_0001'),
    ).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('keeps the migrations that loaded when the history read fails', async () => {
    plansMock.mockResolvedValue([
      {
        version: '1809300000000',
        name: 'AddSchemaSummaryTotals',
        description: 'adds the aggregate',
        affectedTables: ['tenant_schemas'],
        estimatedDuration: 1500,
        isDestructive: false,
        requiresDowntime: false,
      },
    ]);
    historyMock.mockRejectedValue(new Error('migration history unavailable'));
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Migrations' }));

    // The regression: either read failing replaced the whole tab with one
    // error state, hiding the half that had loaded.
    expect(await screen.findByText('AddSchemaSummaryTotals')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('migration history unavailable');
  });
});
