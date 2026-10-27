/**
 * HRDashboardPage — the certification reads, and what they fill, belong to workforce managers.
 *
 * Every module user reaches the dashboard, but the HR service refuses expiringCertifications and
 * expiredCertifications below MODULE_MANAGER. A reader the service would refuse must not send
 * them, and must not be shown a "0 expiring" for a list nobody looked at. The server below would
 * answer both reads, so what a module user does not see is the page's decision, not an empty list.
 */
import type { UserRole } from '@aquaculture/shared-ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GET_EXPIRED_CERTIFICATIONS,
  GET_EXPIRING_CERTIFICATIONS,
  GET_HR_DASHBOARD_STATS,
} from '../../graphql';
import { newQueryClient, requestsFor } from '../../hooks/__tests__/scopeHarness';
import { HRDashboardPage } from '../HRDashboardPage';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  role: { current: 'MODULE_MANAGER' as UserRole },
}));

vi.mock('../../hooks/useGraphQL', () => ({
  useGraphQLClient: () => ({ client: true }),
  graphqlRequest: mocks.request,
}));

// WHY: useTenantQuery reads the session through shared-ui's own useAuth module, and
// useIsWorkforceManager reads the role through the same one, so one fake serves both.
vi.mock('@shared-ui/hooks/useAuth', () => ({
  useAuth: () => ({
    token: 'token',
    tenantId: 'tenant-1',
    user: { id: 'user-1', role: mocks.role.current },
  }),
}));

// Fetches its own data and is not under test here.
vi.mock('../../components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components')>();
  return { ...actual, SeaLandSplitView: () => null };
});

const EXPIRING = {
  id: 'cert-1',
  daysUntilExpiry: 12,
  expiryDate: '2026-11-07',
  certificationType: { name: 'Offshore Safety', category: 'SAFETY' },
  employee: { firstName: 'Ada', lastName: 'Berg' },
};

const ANSWERS = new Map<unknown, unknown>([
  [GET_EXPIRING_CERTIFICATIONS, { expiringCertifications: [EXPIRING] }],
  [GET_EXPIRED_CERTIFICATIONS, { expiredCertifications: [] }],
]);

function renderPage(): void {
  render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter>
        <HRDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('HRDashboardPage certifications', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockImplementation((_client: unknown, document: unknown) =>
      Promise.resolve(ANSWERS.get(document) ?? {}),
    );
  });

  it('reads the expiring and expired certifications for a manager, and shows what they fill', async () => {
    mocks.role.current = 'MODULE_MANAGER';

    renderPage();

    expect(await screen.findByText('Certification Alerts')).toBeInTheDocument();
    expect(screen.getByText('Expiring Certs')).toBeInTheDocument();
    expect(screen.getByText('Active Certifications')).toBeInTheDocument();
    // The dashboard asks for the 30-day window; the alert it mounts asks for its own 90 and for the expired.
    expect(
      requestsFor(mocks.request, GET_EXPIRING_CERTIFICATIONS).map((vars) => vars.daysUntilExpiry),
    ).toEqual(expect.arrayContaining([30, 90]));
    expect(requestsFor(mocks.request, GET_EXPIRED_CERTIFICATIONS)).toHaveLength(1);
  });

  it('sends neither certification read for a module user, and shows no certification widget', async () => {
    mocks.role.current = 'MODULE_USER';

    renderPage();

    // The page has read its own data by now, so a read it meant to send would be in the log.
    await waitFor(() => expect(requestsFor(mocks.request, GET_HR_DASHBOARD_STATS)).toHaveLength(1));
    expect(requestsFor(mocks.request, GET_EXPIRING_CERTIFICATIONS)).toHaveLength(0);
    expect(requestsFor(mocks.request, GET_EXPIRED_CERTIFICATIONS)).toHaveLength(0);
    expect(screen.queryByText('Certification Alerts')).not.toBeInTheDocument();
    expect(screen.queryByText('Expiring Certs')).not.toBeInTheDocument();
    expect(screen.queryByText('Active Certifications')).not.toBeInTheDocument();
    expect(screen.queryByText(/expires soon/)).not.toBeInTheDocument();
  });

  it('keeps the rest of the dashboard for a module user', async () => {
    mocks.role.current = 'MODULE_USER';

    renderPage();

    expect(await screen.findByText('Total Employees')).toBeInTheDocument();
    expect(screen.getByText('Work Areas')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Add Employee/ })).not.toBeInTheDocument();
  });
});
