import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  auth: {
    tenantId: 'tenant-a' as string | null,
    token: 'token-a' as string | null,
    role: 'TENANT_ADMIN',
    epoch: 0,
  },
  sites: [
    {
      id: 'site-a',
      code: 'A-1',
      name: 'Fjord Alpha',
      isActive: true,
      status: 'ACTIVE',
    },
    {
      id: 'site-b',
      code: 'B-1',
      name: 'Fjord Beta',
      isActive: true,
      status: 'ACTIVE',
    },
  ],
  assignedIds: ['site-a'],
  serverAssignedIds: ['site-a'],
  sitesPending: false,
  assignmentsPending: false,
  sitesError: false,
  assignmentsError: false,
  assign: vi.fn(),
  unassign: vi.fn(),
  refetchSites: vi.fn(),
  refetchAssignments: vi.fn(),
  useActiveSites: vi.fn(),
  useAssignedIds: vi.fn(),
}));

vi.mock('@aquaculture/shared-ui', () => ({
  useAuth: () => ({
    tenantId: state.auth.tenantId,
    token: state.auth.token,
    user: { role: state.auth.role },
  }),
  getSessionSnapshot: () => ({
    effectiveTenantId: state.auth.tenantId,
    sessionEpoch: state.auth.epoch,
  }),
  hasSameTenantSessionBoundary: (
    previous: readonly unknown[],
    current: readonly unknown[],
  ): boolean =>
    previous[1] === current[1] &&
    JSON.stringify(previous.at(-1)) === JSON.stringify(current.at(-1)),
}));

vi.mock('../../../hooks/useFocusTrap', () => ({
  useFocusTrap: () => ({
    containerRef: { current: null },
    handleKeyDown: vi.fn(),
  }),
}));

vi.mock('../../../utils/error-handling', () => ({
  sanitizeErrorMessage: () => 'The site access change could not be saved.',
}));

vi.mock('../../../hooks/useUserSiteAccess', () => {
  class SiteAccessSessionChangedError extends Error {
    constructor() {
      super(
        'The site-access change completed for the previous session. Re-open the user in the current tenant.',
      );
      this.name = 'SiteAccessSessionChangedError';
    }
  }

  return {
    canManageUserSiteAccess: (role: string | null | undefined): boolean =>
      role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN',
    SiteAccessSessionChangedError,
    userSiteAccessKeys: {
      assignments: (tenantId: string | null, userId: string): readonly unknown[] => [
        'tenant',
        tenantId,
        'userSiteAccess',
        'assignments',
        userId,
        { __sessionEpoch: state.auth.epoch },
      ],
    },
    useActiveTenantSites: (enabled: boolean) => {
      state.useActiveSites(enabled);
      return {
        data: state.sitesPending || state.sitesError ? undefined : state.sites,
        isPending: state.sitesPending,
        isFetching: state.sitesPending,
        isError: state.sitesError,
        error: state.sitesError ? new Error('farm catalog unavailable') : null,
        refetch: state.refetchSites,
      };
    },
    useUserAssignedSiteIds: (_userId: string, enabled: boolean) => {
      state.useAssignedIds(enabled);
      return {
        data: state.assignmentsPending || state.assignmentsError ? undefined : state.assignedIds,
        isPending: state.assignmentsPending,
        isFetching: state.assignmentsPending,
        isError: state.assignmentsError,
        error: state.assignmentsError ? new Error('assignments unavailable') : null,
        refetch: state.refetchAssignments,
      };
    },
    useAssignUserToSite: () => ({
      isPending: false,
      mutateAsync: state.assign,
    }),
    useUnassignUserFromSite: () => ({
      isPending: false,
      mutateAsync: state.unassign,
    }),
  };
});

import { SiteAccessModal } from '../SiteAccessModal';

const targetUser = {
  id: 'user-a',
  name: 'Nora User',
  email: 'nora@example.test',
  role: 'MODULE_USER',
  status: 'active',
  lastLogin: 'Today',
};

function renderModal(): ReturnType<typeof render> {
  return render(<SiteAccessModal isOpen onClose={vi.fn()} user={targetUser} />);
}

describe('SiteAccessModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.auth.tenantId = 'tenant-a';
    state.auth.token = 'token-a';
    state.auth.role = 'TENANT_ADMIN';
    state.auth.epoch = 0;
    state.sites = [
      {
        id: 'site-a',
        code: 'A-1',
        name: 'Fjord Alpha',
        isActive: true,
        status: 'ACTIVE',
      },
      {
        id: 'site-b',
        code: 'B-1',
        name: 'Fjord Beta',
        isActive: true,
        status: 'ACTIVE',
      },
    ];
    state.assignedIds = ['site-a'];
    state.serverAssignedIds = ['site-a'];
    state.sitesPending = false;
    state.assignmentsPending = false;
    state.sitesError = false;
    state.assignmentsError = false;
    state.refetchSites.mockResolvedValue({ isError: false });
    state.refetchAssignments.mockImplementation(async () => {
      state.assignedIds = [...state.serverAssignedIds];
      return { isError: false };
    });
    state.assign.mockImplementation(async ({ userId, siteId }) => {
      state.serverAssignedIds = [...state.serverAssignedIds, siteId];
      return { success: true, message: 'Site assigned', userId, siteId };
    });
    state.unassign.mockImplementation(async ({ userId, siteId }) => {
      state.serverAssignedIds = state.serverAssignedIds.filter((id) => id !== siteId);
      return { success: true, message: 'Site removed', userId, siteId };
    });
  });

  it('confirms assign and unassign, then renders only reloaded state', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(
      screen.getByRole('button', {
        name: 'Assign Fjord Beta access for Nora User',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm assignment' }));

    await waitFor(() => expect(state.refetchAssignments).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Site assigned')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Remove Fjord Beta access for Nora User',
      }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: 'Remove Fjord Alpha access for Nora User',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm removal' }));

    await waitFor(() => expect(state.refetchAssignments).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Site removed')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Assign Fjord Alpha access for Nora User',
      }),
    ).toBeInTheDocument();
  });

  it('keeps the authoritative display unchanged when assignment fails', async () => {
    state.assign.mockRejectedValue(new Error('database unavailable'));
    const user = userEvent.setup();
    renderModal();

    await user.click(
      screen.getByRole('button', {
        name: 'Assign Fjord Beta access for Nora User',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm assignment' }));

    expect(
      await screen.findByText('The site access change could not be saved.'),
    ).toBeInTheDocument();
    expect(state.refetchAssignments).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.getByRole('button', {
        name: 'Assign Fjord Beta access for Nora User',
      }),
    ).toBeInTheDocument();
  });

  it('keeps the old state and blocks more writes when authoritative reload fails', async () => {
    state.refetchAssignments.mockResolvedValue({ isError: true });
    const user = userEvent.setup();
    renderModal();

    await user.click(
      screen.getByRole('button', {
        name: 'Assign Fjord Beta access for Nora User',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm assignment' }));

    expect(
      await screen.findByText(
        /change was saved, but the current site access could not be reloaded/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry access reload' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Assign Fjord Beta access for Nora User',
      }),
    ).toBeDisabled();
    expect(state.assignedIds).toEqual(['site-a']);
  });

  it('fails closed for a non-admin role', () => {
    state.auth.role = 'MODULE_MANAGER';
    renderModal();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(state.useActiveSites).toHaveBeenCalledWith(false);
    expect(state.useAssignedIds).toHaveBeenCalledWith(false);
    expect(state.assign).not.toHaveBeenCalled();
  });

  it('shows an explicit loading state while authoritative reads are pending', () => {
    state.assignmentsPending = true;
    renderModal();

    expect(screen.getByRole('status')).toHaveTextContent('Loading site access');
  });

  it('fails closed with a retry state when either authoritative read fails', () => {
    state.assignmentsError = true;
    renderModal();

    expect(screen.getByRole('alert')).toHaveTextContent('Site access could not be loaded');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The site access change could not be saved.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Fjord Alpha')).not.toBeInTheDocument();
  });

  it('shows an explicit empty state when the tenant has no active sites or assignments', () => {
    state.sites = [];
    state.assignedIds = [];
    state.serverAssignedIds = [];
    renderModal();

    expect(screen.getByRole('status')).toHaveTextContent('No active sites');
    expect(
      screen.queryByRole('button', { name: /Assign .* access for Nora User/ }),
    ).not.toBeInTheDocument();
  });

  it('does not show prior-session success when the session switches during refetch', async () => {
    let resolveRefetch: ((value: { isError: boolean }) => void) | undefined;
    state.refetchAssignments.mockReturnValue(
      new Promise((resolve) => {
        resolveRefetch = resolve;
      }),
    );
    const user = userEvent.setup();
    const view = renderModal();

    await user.click(
      screen.getByRole('button', {
        name: 'Assign Fjord Beta access for Nora User',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm assignment' }));
    await waitFor(() => expect(state.refetchAssignments).toHaveBeenCalledTimes(1));

    state.auth.tenantId = 'tenant-b';
    state.auth.token = 'token-b';
    state.auth.epoch = 1;
    view.rerender(<SiteAccessModal isOpen onClose={vi.fn()} user={targetUser} />);
    await act(async () => {
      resolveRefetch?.({ isError: false });
      await Promise.resolve();
    });

    expect(screen.queryByText('Site assigned')).not.toBeInTheDocument();
    expect(await screen.findByText('Tenant session changed')).toBeInTheDocument();
  });

  it('shows an unavailable assigned site as remove-only instead of hiding it', async () => {
    state.assignedIds = ['site-a', 'site-retired'];
    state.serverAssignedIds = ['site-a', 'site-retired'];
    const user = userEvent.setup();
    renderModal();

    expect(screen.getByText('Unavailable site assignment')).toBeInTheDocument();
    expect(screen.getByText(/Site ID:\s*site-retired/)).toBeInTheDocument();
    expect(screen.getByText('Assigned · unavailable')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /Assign Unavailable site assignment site-retired access/i,
      }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: /Remove Unavailable site assignment site-retired access/i,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm removal' }));

    expect(state.unassign).toHaveBeenCalledWith({
      userId: targetUser.id,
      siteId: 'site-retired',
    });
  });

  it('suppresses a tenant-A confirmation synchronously after switching to tenant B', async () => {
    const user = userEvent.setup();
    const view = renderModal();

    await user.click(
      screen.getByRole('button', {
        name: 'Assign Fjord Beta access for Nora User',
      }),
    );
    expect(screen.getByRole('button', { name: 'Confirm assignment' })).toBeInTheDocument();

    state.auth.tenantId = 'tenant-b';
    state.auth.token = 'token-b';
    state.auth.epoch = 1;
    view.rerender(<SiteAccessModal isOpen onClose={vi.fn()} user={targetUser} />);

    expect(screen.queryByRole('button', { name: 'Confirm assignment' })).not.toBeInTheDocument();
    expect(screen.getByText('Tenant session changed')).toBeInTheDocument();
    expect(state.assign).not.toHaveBeenCalled();
  });

  it('suppresses a user-A confirmation when the target changes in the same session', async () => {
    const user = userEvent.setup();
    const view = renderModal();

    await user.click(
      screen.getByRole('button', {
        name: 'Assign Fjord Beta access for Nora User',
      }),
    );
    const secondTarget = {
      ...targetUser,
      id: 'user-b',
      name: 'Bente User',
      email: 'bente@example.test',
    };

    view.rerender(<SiteAccessModal isOpen onClose={vi.fn()} user={secondTarget} />);

    expect(screen.queryByRole('button', { name: 'Confirm assignment' })).not.toBeInTheDocument();
    expect(screen.getByText('Tenant session changed')).toBeInTheDocument();
    expect(state.assign).not.toHaveBeenCalled();
  });
});
