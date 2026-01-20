/**
 * CreateTenantPage Tests
 *
 * Tests for the multi-step tenant creation wizard
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import CreateTenantPage from '../CreateTenantPage';
import { tenantsApi, modulesApi, TenantTier } from '../../services/adminApi';

// Mock the API module
vi.mock('../../services/adminApi', () => ({
  tenantsApi: {
    create: vi.fn(),
    list: vi.fn(),
  },
  modulesApi: {
    list: vi.fn(),
    assignToTenant: vi.fn(),
  },
  TenantTier: {
    FREE: 'FREE',
    STARTER: 'STARTER',
    PROFESSIONAL: 'PROFESSIONAL',
    ENTERPRISE: 'ENTERPRISE',
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

// Mock modules data
const mockModules = [
  {
    id: 'module-1',
    code: 'FARM_MANAGEMENT',
    name: 'Farm Management',
    description: 'Manage farms and facilities',
    defaultRoute: '/farm',
    icon: 'farm',
    isCore: true,
    isActive: true,
    price: 0,
    tenantsCount: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'module-2',
    code: 'DASHBOARD',
    name: 'Dashboard',
    description: 'Overview and analytics',
    defaultRoute: '/dashboard',
    icon: 'dashboard',
    isCore: true,
    isActive: true,
    price: 0,
    tenantsCount: 15,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'module-3',
    code: 'SENSORS',
    name: 'Sensor Module',
    description: 'IoT sensor management',
    defaultRoute: '/sensors',
    icon: 'sensor',
    isCore: false,
    isActive: true,
    price: 50,
    tenantsCount: 8,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

describe('CreateTenantPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (modulesApi.list as any).mockResolvedValue({ data: mockModules, total: 3 });
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial Rendering', () => {
    it('should render the page title', async () => {
      renderWithRouter(<CreateTenantPage />);

      expect(screen.getByText('Yeni Tenant Olustur')).toBeInTheDocument();
      expect(screen.getByText('Yeni bir sirket hesabi olusturun')).toBeInTheDocument();
    });

    it('should render step indicators', async () => {
      renderWithRouter(<CreateTenantPage />);

      expect(screen.getByText('Temel Bilgiler')).toBeInTheDocument();
      expect(screen.getByText('Iletisim')).toBeInTheDocument();
      expect(screen.getByText('Moduller')).toBeInTheDocument();
      expect(screen.getByText('Onay')).toBeInTheDocument();
    });

    it('should start on step 1', async () => {
      renderWithRouter(<CreateTenantPage />);

      // Step 1 content should be visible
      expect(screen.getByText('Sirket Adi *')).toBeInTheDocument();
      expect(screen.getByText('Slug (URL)')).toBeInTheDocument();
    });

    it('should have disabled back button on first step', async () => {
      renderWithRouter(<CreateTenantPage />);

      const backButton = screen.getByRole('button', { name: /geri/i });
      expect(backButton).toBeDisabled();
    });

    it('should load modules on mount', async () => {
      renderWithRouter(<CreateTenantPage />);

      await waitFor(() => {
        expect(modulesApi.list).toHaveBeenCalledWith({ isActive: true, limit: 50 });
      });
    });
  });

  describe('Step 1: Basic Info', () => {
    it('should auto-generate slug from name', async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      const nameInput = screen.getByLabelText(/sirket adi/i);
      await user.type(nameInput, 'Test Company Name');

      const slugInput = screen.getByLabelText(/slug/i);
      expect(slugInput).toHaveValue('test-company-name');
    });

    it('should sanitize slug input', async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      const nameInput = screen.getByLabelText(/sirket adi/i);
      await user.type(nameInput, 'Test!@#$%Company');

      const slugInput = screen.getByLabelText(/slug/i);
      expect(slugInput).toHaveValue('test-company');
    });

    it('should validate required fields before proceeding', async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Try to proceed without filling required fields
      const nextButton = screen.getByRole('button', { name: /devam/i });
      await user.click(nextButton);

      // Should show error
      expect(screen.getByText(/lutfen gerekli alanlari doldurun/i)).toBeInTheDocument();
    });

    it('should allow proceeding with valid data', async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Fill in required fields
      const nameInput = screen.getByLabelText(/sirket adi/i);
      await user.type(nameInput, 'Test Company');

      const nextButton = screen.getByRole('button', { name: /devam/i });
      await user.click(nextButton);

      // Should move to step 2
      await waitFor(() => {
        expect(screen.getByText('Yonetici Bilgileri')).toBeInTheDocument();
      });
    });

    it('should display tier options', async () => {
      renderWithRouter(<CreateTenantPage />);

      const tierSelect = screen.getByLabelText(/plan/i);
      expect(tierSelect).toBeInTheDocument();
    });

    it('should allow setting trial days', async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      const trialInput = screen.getByLabelText(/deneme suresi/i);
      await user.clear(trialInput);
      await user.type(trialInput, '30');

      expect(trialInput).toHaveValue('30');
    });
  });

  describe('Step 2: Contact Info', () => {
    const goToStep2 = async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Fill step 1
      const nameInput = screen.getByLabelText(/sirket adi/i);
      await user.type(nameInput, 'Test Company');

      // Go to step 2
      const nextButton = screen.getByRole('button', { name: /devam/i });
      await user.click(nextButton);

      return user;
    };

    it('should display contact info fields', async () => {
      await goToStep2();

      expect(screen.getByLabelText(/ad soyad/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/e-posta/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/telefon/i)).toBeInTheDocument();
    });

    it('should validate email format', async () => {
      const user = await goToStep2();

      // Fill name
      const nameInput = screen.getByLabelText(/ad soyad/i);
      await user.type(nameInput, 'John Doe');

      // Fill invalid email
      const emailInput = screen.getByLabelText(/e-posta/i);
      await user.type(emailInput, 'invalid-email');

      // Try to proceed
      const nextButton = screen.getByRole('button', { name: /devam/i });
      await user.click(nextButton);

      // Should show error
      expect(screen.getByText(/lutfen gerekli alanlari doldurun/i)).toBeInTheDocument();
    });

    it('should accept valid email', async () => {
      const user = await goToStep2();

      const nameInput = screen.getByLabelText(/ad soyad/i);
      await user.type(nameInput, 'John Doe');

      const emailInput = screen.getByLabelText(/e-posta/i);
      await user.type(emailInput, 'john@example.com');

      const nextButton = screen.getByRole('button', { name: /devam/i });
      await user.click(nextButton);

      // Should move to step 3
      await waitFor(() => {
        expect(screen.getByText('Modul Secimi')).toBeInTheDocument();
      });
    });

    it('should allow navigating back to step 1', async () => {
      const user = await goToStep2();

      const backButton = screen.getByRole('button', { name: /geri/i });
      await user.click(backButton);

      // Should be back on step 1
      expect(screen.getByText('Temel Bilgiler')).toBeInTheDocument();
    });
  });

  describe('Step 3: Module Selection', () => {
    const goToStep3 = async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Step 1
      await user.type(screen.getByLabelText(/sirket adi/i), 'Test Company');
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Wait for step 2
      await waitFor(() => expect(screen.getByLabelText(/ad soyad/i)).toBeInTheDocument());

      // Step 2
      await user.type(screen.getByLabelText(/ad soyad/i), 'John Doe');
      await user.type(screen.getByLabelText(/e-posta/i), 'john@example.com');
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Wait for modules to load and step 3 to render
      await waitFor(() => expect(screen.getByText('Modul Secimi')).toBeInTheDocument());

      return user;
    };

    it('should display available modules', async () => {
      await goToStep3();

      await waitFor(() => {
        expect(screen.getByText('Farm Management')).toBeInTheDocument();
        expect(screen.getByText('Dashboard')).toBeInTheDocument();
        expect(screen.getByText('Sensor Module')).toBeInTheDocument();
      });
    });

    it('should allow selecting modules', async () => {
      const user = await goToStep3();

      await waitFor(() => expect(screen.getByText('Farm Management')).toBeInTheDocument());

      // Click on a module
      const farmModule = screen.getByText('Farm Management').closest('div');
      if (farmModule) {
        await user.click(farmModule);
      }

      // Should show selected count
      await waitFor(() => {
        expect(screen.getByText(/secili: 1 modul/i)).toBeInTheDocument();
      });
    });

    it('should allow deselecting modules', async () => {
      const user = await goToStep3();

      await waitFor(() => expect(screen.getByText('Farm Management')).toBeInTheDocument());

      // Select and then deselect
      const farmModule = screen.getByText('Farm Management').closest('div');
      if (farmModule) {
        await user.click(farmModule);
        await user.click(farmModule);
      }

      // Should show 0 selected
      await waitFor(() => {
        expect(screen.getByText(/secili: 0 modul/i)).toBeInTheDocument();
      });
    });

    it('should handle empty modules list gracefully', async () => {
      (modulesApi.list as any).mockResolvedValueOnce({ data: [], total: 0 });

      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Navigate to step 3
      await user.type(screen.getByLabelText(/sirket adi/i), 'Test Company');
      await user.click(screen.getByRole('button', { name: /devam/i }));
      await waitFor(() => expect(screen.getByLabelText(/ad soyad/i)).toBeInTheDocument());
      await user.type(screen.getByLabelText(/ad soyad/i), 'John');
      await user.type(screen.getByLabelText(/e-posta/i), 'john@test.com');
      await user.click(screen.getByRole('button', { name: /devam/i }));

      await waitFor(() => {
        expect(screen.getByText('Aktif modul bulunamadi')).toBeInTheDocument();
      });
    });
  });

  describe('Step 4: Review and Submit', () => {
    const goToStep4 = async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Step 1
      await user.type(screen.getByLabelText(/sirket adi/i), 'Test Company');
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Step 2
      await waitFor(() => expect(screen.getByLabelText(/ad soyad/i)).toBeInTheDocument());
      await user.type(screen.getByLabelText(/ad soyad/i), 'John Doe');
      await user.type(screen.getByLabelText(/e-posta/i), 'john@example.com');
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Step 3 - skip modules
      await waitFor(() => expect(screen.getByText('Modul Secimi')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Wait for step 4
      await waitFor(() => expect(screen.getByText('Onay')).toBeInTheDocument());

      return user;
    };

    it('should display summary of entered data', async () => {
      await goToStep4();

      expect(screen.getByText('Test Company')).toBeInTheDocument();
      expect(screen.getByText('test-company')).toBeInTheDocument();
      expect(screen.getByText('John Doe')).toBeInTheDocument();
      expect(screen.getByText('john@example.com')).toBeInTheDocument();
    });

    it('should show submit button on final step', async () => {
      await goToStep4();

      expect(screen.getByRole('button', { name: /tenant olustur/i })).toBeInTheDocument();
    });

    it('should create tenant on submit', async () => {
      const createdTenant = { id: 'new-tenant-id', name: 'Test Company' };
      (tenantsApi.create as any).mockResolvedValueOnce(createdTenant);

      const user = await goToStep4();

      const submitButton = screen.getByRole('button', { name: /tenant olustur/i });
      await user.click(submitButton);

      await waitFor(() => {
        expect(tenantsApi.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Test Company',
            slug: 'test-company',
            primaryContact: expect.objectContaining({
              name: 'John Doe',
              email: 'john@example.com',
            }),
          })
        );
      });
    });

    it('should show success message after creation', async () => {
      const createdTenant = { id: 'new-tenant-id', name: 'Test Company' };
      (tenantsApi.create as any).mockResolvedValueOnce(createdTenant);

      const user = await goToStep4();

      await user.click(screen.getByRole('button', { name: /tenant olustur/i }));

      await waitFor(() => {
        expect(screen.getByText(/tenant basariyla olusturuldu/i)).toBeInTheDocument();
      });
    });

    it('should display error on creation failure', async () => {
      (tenantsApi.create as any).mockRejectedValueOnce(new Error('Creation failed'));

      const user = await goToStep4();

      await user.click(screen.getByRole('button', { name: /tenant olustur/i }));

      await waitFor(() => {
        expect(screen.getByText(/creation failed/i)).toBeInTheDocument();
      });
    });

    it('should assign selected modules after tenant creation', async () => {
      const createdTenant = { id: 'new-tenant-id', name: 'Test Company' };
      (tenantsApi.create as any).mockResolvedValueOnce(createdTenant);
      (modulesApi.assignToTenant as any).mockResolvedValue({});

      // Custom flow to select modules
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Step 1
      await user.type(screen.getByLabelText(/sirket adi/i), 'Test Company');
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Step 2
      await waitFor(() => expect(screen.getByLabelText(/ad soyad/i)).toBeInTheDocument());
      await user.type(screen.getByLabelText(/ad soyad/i), 'John Doe');
      await user.type(screen.getByLabelText(/e-posta/i), 'john@example.com');
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Step 3 - select modules
      await waitFor(() => expect(screen.getByText('Farm Management')).toBeInTheDocument());
      const farmModule = screen.getByText('Farm Management').closest('div');
      if (farmModule) await user.click(farmModule);
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Step 4 - submit
      await waitFor(() => expect(screen.getByText('Onay')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /tenant olustur/i }));

      await waitFor(() => {
        expect(modulesApi.assignToTenant).toHaveBeenCalledWith('new-tenant-id', 'module-1');
      });
    });
  });

  describe('Success View', () => {
    it('should display success view after creation', async () => {
      const createdTenant = { id: 'new-tenant-id', name: 'Test Company' };
      (tenantsApi.create as any).mockResolvedValueOnce(createdTenant);

      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Complete the form
      await user.type(screen.getByLabelText(/sirket adi/i), 'Test Company');
      await user.click(screen.getByRole('button', { name: /devam/i }));
      await waitFor(() => expect(screen.getByLabelText(/ad soyad/i)).toBeInTheDocument());
      await user.type(screen.getByLabelText(/ad soyad/i), 'John Doe');
      await user.type(screen.getByLabelText(/e-posta/i), 'john@example.com');
      await user.click(screen.getByRole('button', { name: /devam/i }));
      await waitFor(() => expect(screen.getByText('Modul Secimi')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /devam/i }));
      await waitFor(() => expect(screen.getByText('Onay')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /tenant olustur/i }));

      // Wait for success view
      await waitFor(() => {
        expect(screen.getByText(/tenant basariyla olusturuldu/i)).toBeInTheDocument();
      });

      // Should show navigation buttons
      expect(screen.getByRole('button', { name: /tenant listesi/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /tenant detayi/i })).toBeInTheDocument();
    });

    it('should navigate to tenant list on button click', async () => {
      const createdTenant = { id: 'new-tenant-id', name: 'Test Company' };
      (tenantsApi.create as any).mockResolvedValueOnce(createdTenant);

      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Complete form quickly
      await user.type(screen.getByLabelText(/sirket adi/i), 'Test');
      await user.click(screen.getByRole('button', { name: /devam/i }));
      await waitFor(() => expect(screen.getByLabelText(/ad soyad/i)).toBeInTheDocument());
      await user.type(screen.getByLabelText(/ad soyad/i), 'Jo');
      await user.type(screen.getByLabelText(/e-posta/i), 'j@t.co');
      await user.click(screen.getByRole('button', { name: /devam/i }));
      await waitFor(() => expect(screen.getByText('Modul Secimi')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /devam/i }));
      await waitFor(() => expect(screen.getByText('Onay')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /tenant olustur/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /tenant listesi/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /tenant listesi/i }));

      expect(mockNavigate).toHaveBeenCalledWith('/admin/tenants');
    });
  });

  describe('Cancel Button', () => {
    it('should navigate back on cancel', async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      const cancelButton = screen.getByRole('button', { name: /iptal/i });
      await user.click(cancelButton);

      expect(mockNavigate).toHaveBeenCalledWith('/admin/tenants');
    });
  });

  describe('Form State Persistence', () => {
    it('should preserve data when navigating between steps', async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Enter data in step 1
      await user.type(screen.getByLabelText(/sirket adi/i), 'My Company');
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Enter data in step 2
      await waitFor(() => expect(screen.getByLabelText(/ad soyad/i)).toBeInTheDocument());
      await user.type(screen.getByLabelText(/ad soyad/i), 'Jane');
      await user.type(screen.getByLabelText(/e-posta/i), 'jane@test.com');

      // Go back to step 1
      await user.click(screen.getByRole('button', { name: /geri/i }));

      // Check step 1 data is preserved
      expect(screen.getByLabelText(/sirket adi/i)).toHaveValue('My Company');

      // Go forward again
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Check step 2 data is preserved
      await waitFor(() => {
        expect(screen.getByLabelText(/ad soyad/i)).toHaveValue('Jane');
        expect(screen.getByLabelText(/e-posta/i)).toHaveValue('jane@test.com');
      });
    });
  });

  describe('Error Handling', () => {
    it('should clear error when navigating between steps', async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Try to proceed without data
      await user.click(screen.getByRole('button', { name: /devam/i }));
      expect(screen.getByText(/lutfen gerekli alanlari doldurun/i)).toBeInTheDocument();

      // Fill in data and proceed
      await user.type(screen.getByLabelText(/sirket adi/i), 'Test');
      await user.click(screen.getByRole('button', { name: /devam/i }));

      // Error should be cleared
      await waitFor(() => {
        expect(screen.queryByText(/lutfen gerekli alanlari doldurun/i)).not.toBeInTheDocument();
      });
    });

    it('should allow dismissing error alert', async () => {
      const user = userEvent.setup();
      renderWithRouter(<CreateTenantPage />);

      // Trigger error
      await user.click(screen.getByRole('button', { name: /devam/i }));
      expect(screen.getByText(/lutfen gerekli alanlari doldurun/i)).toBeInTheDocument();

      // Find and click dismiss button (if Alert has one)
      const dismissButton = screen.queryByRole('button', { name: /dismiss/i });
      if (dismissButton) {
        await user.click(dismissButton);
        expect(screen.queryByText(/lutfen gerekli alanlari doldurun/i)).not.toBeInTheDocument();
      }
    });
  });

  describe('Accessibility', () => {
    it('should have proper form labels', async () => {
      renderWithRouter(<CreateTenantPage />);

      expect(screen.getByLabelText(/sirket adi/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/slug/i)).toBeInTheDocument();
    });

    it('should have proper button states', async () => {
      renderWithRouter(<CreateTenantPage />);

      // Back button should be disabled on first step
      const backButton = screen.getByRole('button', { name: /geri/i });
      expect(backButton).toBeDisabled();

      // Next button should be enabled
      const nextButton = screen.getByRole('button', { name: /devam/i });
      expect(nextButton).toBeInTheDocument();
    });
  });
});
