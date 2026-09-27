/**
 * ActAsTenantBanner (FE-MEDIUM-092): the act-as context is visible and leavable.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActAsTenantBanner } from '../ActAsTenantBanner';

const navigate = vi.fn();
const clearTenant = vi.fn();
const auth = {
  user: {
    id: 'op',
    email: 'op@example.com',
    role: 'SUPER_ADMIN',
    tenantId: null,
    isActive: true,
  } as {
    id: string;
    email: string;
    role: string;
    tenantId: string | null;
    isActive: boolean;
  } | null,
};

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuthContext: () => auth,
    useTenantContext: () => ({
      tenant: null,
      clearTenant: () => {
        clearTenant();
        actual.clearActAsContext();
      },
    }),
  };
});

import { clearActAsContext, setActAsContext, setTenantId } from '@aquaculture/shared-ui';

function renderBanner(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ActAsTenantBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  navigate.mockClear();
  clearTenant.mockClear();
  clearActAsContext();
  setTenantId(null);
});

afterEach(cleanup);

describe('ActAsTenantBanner', () => {
  it('renders nothing while no act-as context is set', () => {
    renderBanner();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names the tenant, the reason and the ticket, and exit clears the context and returns to the tenant list', () => {
    setTenantId('tenant-42');
    setActAsContext({ tenantId: 'tenant-42', reason: 'Support case', ticket: 'SUP-7' });
    renderBanner();

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('tenant-42');
    expect(banner.textContent).toContain('Support case');
    expect(banner.textContent).toContain('SUP-7');

    fireEvent.click(screen.getByRole('button', { name: 'Exit tenant' }));
    expect(clearTenant).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/admin/tenants');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays hidden for a user who is not a SUPER_ADMIN', () => {
    auth.user = {
      id: 'u',
      email: 'u@example.com',
      role: 'TENANT_ADMIN',
      tenantId: 'tenant-1',
      isActive: true,
    };
    setTenantId('tenant-1');
    setActAsContext({ tenantId: 'tenant-1', reason: 'stale' });
    renderBanner();
    expect(screen.queryByRole('status')).toBeNull();
    auth.user = {
      id: 'op',
      email: 'op@example.com',
      role: 'SUPER_ADMIN',
      tenantId: null,
      isActive: true,
    };
  });
});
