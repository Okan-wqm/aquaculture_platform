import React from 'react';
import { createStandardPaginatedResult } from '@platform/admin-http-contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { impersonationApi, tenantsApi, type ImpersonationSession } from '../../services/adminApi';
import { AdminApiError } from '../../services/http-client';
import { ImpersonationPage } from './ImpersonationPage';

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuthContext: () => ({ user: { id: '11111111-1111-4111-8111-111111111111' } }),
  };
});

vi.mock('../../services/adminApi', () => ({
  impersonationApi: {
    getPermissions: vi.fn(),
    getImpersonationStats: vi.fn(),
    getSessions: vi.fn(),
    startSession: vi.fn(),
    endSession: vi.fn(),
    extendSession: vi.fn(),
    revokeSession: vi.fn(),
    grantPermission: vi.fn(),
    revokePermission: vi.fn(),
  },
  tenantsApi: { search: vi.fn() },
}));

vi.mock('../../services/browser-capabilities', () => ({
  openAdminNavigation: vi.fn(),
}));

const EMPTY_PERMISSIONS = createStandardPaginatedResult([], 0, 1, 100);
const EMPTY_SESSIONS = createStandardPaginatedResult([], 0, 1, 20);
const STATS = {
  activePermissions: 0,
  activeSessions: 0,
  recentSessions: [],
  topAdmins: [],
  totalSessions: 0,
};

function sessionFixture(
  id: string,
  targetTenantName: string,
  status: ImpersonationSession['status'] = 'ended',
): ImpersonationSession {
  return {
    id,
    superAdminId: '11111111-1111-4111-8111-111111111111',
    superAdminEmail: 'admin@example.com',
    targetTenantId: '22222222-2222-4222-8222-222222222222',
    targetTenantName,
    status,
    reason: 'debugging',
    mfaCompleted: true,
    expiresAt: '2026-08-09T14:00:00.000Z',
    endedAt: status === 'active' ? undefined : '2026-08-09T13:00:00.000Z',
    actionCount: 4,
    createdAt: '2026-08-09T12:00:00.000Z',
    updatedAt: '2026-08-09T13:00:00.000Z',
  };
}

function renderPage(): void {
  render(
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ImpersonationPage />
    </BrowserRouter>,
  );
}

describe('ImpersonationPage session read authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(impersonationApi.getPermissions).mockResolvedValue(EMPTY_PERMISSIONS);
    vi.mocked(impersonationApi.getImpersonationStats).mockResolvedValue(STATS);
    vi.mocked(tenantsApi.search).mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it('renders rejected active-session evidence instead of an authoritative empty state', async () => {
    vi.mocked(impersonationApi.getSessions).mockRejectedValue(
      new AdminApiError(
        'Session authority unavailable',
        503,
        'SERVICE_UNAVAILABLE',
        undefined,
        'request_12345678',
      ),
    );

    renderPage();

    expect(
      await screen.findByText('The active-session page read was rejected'),
    ).toBeInTheDocument();
    expect(screen.getByText(/status=503/)).toHaveTextContent('requestId=request_12345678');
    expect(screen.getByText(/Coordinates:/)).toHaveTextContent('page=1, limit=20, status=active');
    expect(screen.queryByText('No active impersonation sessions')).not.toBeInTheDocument();
  });

  it('keeps a rejected all-sessions read distinct from a verified empty page', async () => {
    vi.mocked(impersonationApi.getSessions).mockImplementation((query) =>
      query.status === 'active'
        ? Promise.resolve(EMPTY_SESSIONS)
        : Promise.reject(
            new AdminApiError(
              'History authority unavailable',
              502,
              'BAD_GATEWAY',
              undefined,
              'request_history_123',
            ),
          ),
    );

    renderPage();
    await screen.findByText('No active impersonation sessions');
    fireEvent.click(screen.getByRole('button', { name: 'All Sessions' }));

    expect(await screen.findByText('The all-sessions page read was rejected')).toBeInTheDocument();
    expect(screen.getByText(/status=502/)).toHaveTextContent('requestId=request_history_123');
    expect(screen.queryByText('No sessions found')).not.toBeInTheDocument();
  });

  it('navigates canonical server pages without client-side slicing or filtering', async () => {
    const firstPage = createStandardPaginatedResult(
      [sessionFixture('33333333-3333-4333-8333-333333333333', 'Ocean One')],
      21,
      1,
      20,
    );
    const secondPage = createStandardPaginatedResult(
      [sessionFixture('44444444-4444-4444-8444-444444444444', 'Ocean Two')],
      21,
      2,
      20,
    );
    vi.mocked(impersonationApi.getSessions).mockImplementation((query) => {
      if (query.status === 'active') return Promise.resolve(EMPTY_SESSIONS);
      return Promise.resolve(query.page === 2 ? secondPage : firstPage);
    });

    renderPage();
    await screen.findByText('No active impersonation sessions');
    fireEvent.click(screen.getByRole('button', { name: 'All Sessions' }));

    expect(await screen.findByText('Ocean One')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2 (21 sessions)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Ocean Two')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 2 (21 sessions)')).toBeInTheDocument();
    await waitFor(() =>
      expect(impersonationApi.getSessions).toHaveBeenCalledWith(
        { page: 2, limit: 20 },
        { signal: expect.any(AbortSignal) },
      ),
    );
  });
});
