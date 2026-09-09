/**
 * DatabaseExplorerPage on the admin data layer (ADMIN-HIGH-121), and the three
 * things its hand-rolled reads and writes got wrong.
 *
 * 1. **The sidebar row count never refreshed after a write.** The table list
 *    (`rowCount`, `sizeBytes` per table) was fetched once per schema into
 *    `useState`; a row insert or delete refetched only the grid. The operator
 *    deleted a row, watched it leave the table, and read "1,204 rows" in the
 *    sidebar for the rest of the session.
 *
 * 2. **Row actions were rendered on tables that cannot have them.** `handleSaveRow`
 *    looked for a primary-key column and, finding none, fell through to
 *    `loadTableData()` — so an edit on a key-less table issued no request and
 *    closed the editor exactly as a successful save does. `confirmDelete` did
 *    the same in reverse: no key, no state change, a delete button that did
 *    nothing at all and said nothing about it.
 *
 * 3. **The export hand-built its own HTTP stack.** `exportExplorerTable`
 *    returned a URL string, so the page fetched it with a manually attached
 *    bearer token, outside the token-lifecycle barrier and the 401 refresh —
 *    and replaced every server error with the literal `Failed to export data`,
 *    including the 429 this route returns after five exports in an hour.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import DatabaseExplorerPage from '../DatabaseExplorerPage';
import { databaseApi } from '../../services/adminApi';
import { saveBlob } from '../../services/blob-client';

vi.mock('../../services/adminApi', () => ({
  databaseApi: {
    getExplorerSchemas: vi.fn(),
    getExplorerTables: vi.fn(),
    getExplorerTableData: vi.fn(),
    insertExplorerRow: vi.fn(),
    updateExplorerRow: vi.fn(),
    deleteExplorerRow: vi.fn(),
    exportExplorerTable: vi.fn(),
  },
}));

vi.mock('../../services/blob-client', () => ({
  saveBlob: vi.fn(),
}));

const schemasMock = vi.mocked(databaseApi.getExplorerSchemas);
const tablesMock = vi.mocked(databaseApi.getExplorerTables);
const dataMock = vi.mocked(databaseApi.getExplorerTableData);
const deleteMock = vi.mocked(databaseApi.deleteExplorerRow);
const exportMock = vi.mocked(databaseApi.exportExplorerTable);
const saveBlobMock = vi.mocked(saveBlob);

type Column = Awaited<ReturnType<typeof databaseApi.getExplorerTableData>>['columns'][number];

function column(overrides: Partial<Column> = {}): Column {
  return {
    columnName: 'id',
    dataType: 'uuid',
    isNullable: false,
    columnDefault: 'gen_random_uuid()',
    isPrimaryKey: true,
    isForeignKey: false,
    ...overrides,
  };
}

const KEYED_COLUMNS: Column[] = [
  column(),
  column({
    columnName: 'name',
    dataType: 'varchar',
    columnDefault: null,
    isPrimaryKey: false,
  }),
];

const KEYLESS_COLUMNS: Column[] = [
  column({ columnName: 'tenant_id', isPrimaryKey: false, columnDefault: null }),
  column({
    columnName: 'module_id',
    dataType: 'uuid',
    columnDefault: null,
    isPrimaryKey: false,
  }),
];

function tableList(): Awaited<ReturnType<typeof databaseApi.getExplorerTables>> {
  return [
    {
      tableName: 'tenants',
      schemaName: 'public',
      rowCount: 1204,
      sizeBytes: 2048,
      columns: KEYED_COLUMNS,
    },
  ];
}

function tableData(
  columns: Column[] = KEYED_COLUMNS,
): Awaited<ReturnType<typeof databaseApi.getExplorerTableData>> {
  return {
    tableName: 'tenants',
    columns,
    rows: [{ id: 'row-1', name: 'Acme', tenant_id: 'row-1', module_id: 'mod-1' }],
    totalRows: 1204,
    page: 1,
    limit: 50,
    totalPages: 25,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DatabaseExplorerPage />
    </QueryClientProvider>,
  );
}

async function openTenantsTable(): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /tenants/i }));
  await waitFor(() => expect(dataMock).toHaveBeenCalled());
}

describe('DatabaseExplorerPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schemasMock.mockResolvedValue(['public', 'auth']);
    tablesMock.mockResolvedValue(tableList());
    dataMock.mockResolvedValue(tableData());
    deleteMock.mockResolvedValue(undefined);
    exportMock.mockResolvedValue({
      blob: new Blob(['id,name\n'], { type: 'text/csv' }),
      filename: 'tenants_export.csv',
      contentType: 'text/csv',
    });
  });

  it('forwards the abort signal to all three reads', async () => {
    renderPage();

    await waitFor(() => expect(schemasMock).toHaveBeenCalled());
    expect(schemasMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(tablesMock).toHaveBeenCalled());
    expect(tablesMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    await openTenantsTable();
    expect(dataMock.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);
  });

  it('does not read table data until a table is selected', async () => {
    renderPage();

    await waitFor(() => expect(tablesMock).toHaveBeenCalled());
    expect(dataMock).not.toHaveBeenCalled();
  });

  it('refetches the table LIST after a row delete, not just the grid', async () => {
    renderPage();
    await openTenantsTable();

    const listCallsBefore = tablesMock.mock.calls.length;
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete row' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('public', 'tenants', 'row-1'));
    // The regression: the sidebar kept reporting 1,204 rows after the delete
    // because only the grid's query was refetched.
    await waitFor(() => expect(tablesMock.mock.calls.length).toBeGreaterThan(listCallsBefore));
  });

  it('offers no row actions on a table with no primary key', async () => {
    dataMock.mockResolvedValue(tableData(KEYLESS_COLUMNS));
    renderPage();
    await openTenantsTable();

    // Both buttons used to render and both did nothing — the edit silently
    // closed its modal as if it had saved.
    expect(await screen.findByText('no primary key')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit row' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete row' })).not.toBeInTheDocument();
  });

  it('saves the export under the filename the server sent', async () => {
    renderPage();
    await openTenantsTable();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /export/i }));
    await user.click(await screen.findByRole('button', { name: 'CSV' }));

    await waitFor(() => expect(saveBlobMock).toHaveBeenCalled());
    expect(saveBlobMock.mock.calls[0]?.[1]).toBe('tenants_export.csv');
  });

  it("reports the server's export error instead of 'Failed to export data'", async () => {
    exportMock.mockRejectedValue(new Error('Export rate limit exceeded: 5 requests per hour'));
    renderPage();
    await openTenantsTable();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /export/i }));
    await user.click(await screen.findByRole('button', { name: 'CSV' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Export rate limit exceeded: 5 requests per hour');
    expect(saveBlobMock).not.toHaveBeenCalled();
  });

  it('names the failed read rather than showing an empty table list', async () => {
    tablesMock.mockRejectedValue(new Error('schema public is unreachable'));
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('schema public is unreachable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
