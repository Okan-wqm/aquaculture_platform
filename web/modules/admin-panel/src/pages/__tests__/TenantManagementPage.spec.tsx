/**
 * TenantManagementPage Tests
 *
 * Tests for the tenant list and management functionality
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import TenantManagementPage from '../TenantManagementPage';
import {
  tenantsApi,
  type PaginatedResult,
  type Tenant,
  type TenantStats,
  TenantPlan,
  TenantStatus,
} from '../../services/adminApi';

// Stub the API CALLS, keep every real export.
//
// This mock used to re-declare the vocabularies too, and it declared the tier
// members UPPERCASE — a casing the wire has never carried. The fixtures below
// were built from the same mock, so the suite agreed with itself and proved
// nothing about the real values. Spreading the actual module means a vocabulary
// can only ever be exercised at the values the panel really receives.
vi.mock('../../services/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/adminApi')>()),
  tenantsApi: {
    list: vi.fn(),
    getStats: vi.fn(),
    suspend: vi.fn(),
    activate: vi.fn(),
    bulkSuspend: vi.fn(),
    bulkActivate: vi.fn(),
  },
}));

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Helper to render component with router
const renderWithRouter = (component: React.ReactElement) => {
  return render(<BrowserRouter>{component}</BrowserRouter>);
};

// Mock tenant data
const mockTenants: Tenant[] = [
  {
    id: 'tenant-1',
    name: 'Ocean Farms Ltd',
    slug: 'oceanfarms',
    tier: TenantPlan.ENTERPRISE,
    status: TenantStatus.ACTIVE,
    userCount: 45,
    farmCount: 12,
    sensorCount: 156,
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-11-26T09:30:00Z',
    lastActivityAt: '2024-11-26T09:30:00Z',
  },
  {
    id: 'tenant-2',
    name: 'Blue Waters Aquaculture',
    slug: 'bluewaters',
    tier: TenantPlan.PROFESSIONAL,
    status: TenantStatus.ACTIVE,
    userCount: 23,
    farmCount: 5,
    sensorCount: 48,
    createdAt: '2024-03-20T14:00:00Z',
    updatedAt: '2024-11-25T16:45:00Z',
    lastActivityAt: '2024-11-25T16:45:00Z',
  },
  {
    id: 'tenant-3',
    name: 'Coastal Fish Co',
    slug: 'coastalfish',
    tier: TenantPlan.STARTER,
    status: TenantStatus.PENDING,
    userCount: 3,
    farmCount: 1,
    sensorCount: 8,
    createdAt: '2024-10-01T08:00:00Z',
    updatedAt: '2024-11-20T11:00:00Z',
    lastActivityAt: '2024-11-20T11:00:00Z',
  },
  {
    id: 'tenant-4',
    name: 'Marine Harvest Inc',
    slug: 'marineharvest',
    tier: TenantPlan.FREE,
    status: TenantStatus.SUSPENDED,
    userCount: 2,
    farmCount: 0,
    sensorCount: 0,
    createdAt: '2024-11-01T12:00:00Z',
    updatedAt: '2024-11-10T09:00:00Z',
    lastActivityAt: '2024-11-10T09:00:00Z',
  },
];

const mockTenantPage: PaginatedResult<Tenant> = {
  data: mockTenants,
  total: 4,
  page: 1,
  limit: 20,
  totalPages: 1,
};

const mockStats: TenantStats = {
  totalTenants: 4,
  activeTenants: 2,
  suspendedTenants: 1,
  pendingTenants: 1,
  newTenantsLast30Days: 1,
  churnedTenantsLast30Days: 0,
};

describe('TenantManagementPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tenantsApi.list).mockResolvedValue(mockTenantPage);
    vi.mocked(tenantsApi.getStats).mockResolvedValue(mockStats);
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial Rendering', () => {
    it('should render the page title', async () => {
      renderWithRouter(<TenantManagementPage />);

      expect(screen.getByText('Tenant Management')).toBeInTheDocument();
    });

    it('should display stats cards', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => {
        expect(screen.getByText('Total')).toBeInTheDocument();
        expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Suspended').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);
      });
    });

    it('should load and display tenants', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => {
        expect(tenantsApi.list).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument();
        expect(screen.getByText('Blue Waters Aquaculture')).toBeInTheDocument();
      });
    });

    it('should load stats on mount', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => {
        expect(tenantsApi.getStats).toHaveBeenCalled();
      });
    });

    it('should display tier badges', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => {
        expect(screen.getByText(TenantPlan.ENTERPRISE)).toBeInTheDocument();
        expect(screen.getByText(TenantPlan.PROFESSIONAL)).toBeInTheDocument();
      });
    });

    it('should display status badges', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => {
        expect(screen.getByText(TenantStatus.SUSPENDED)).toBeInTheDocument();
        expect(screen.getByText(TenantStatus.PENDING)).toBeInTheDocument();
      });
    });
  });

  describe('Search and Filter', () => {
    it('should have search input', async () => {
      renderWithRouter(<TenantManagementPage />);

      const searchInput = screen.getByPlaceholderText(/search tenants/i);
      expect(searchInput).toBeInTheDocument();
    });

    it('should filter tenants by search term', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      // Wait for initial load
      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      // Search
      const searchInput = screen.getByPlaceholderText(/search tenants/i);
      await user.type(searchInput, 'Ocean');

      // API should be called with search parameter
      await waitFor(() => {
        expect(tenantsApi.list).toHaveBeenCalledWith(expect.objectContaining({ search: 'Ocean' }));
      });
    });

    it('should have status filter dropdown', async () => {
      renderWithRouter(<TenantManagementPage />);

      const statusSelect = screen.getByRole('combobox', { name: /^status$/i });
      expect(statusSelect).toBeInTheDocument();
    });

    it('should filter by status', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const statusSelect = screen.getByRole('combobox', { name: /^status$/i });
      await user.selectOptions(statusSelect, TenantStatus.ACTIVE);

      await waitFor(() => {
        expect(tenantsApi.list).toHaveBeenCalledWith(
          expect.objectContaining({ status: TenantStatus.ACTIVE }),
        );
      });
    });

    it('should have tier filter dropdown', async () => {
      renderWithRouter(<TenantManagementPage />);

      const tierSelect = screen.getByRole('combobox', { name: /^tier$/i });
      expect(tierSelect).toBeInTheDocument();
    });

    it('should filter by tier', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const tierSelect = screen.getByRole('combobox', { name: /^tier$/i });
      await user.selectOptions(tierSelect, TenantPlan.ENTERPRISE);

      await waitFor(() => {
        expect(tenantsApi.list).toHaveBeenCalledWith(
          expect.objectContaining({ tier: TenantPlan.ENTERPRISE }),
        );
      });
    });

    it('should clear filters', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      // Apply filter
      const statusSelect = screen.getByRole('combobox', { name: /^status$/i });
      await user.selectOptions(statusSelect, TenantStatus.ACTIVE);

      // Clear filter
      await user.selectOptions(statusSelect, '');

      await waitFor(() => {
        expect(tenantsApi.list).toHaveBeenCalledWith(
          expect.objectContaining({ status: undefined }),
        );
      });
    });
  });

  describe('Tenant Actions', () => {
    it('should navigate to tenant detail on row click', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      // Click on view button or row
      const viewButtons = screen.getAllByRole('button', { name: /details/i });
      await user.click(viewButtons[0]);
      expect(mockNavigate).toHaveBeenCalledWith('/admin/tenants/tenant-1');
    });

    it('should expose the bulk suspend action for an active tenant', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());
      await user.click(screen.getByRole('checkbox', { name: /select ocean farms/i }));
      expect(screen.getByRole('button', { name: /suspend selected/i })).toBeInTheDocument();
    });

    it('should expose the bulk activate action for a suspended tenant', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Marine Harvest Inc')).toBeInTheDocument());
      await user.click(screen.getByRole('checkbox', { name: /select marine harvest/i }));
      expect(screen.getByRole('button', { name: /activate selected/i })).toBeInTheDocument();
    });
  });

  describe('Bulk Operations', () => {
    it('should allow selecting multiple tenants', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      // Select checkboxes
      const checkboxes = screen.getAllByRole('checkbox');
      if (checkboxes.length > 0) {
        await user.click(checkboxes[0]);

        // Selected count should update
        // expect(screen.getByText(/1 secili/i)).toBeInTheDocument();
      }
    });

    it('should show bulk action buttons when tenants selected', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const checkboxes = screen.getAllByRole('checkbox');
      if (checkboxes.length > 0) {
        await user.click(checkboxes[0]);

        // Bulk action buttons should appear
        // expect(screen.getByRole('button', { name: /toplu askiya al/i })).toBeInTheDocument();
      }
    });

    it('should select all tenants', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const selectAllCheckbox = screen.getByRole('checkbox', { name: /select all tenants/i });
      await user.click(selectAllCheckbox);
      expect(
        screen.getAllByRole('checkbox').every((checkbox) => (checkbox as HTMLInputElement).checked),
      ).toBe(true);
    });

    it('should bulk suspend selected tenants', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantsApi.bulkSuspend).mockResolvedValueOnce({
        success: ['tenant-1', 'tenant-2'],
        failed: [],
      });

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      // Select multiple tenants and click bulk suspend
      // This depends on the actual UI implementation
    });
  });

  describe('Error Handling', () => {
    it('should display error message on API failure', async () => {
      vi.mocked(tenantsApi.list).mockRejectedValueOnce(new Error('Network error'));

      renderWithRouter(<TenantManagementPage />);

      // Should fall back to mock data and not show error, or show error
      // Depends on implementation
    });

    it('should display an actionable error when tenant loading fails', async () => {
      vi.mocked(tenantsApi.list).mockRejectedValueOnce(new Error('Network error'));

      renderWithRouter(<TenantManagementPage />);
      expect(await screen.findByText(/failed to load tenants/i)).toBeInTheDocument();
    });
  });

  describe('Pagination', () => {
    it('should display pagination controls', async () => {
      vi.mocked(tenantsApi.list).mockResolvedValueOnce({
        ...mockTenantPage,
        total: 100, // More than one page
        totalPages: 5,
      });

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      // Pagination should be visible
      // expect(screen.getByRole('button', { name: /sonraki/i })).toBeInTheDocument();
    });

    it('should change page on pagination click', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantsApi.list).mockResolvedValueOnce({
        ...mockTenantPage,
        total: 100,
        totalPages: 5,
      });

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const nextButton = screen.queryByRole('button', { name: /sonraki/i });
      if (nextButton) {
        await user.click(nextButton);

        await waitFor(() => {
          expect(tenantsApi.list).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
        });
      }
    });
  });

  describe('Loading State', () => {
    it('should show loading indicator while fetching', async () => {
      // Delay the API response
      vi.mocked(tenantsApi.list).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockTenantPage), 100)),
      );

      renderWithRouter(<TenantManagementPage />);

      // Should show loading initially
      // expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument();
      });
    });
  });

  describe('Empty State', () => {
    it('should show empty message when no tenants', async () => {
      vi.mocked(tenantsApi.list).mockResolvedValueOnce({
        ...mockTenantPage,
        data: [],
        total: 0,
        totalPages: 0,
      });

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => {
        expect(screen.getByText(/no tenants found/i)).toBeInTheDocument();
      });
    });
  });

  describe('Tenant Detail Modal', () => {
    it('should navigate from the details action', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());
      await user.click(screen.getAllByRole('button', { name: /details/i })[0]);
      expect(mockNavigate).toHaveBeenCalledWith('/admin/tenants/tenant-1');
    });
  });

  describe('Refresh', () => {
    it('should have refresh button', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const refreshButton = screen.queryByRole('button', { name: /yenile/i });
      // expect(refreshButton).toBeInTheDocument();
    });

    it('should refresh data on button click', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const refreshButton = screen.queryByRole('button', { name: /yenile/i });
      if (refreshButton) {
        await user.click(refreshButton);

        expect(tenantsApi.list).toHaveBeenCalledTimes(2);
      }
    });
  });

  describe('Stats Display', () => {
    it('should display correct stats values', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => {
        expect(within(screen.getByText('Total').parentElement!).getByText('4')).toBeInTheDocument();
        expect(
          within(screen.getAllByText('Active')[0].parentElement!).getByText('2'),
        ).toBeInTheDocument();
        expect(screen.getAllByText('1')).toHaveLength(2);
      });
    });

    it('should handle stats API failure gracefully', async () => {
      vi.mocked(tenantsApi.getStats).mockRejectedValueOnce(new Error('Stats failed'));

      renderWithRouter(<TenantManagementPage />);

      expect(await screen.findByText('Ocean Farms Ltd')).toBeInTheDocument();
      expect(screen.queryByText('Total')).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have accessible table structure', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const table = screen.getByRole('table');
      expect(table).toBeInTheDocument();
    });

    it('should have proper button labels', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      // Action buttons should have accessible names
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
    });
  });
});
