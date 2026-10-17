/**
 * The company dashboard for a member who is not a tenant admin: their own
 * notices only. Unread messages come from the caller-scoped messaging count;
 * the users card appears only for a users:view delegate; announcements —
 * admin-only on the backend (RBAC-MEDIUM-021) — render as a labelled preview;
 * and no admin-only read (stats, modules, subscription, announcements) is sent.
 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@aquaculture/shared-ui';

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  unread: 0,
  documents: [] as string[],
  usersRead: 0,
}));

vi.mock('../../../../../shared-ui/src/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'tok', tenantId: 'tenant-1' }),
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuthContext: () => ({
      user: { id: 'u-1', role: 'MODULE_USER', resourcePermissions: state.permissions },
      isAuthenticated: true,
      isLoading: false,
    }),
  };
});

vi.mock('../../services/tenant-api.service', () => ({
  graphqlRequest: async (document: string): Promise<unknown> => {
    state.documents.push(document);
    return { totalUnreadMessageCount: state.unread };
  },
}));

vi.mock('../../hooks/useTenantData', () => ({
  useTenantUsers: () => {
    state.usersRead += 1;
    return {
      data: [
        { id: 'a', isActive: true },
        { id: 'b', isActive: false },
      ],
    };
  },
}));

import MemberCompanyHome from '../companyHome/MemberCompanyHome';

function renderHome(): void {
  render(
    <I18nProvider locale="en">
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <MemberCompanyHome />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  state.permissions = [];
  state.unread = 0;
  state.documents = [];
  state.usersRead = 0;
});

describe('MemberCompanyHome', () => {
  it('tells a member with nothing waiting so, beside the announcements preview', async () => {
    renderHome();
    expect(await screen.findByText('Nothing is waiting for you.')).toBeInTheDocument();
    expect(document.querySelector('[data-preview-finding="RBAC-MEDIUM-021"]')).not.toBeNull();
    expect(screen.queryByText('Users')).not.toBeInTheDocument();
    expect(state.usersRead).toBe(0);
  });

  it("lists the member's unread messages with the way to them", async () => {
    state.unread = 3;
    renderHome();
    expect(await screen.findByText('3 unread messages')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open messages' })).toHaveAttribute(
      'href',
      '/messaging',
    );
  });

  it('adds the users card for a users:view delegate only', async () => {
    state.permissions = ['users:view'];
    renderHome();
    expect(await screen.findByText('1 of 2 users are active.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage users' })).toHaveAttribute(
      'href',
      '/tenant/users',
    );
  });

  it('sends no admin-only read: only the caller-scoped unread count', async () => {
    renderHome();
    await waitFor(() => expect(state.documents).toHaveLength(1));
    expect(state.documents[0]).toContain('totalUnreadMessageCount');
    for (const adminRead of ['tenantStats', 'myAnnouncements', 'tenantBilling', 'mySubscription']) {
      expect(state.documents.join('\n')).not.toContain(adminRead);
    }
  });
});
