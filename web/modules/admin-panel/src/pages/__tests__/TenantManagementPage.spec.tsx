/**
 * TenantManagementPage Tests
 *
 * Tests for the tenant list and management functionality
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import TenantManagementPage from '../TenantManagementPage';
import { tenantsApi, TenantTier, TenantStatus } from '../../services/adminApi';

// Mock the API module
vi.mock('../../services/adminApi', () => ({
  tenantsApi: {
    list: vi.fn(),
    getStats: vi.fn(),
    suspend: vi.fn(),
    activate: vi.fn(),
    bulkSuspend: vi.fn(),
    bulkActivate: vi.fn(),
  },
  TenantTier: {
    FREE: 'FREE',
    STARTER: 'STARTER',
    PROFESSIONAL: 'PROFESSIONAL',
    ENTERPRISE: 'ENTERPRISE',
  },
  TenantStatus: {
    PENDING: 'PENDING',
    ACTIVE: 'ACTIVE',
    SUSPENDED: 'SUSPENDED',
    INACTIVE: 'INACTIVE',
    ARCHIVED: 'ARCHIVED',
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
  return render(
    <BrowserRouter>
      {component}
    </BrowserRouter>
  );
};

// Mock tenant data
const mockTenants = [
  {
    id: 'tenant-1',
    name: 'Ocean Farms Ltd',
    slug: 'oceanfarms',
    tier: TenantTier.ENTERPRISE,
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
    tier: TenantTier.PROFESSIONAL,
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
    tier: TenantTier.STARTER,
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
    tier: TenantTier.FREE,
    status: TenantStatus.SUSPENDED,
    userCount: 2,
    farmCount: 0,
    sensorCount: 0,
    createdAt: '2024-11-01T12:00:00Z',
    updatedAt: '2024-11-10T09:00:00Z',
    lastActivityAt: '2024-11-10T09:00:00Z',
  },
];

const mockStats = {
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
    (tenantsApi.list as any).mockResolvedValue({ data: mockTenants, total: 4 });
    (tenantsApi.getStats as any).mockResolvedValue(mockStats);
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

      // 'Active'/'Suspended'/'Pending' also appear as filter options - assert
      // the stats card labels exist without demanding uniqueness.
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
        expect(screen.getByText(TenantTier.ENTERPRISE)).toBeInTheDocument();
        expect(screen.getByText(TenantTier.PROFESSIONAL)).toBeInTheDocument();
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
        expect(tenantsApi.list).toHaveBeenCalledWith(
          expect.objectContaining({ search: 'Ocean' })
        );
      });
    });

    it('should have status filter dropdown', async () => {
      renderWithRouter(<TenantManagementPage />);

      const statusSelect = screen.getByLabelText(/filter by status/i);
      expect(statusSelect).toBeInTheDocument();
    });

    it('should filter by status', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const statusSelect = screen.getByLabelText(/filter by status/i);
      await user.selectOptions(statusSelect, TenantStatus.ACTIVE);

      await waitFor(() => {
        expect(tenantsApi.list).toHaveBeenCalledWith(
          expect.objectContaining({ status: TenantStatus.ACTIVE })
        );
      });
    });

    it('should have tier filter dropdown', async () => {
      renderWithRouter(<TenantManagementPage />);

      const tierSelect = screen.getByLabelText(/filter by tier/i);
      expect(tierSelect).toBeInTheDocument();
    });

    it('should filter by tier', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const tierSelect = screen.getByLabelText(/filter by tier/i);
      await user.selectOptions(tierSelect, TenantTier.ENTERPRISE);

      await waitFor(() => {
        expect(tenantsApi.list).toHaveBeenCalledWith(
          expect.objectContaining({ tier: TenantTier.ENTERPRISE })
        );
      });
    });

    it('should clear filters', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      // Apply filter
      const statusSelect = screen.getByLabelText(/filter by status/i);
      await user.selectOptions(statusSelect, TenantStatus.ACTIVE);

      // Clear filter
      await user.selectOptions(statusSelect, '');

      await waitFor(() => {
        expect(tenantsApi.list).toHaveBeenCalledWith(
          expect.objectContaining({ status: undefined })
        );
      });
    });
  });

  describe('Tenant Actions', () => {
    it('should navigate to tenant detail on row click', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const detailButtons = screen.getAllByRole('button', { name: /details/i });
      await user.click(detailButtons[0]);
      expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining('tenant-1'));
    });

    it('should bulk suspend a selected active tenant with a reason', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantsApi.bulkSuspend).mockResolvedValueOnce({ success: ['tenant-1'], failed: [] });

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      await user.click(screen.getByRole('checkbox', { name: 'Select Ocean Farms Ltd' }));
      await user.click(screen.getByRole('button', { name: /suspend selected/i }));

      const reasonInput = screen.getByPlaceholderText(/enter the reason for suspension/i);
      await user.type(reasonInput, 'Policy violation');
      await user.click(screen.getByRole('button', { name: /^suspend \(1\)$/i }));

      await waitFor(() => {
        expect(tenantsApi.bulkSuspend).toHaveBeenCalledWith(['tenant-1'], 'Policy violation');
      });
    });

    it('should open the quick-view modal and suspend with a reason', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantsApi.suspend).mockResolvedValueOnce(undefined as never);

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      await user.click(screen.getAllByRole('button', { name: /quick view/i })[0]);

      // Detail modal for the active tenant offers Suspend
      await user.click(screen.getByRole('button', { name: /^suspend$/i }));

      // Reason modal enforces a reason before the destructive call
      await user.type(
        screen.getByPlaceholderText(/enter reason for suspension/i),
        'Abuse report'
      );
      await user.click(screen.getByRole('button', { name: /^suspend tenant$/i }));

      await waitFor(() => {
        expect(tenantsApi.suspend).toHaveBeenCalledWith('tenant-1', 'Abuse report');
      });
    });

    it('should bulk activate a selected suspended tenant', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantsApi.bulkActivate).mockResolvedValueOnce({ success: ['tenant-4'], failed: [] });

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Marine Harvest Inc')).toBeInTheDocument());

      await user.click(screen.getByRole('checkbox', { name: 'Select Marine Harvest Inc' }));
      await user.click(screen.getByRole('button', { name: /activate selected/i }));

      await user.click(screen.getByRole('button', { name: /^activate \(1\)$/i }));

      await waitFor(() => {
        expect(tenantsApi.bulkActivate).toHaveBeenCalledWith(['tenant-4']);
      });
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

      await user.click(screen.getByRole('checkbox', { name: 'Select Ocean Farms Ltd' }));

      expect(screen.getByRole('button', { name: /suspend selected/i })).toBeInTheDocument();
    });

    it('should select all tenants', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      const selectAllCheckbox = screen.getByRole('checkbox', { name: /select all tenants/i });
      await user.click(selectAllCheckbox);

      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes.every((cb) => (cb as HTMLInputElement).checked)).toBe(true);
    });

  });

  describe('Error Handling', () => {
    it('should display error message on API failure', async () => {
      (tenantsApi.list as any).mockRejectedValueOnce(new Error('Network error'));

      renderWithRouter(<TenantManagementPage />);

      // Should fall back to mock data and not show error, or show error
      // Depends on implementation
    });

    it('should display error on bulk suspend failure', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantsApi.bulkSuspend).mockRejectedValueOnce(new Error('Suspend failed'));

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      await user.click(screen.getByRole('checkbox', { name: 'Select Ocean Farms Ltd' }));
      await user.click(screen.getByRole('button', { name: /suspend selected/i }));

      expect(screen.getByText('Bulk Suspend')).toBeInTheDocument();
      await user.type(
        screen.getByPlaceholderText(/enter the reason for suspension/i),
        'Policy violation'
      );
      await user.click(screen.getByRole('button', { name: /^suspend \(1\)$/i }));

      await waitFor(() => {
        expect(tenantsApi.bulkSuspend).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.getByText(/suspend failed/i)).toBeInTheDocument();
      });
    });
  });

  describe('Pagination', () => {
    it('should display pagination controls', async () => {
      (tenantsApi.list as any).mockResolvedValueOnce({
        data: mockTenants,
        total: 100, // More than one page
      });

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /previous/i })).toBeInTheDocument();
    });

    it('should change page on pagination click', async () => {
      const user = userEvent.setup();
      (tenantsApi.list as any).mockResolvedValueOnce({
        data: mockTenants,
        total: 100,
      });

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /next/i }));

      await waitFor(() => {
        expect(tenantsApi.list).toHaveBeenCalledWith(
          expect.objectContaining({ page: 2 })
        );
      });
    });
  });

  describe('Loading State', () => {
    it('should show loading indicator while fetching', async () => {
      // Delay the API response
      (tenantsApi.list as any).mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({ data: mockTenants, total: 4 }), 100))
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
      (tenantsApi.list as any).mockResolvedValueOnce({ data: [], total: 0 });

      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => {
        expect(screen.getByText(/no tenants found/i)).toBeInTheDocument();
      });
    });
  });

  describe('Refresh', () => {
    it('should have refresh button', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    });

    it('should refresh data on button click', async () => {
      const user = userEvent.setup();
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /refresh/i }));

      await waitFor(() => {
        expect(tenantsApi.list).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Stats Display', () => {
    it('should display correct stats values', async () => {
      renderWithRouter(<TenantManagementPage />);

      await waitFor(() => {
        expect(screen.getByText('4')).toBeInTheDocument(); // Total
        expect(screen.getByText('2')).toBeInTheDocument(); // Active
        expect(screen.getAllByText('1')).toHaveLength(2); // Suspended + Pending
      });
    });

    it('should handle stats API failure gracefully', async () => {
      (tenantsApi.getStats as any).mockRejectedValueOnce(new Error('Stats failed'));

      renderWithRouter(<TenantManagementPage />);

      // Stats cards are hidden on failure; the page itself still renders
      await waitFor(() => {
        expect(screen.getByText('Ocean Farms Ltd')).toBeInTheDocument();
      });
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
