/**
 * MaintenancePage wiring tests (federation-free vitest).
 *
 * Locks the FARM-MEDIUM-113 fix: the maintenance pages existed complete
 * but were never routed. These tests exercise the tabbed shell with the REAL
 * useMaintenance hooks running against a mocked graphqlClient transport:
 *   - the Work Orders tab (default) fetches `workOrders` and renders rows;
 *   - switching to Spare Parts fetches `spareParts` + `stockSummary`;
 *   - the tab bar exposes all three maintenance surfaces.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MaintenancePage from '../MaintenancePage';
import '@testing-library/jest-dom/vitest';

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock('@aquaculture/shared-ui', async () => {
  const actual =
    await vi.importActual<typeof import('@aquaculture/shared-ui')>('@aquaculture/shared-ui');
  return {
    ...actual,
    useAuth: () => ({
      token: 'jwt',
      tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
      isAuthenticated: true,
      isLoading: false,
    }),
    graphqlClient: { request: requestMock },
  };
});

const WORK_ORDER = {
  id: 'wo-1',
  tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
  workOrderCode: 'WO-2026-0001',
  title: 'Pump impeller inspection',
  description: 'Quarterly impeller wear check',
  type: 'INSPECTION',
  status: 'DRAFT',
  priority: 'MEDIUM',
  assetType: 'PUMP',
  assetId: 'asset-1',
  relatedAsset: null,
  plannedStartDate: '2026-07-10T08:00:00.000Z',
  dueDate: '2026-07-15T08:00:00.000Z',
  estimatedDurationMinutes: 60,
  actualStartTime: null,
  actualEndTime: null,
  actualDurationMinutes: null,
  assignedTo: null,
  assignedTeamId: null,
  createdBy: 'user-1',
  approvedBy: null,
  approvedAt: null,
  checklist: [],
  checklistProgress: 0,
  usedMaterials: [],
  laborCost: null,
  materialCost: null,
  totalCost: null,
  completionNotes: null,
  failureReason: null,
  resolutionNotes: null,
  attachmentUrls: [],
  maintenanceScheduleId: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-01T08:00:00.000Z',
};

const SPARE_PART = {
  id: 'sp-1',
  tenantId: 'aaaaaaaa-1111-4222-8333-444444444444',
  code: 'SP-0001',
  name: 'Impeller seal kit',
  partNumber: 'AP-SEAL-42',
  description: 'Seal kit for the main circulation pump',
  equipmentTypeId: null,
  compatibleEquipmentTypes: [],
  supplierId: null,
  manufacturer: 'AquaPumps',
  quantity: 4,
  minStock: 2,
  maxStock: 10,
  reorderPoint: 3,
  unit: 'kit',
  status: 'IN_STOCK',
  location: { warehouse: 'Main', shelf: 'B2' },
  unitPrice: 120,
  currency: 'NOK',
  specifications: {},
  leadTimeDays: 7,
  lastOrderDate: null,
  lastUsedDate: null,
  notes: null,
  isActive: true,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-01T08:00:00.000Z',
  createdBy: null,
  updatedBy: null,
  version: 1,
};

function paginated<T>(items: T[]): Record<string, unknown> {
  return {
    items,
    total: items.length,
    page: 1,
    limit: 20,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function installTransport(): void {
  requestMock.mockImplementation((query: string) => {
    if (query.includes('workOrders(')) {
      return Promise.resolve({ workOrders: paginated([WORK_ORDER]) });
    }
    if (query.includes('spareParts(')) {
      return Promise.resolve({ spareParts: paginated([SPARE_PART]) });
    }
    if (query.includes('stockSummary')) {
      return Promise.resolve({
        stockSummary: {
          totalParts: 1,
          totalValue: 480,
          lowStockCount: 0,
          outOfStockCount: 0,
          inStockCount: 1,
          onOrderCount: 0,
          discontinuedCount: 0,
        },
      });
    }
    if (query.includes('maintenanceSchedules(')) {
      return Promise.resolve({ maintenanceSchedules: paginated([]) });
    }
    return Promise.resolve({});
  });
}

function renderPage(initialEntry = '/sites/maintenance'): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <MaintenancePage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  requestMock.mockReset();
});

describe('MaintenancePage', () => {
  it('renders the three maintenance tabs', async () => {
    installTransport();
    renderPage();

    expect(screen.getByRole('button', { name: 'Work Orders' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maintenance Schedules' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Spare Parts' })).toBeInTheDocument();
  });

  it('defaults to Work Orders and renders rows fetched through the real hook', async () => {
    installTransport();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Pump impeller inspection')).toBeInTheDocument();
    });
    expect(screen.getByText('WO-2026-0001')).toBeInTheDocument();
    expect(
      requestMock.mock.calls.some(([query]) => (query as string).includes('workOrders(')),
    ).toBe(true);
  });

  it('switches to Spare Parts and fetches spareParts + stockSummary', async () => {
    installTransport();
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Spare Parts' }));

    await waitFor(() => {
      expect(screen.getByText('Impeller seal kit')).toBeInTheDocument();
    });
    expect(
      requestMock.mock.calls.some(([query]) => (query as string).includes('spareParts(')),
    ).toBe(true);
    expect(
      requestMock.mock.calls.some(([query]) => (query as string).includes('stockSummary')),
    ).toBe(true);
  });

  it('honours the ?tab= search param used by shell deep links', async () => {
    installTransport();
    renderPage('/sites/maintenance?tab=spare-parts');

    await waitFor(() => {
      expect(screen.getByText('Impeller seal kit')).toBeInTheDocument();
    });
  });
});
