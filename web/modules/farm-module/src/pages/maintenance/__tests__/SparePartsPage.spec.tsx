/**
 * SparePartsPage specs (FARM-MEDIUM-120, FARM-HIGH-338).
 *
 * The page renders the spare-parts inventory list plus the stock-summary KPI
 * cards, both fetched from the backend (SpareParts + StockSummary).
 *
 * FARM-HIGH-338 moved spare-part stock into the storage ledger. These specs
 * lock the web side of that contract through the REAL useMaintenance hooks:
 *   - create sends `openingQuantity` + `storageLocationId`, never `quantity`,
 *     `status` or `code` (GraphQL rejects unknown input fields);
 *   - a positive opening stock without a location never reaches the backend;
 *   - update sends neither `quantity` nor `status` and re-homes the location;
 *   - the stock-movement modal calls `recordSparePartStockMovement` (not the
 *     storage module's `recordStockMovement`) with an explicit location;
 *   - relocation is a `transfer` movement through that same door (never the
 *     storage `transferStock`, which refuses spare parts).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../../test-utils/sharedUiMock')).createSharedUiMock(),
);

import { I18nProvider } from '@aquaculture/shared-ui';
import { requestMock, TEST_TENANT_ID } from '../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { SparePartsPage } from '../SparePartsPage';

const LOC_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const LOC_B = '22222222-bbbb-4bbb-8bbb-222222222222';

function storageLocation(id: string, name: string, code: string): Record<string, unknown> {
  return {
    id,
    tenantId: TEST_TENANT_ID,
    siteId: 'site-1',
    name,
    code,
    type: 'WAREHOUSE',
    description: null,
    capacity: null,
    capacityUnit: 'm3',
    usedCapacity: 0,
    temperatureMin: null,
    temperatureMax: null,
    humidityMin: null,
    humidityMax: null,
    isActive: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const SPARE_PART = {
  id: 'sp-1',
  tenantId: TEST_TENANT_ID,
  code: 'SP-000001',
  name: 'Impeller seal kit',
  partNumber: 'AP-SEAL-42',
  description: null,
  equipmentTypeId: null,
  compatibleEquipmentTypes: [],
  supplierId: null,
  manufacturer: 'AquaPumps',
  quantity: 4,
  onOrderQuantity: 6,
  minStock: 2,
  maxStock: 10,
  reorderPoint: 3,
  unit: 'kit',
  status: 'ON_ORDER',
  storageLocationId: LOC_A,
  binDetail: { warehouse: 'Hall 1', shelf: 'B2', bin: '7', notes: 'top row' },
  unitPrice: 120,
  unitPriceDecimal: '120.00',
  currency: 'NOK',
  specifications: null,
  leadTimeDays: 7,
  lastOrderDate: null,
  lastUsedDate: null,
  notes: null,
  isActive: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
  version: 1,
};

beforeEach(() => {
  requestMock.mockReset();
  routeGraphql([
    {
      match: 'query SpareParts',
      result: {
        spareParts: {
          items: [SPARE_PART],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      },
    },
    {
      match: 'query StockSummary',
      result: {
        stockSummary: {
          totalParts: 1,
          inStockCount: 0,
          lowStockCount: 0,
          outOfStockCount: 0,
          totalValueDecimal: '480.00',
        },
      },
    },
    {
      match: 'query StorageLocations',
      result: {
        storageLocations: {
          items: [
            storageLocation(LOC_A, 'Main store', 'MS-1'),
            storageLocation(LOC_B, 'Workshop', 'WS-1'),
          ],
          total: 2,
          page: 1,
          limit: 100,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      },
    },
    { match: 'mutation CreateSparePart', result: { createSparePart: SPARE_PART } },
    { match: 'mutation UpdateSparePart', result: { updateSparePart: SPARE_PART } },
    {
      match: 'mutation RecordSparePartStockMovement',
      result: { recordSparePartStockMovement: SPARE_PART },
    },
  ]);
});

/** The `input` variable of every request whose operation text contains `match`. */
function inputsOf(match: string): Record<string, unknown>[] {
  return requestMock.mock.calls
    .filter(([query]) => (query as string).includes(match))
    .map(([, variables]) => (variables as { input: Record<string, unknown> }).input);
}

/** Renders the page with the Turkish locale pinned (the modal buttons go through useI18n). */
function renderPage(): void {
  renderWithProviders(
    <I18nProvider locale="tr">
      <SparePartsPage />
    </I18nProvider>,
  );
}

/** Waits until the location picker options (StorageLocations query) have rendered. */
async function waitForLocationOptions(dialog: HTMLElement): Promise<void> {
  await within(dialog).findByRole('option', { name: 'Main store (MS-1)' });
}

describe('SparePartsPage', () => {
  it('renders the spare-parts page from the backend list + stock-summary queries', async () => {
    renderPage();

    expect(await screen.findByText('Yedek Parçalar')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([q]) => (q as string).includes('query SpareParts')),
      ).toBe(true);
    });
  });

  it('shows the ledger-derived quantity, status and on-order quantity', async () => {
    renderPage();

    expect(await screen.findByText('Impeller seal kit')).toBeInTheDocument();
    expect(screen.getByText('4 kit')).toBeInTheDocument();
    expect(screen.getByText('+6 kit siparişte')).toBeInTheDocument();
    // Status column badge (the status filter <option> carries the same text).
    expect(screen.getAllByText('Siparişte').some((el) => el.tagName !== 'OPTION')).toBe(true);
  });

  it('create sends openingQuantity + storageLocationId and never quantity/status/code', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Impeller seal kit');

    await user.click(screen.getByRole('button', { name: 'Yeni Yedek Parça' }));
    const dialog = await screen.findByRole('dialog');
    await waitForLocationOptions(dialog);

    await user.type(within(dialog).getByLabelText(/Parça Numarası/), 'AP-IMP-7');
    await user.type(within(dialog).getByLabelText(/Parça Adı/), 'Impeller');
    const opening = within(dialog).getByLabelText(/Açılış stoğu/);
    await user.clear(opening);
    await user.type(opening, '5');
    await user.selectOptions(within(dialog).getByLabelText(/Depolama Lokasyonu/), LOC_B);
    await user.type(within(dialog).getByLabelText(/Raf/), 'C3');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));

    await waitFor(() => expect(inputsOf('createSparePart(')).toHaveLength(1));
    const [input] = inputsOf('createSparePart(');
    expect(input).toMatchObject({
      name: 'Impeller',
      partNumber: 'AP-IMP-7',
      openingQuantity: 5,
      storageLocationId: LOC_B,
      binDetail: { shelf: 'C3' },
    });
    expect(input).not.toHaveProperty('quantity');
    expect(input).not.toHaveProperty('status');
    expect(input).not.toHaveProperty('code');
    expect(input).not.toHaveProperty('location');
  });

  it('blocks a positive opening stock without a storage location', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Impeller seal kit');

    await user.click(screen.getByRole('button', { name: 'Yeni Yedek Parça' }));
    const dialog = await screen.findByRole('dialog');
    await waitForLocationOptions(dialog);

    await user.type(within(dialog).getByLabelText(/Parça Numarası/), 'AP-IMP-8');
    await user.type(within(dialog).getByLabelText(/Parça Adı/), 'Impeller');
    const opening = within(dialog).getByLabelText(/Açılış stoğu/);
    await user.clear(opening);
    await user.type(opening, '5');
    // Submit the form directly: the page's own guard, not only the browser's
    // `required` constraint, must stop the request.
    const form = within(dialog).getByRole('button', { name: 'Kaydet' }).closest('form');
    expect(form).not.toBeNull();
    if (form) fireEvent.submit(form);

    expect(
      await within(dialog).findByText('Açılış stoğu için depolama lokasyonu seçin.'),
    ).toBeInTheDocument();
    expect(inputsOf('createSparePart(')).toHaveLength(0);
  });

  it('update sends neither quantity nor status and re-homes the storage location', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Impeller seal kit');

    await user.click(screen.getByRole('button', { name: 'Düzenle' }));
    const dialog = await screen.findByRole('dialog');
    await waitForLocationOptions(dialog);
    // Editing never offers an opening stock — stock moves only through movements.
    expect(within(dialog).queryByLabelText(/Açılış stoğu/)).not.toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText(/Depolama Lokasyonu/), LOC_B);
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));

    await waitFor(() => expect(inputsOf('updateSparePart(')).toHaveLength(1));
    const [input] = inputsOf('updateSparePart(');
    expect(input).toMatchObject({
      id: 'sp-1',
      storageLocationId: LOC_B,
      // The whole bin-detail blob round-trips, including the notes the form does not edit.
      binDetail: { warehouse: 'Hall 1', shelf: 'B2', bin: '7', notes: 'top row' },
    });
    expect(input).not.toHaveProperty('quantity');
    expect(input).not.toHaveProperty('status');
    expect(input).not.toHaveProperty('code');
    expect(input).not.toHaveProperty('openingQuantity');
  });

  it('records a movement through recordSparePartStockMovement at the part location', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Impeller seal kit');

    await user.click(screen.getByRole('button', { name: 'Stok' }));
    const dialog = await screen.findByRole('dialog');
    await waitForLocationOptions(dialog);
    // Defaults to the part's own storage location.
    expect(within(dialog).getByLabelText(/Depolama Lokasyonu/)).toHaveValue(LOC_A);

    await user.selectOptions(within(dialog).getByLabelText(/Hareket Tipi/), 'out');
    const quantity = within(dialog).getByLabelText(/Miktar/);
    await user.clear(quantity);
    await user.type(quantity, '3');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));

    await waitFor(() => expect(inputsOf('recordSparePartStockMovement(')).toHaveLength(1));
    expect(inputsOf('recordSparePartStockMovement(')[0]).toEqual({
      sparePartId: 'sp-1',
      quantity: 3,
      movementType: 'out',
      storageLocationId: LOC_A,
    });
    // The storage module's mutation (different input type) is never called.
    expect(
      requestMock.mock.calls.some(([q]) => /\brecordStockMovement\(/.test(q as string)),
    ).toBe(false);
  });

  it('relocates stock as a ledger transfer through recordSparePartStockMovement', async () => {
    // SCENARIO: the manager moves 2 parts from the home location A to B.
    // EXPECTS: one recordSparePartStockMovement with movementType transfer, the
    // source and the receiving location; transferStock is never called.
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Impeller seal kit');

    await user.click(screen.getByRole('button', { name: 'Stok' }));
    const dialog = await screen.findByRole('dialog');
    await waitForLocationOptions(dialog);
    await user.selectOptions(within(dialog).getByLabelText(/Hareket Tipi/), 'transfer');
    const destination = within(dialog).getByLabelText(/Alıcı lokasyon/);
    // The source location is not offered as its own destination.
    expect(within(destination).queryByRole('option', { name: /Main store/ })).toBeNull();
    await user.selectOptions(destination, LOC_B);
    const quantity = within(dialog).getByLabelText(/Miktar/);
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));

    await waitFor(() => expect(inputsOf('recordSparePartStockMovement(')).toHaveLength(1));
    expect(inputsOf('recordSparePartStockMovement(')[0]).toEqual({
      sparePartId: 'sp-1',
      quantity: 2,
      movementType: 'transfer',
      storageLocationId: LOC_A,
      toStorageLocationId: LOC_B,
    });
    expect(requestMock.mock.calls.some(([q]) => /\btransferStock\(/.test(q as string))).toBe(
      false,
    );
  });

  it('keeps a transfer without a receiving location from reaching the backend', async () => {
    // SCENARIO: transfer chosen, no destination picked. EXPECTS: a field error, no mutation.
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Impeller seal kit');

    await user.click(screen.getByRole('button', { name: 'Stok' }));
    const dialog = await screen.findByRole('dialog');
    await waitForLocationOptions(dialog);
    await user.selectOptions(within(dialog).getByLabelText(/Hareket Tipi/), 'transfer');
    const quantity = within(dialog).getByLabelText(/Miktar/);
    await user.clear(quantity);
    await user.type(quantity, '2');
    // Submit the form directly: the modal's own guard, not only the browser's
    // `required` constraint, must stop the request.
    const form = within(dialog).getByRole('button', { name: 'Kaydet' }).closest('form');
    expect(form).not.toBeNull();
    if (form) fireEvent.submit(form);

    expect(await within(dialog).findByText('Stoğu alacak lokasyonu seçin.')).toBeInTheDocument();
    expect(inputsOf('recordSparePartStockMovement(')).toHaveLength(0);
  });
});
