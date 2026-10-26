/**
 * CertificationDashboardPage — a manager-only screen, decided before it reads anything.
 *
 * The HR service refuses expiringCertifications and allCertifications below MODULE_MANAGER, and the
 * dashboard fires them the moment it mounts. A module user who follows the link must be shown the
 * restricted view with no read sent, not a dashboard of error states.
 */
import type { UserRole } from '@aquaculture/shared-ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET_ALL_CERTIFICATIONS, GET_EXPIRING_CERTIFICATIONS } from '../../../graphql';
import { newQueryClient, requestsFor } from '../../../hooks/__tests__/scopeHarness';
import { CertificationDashboardPage } from '../CertificationDashboardPage';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  role: { current: 'MODULE_MANAGER' as UserRole },
}));

vi.mock('../../../hooks/useGraphQL', () => ({
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

const ANSWERS = new Map<unknown, unknown>([
  [GET_EXPIRING_CERTIFICATIONS, { expiringCertifications: [] }],
  [GET_ALL_CERTIFICATIONS, { allCertifications: { items: [], total: 0 } }],
]);

function renderPage(): void {
  render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter>
        <CertificationDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CertificationDashboardPage', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockImplementation((_client: unknown, document: unknown) =>
      Promise.resolve(ANSWERS.get(document) ?? {}),
    );
  });

  it('reads the expiring windows and the certification list for a manager', async () => {
    mocks.role.current = 'MODULE_MANAGER';

    renderPage();

    expect(screen.getByText('Certification Dashboard')).toBeInTheDocument();
    await waitFor(() => expect(requestsFor(mocks.request, GET_ALL_CERTIFICATIONS)).toHaveLength(1));
    expect(
      requestsFor(mocks.request, GET_EXPIRING_CERTIFICATIONS).map((vars) => vars.daysUntilExpiry),
    ).toEqual(expect.arrayContaining([30, 7]));
    expect(screen.queryByText('Access Restricted')).not.toBeInTheDocument();
  });

  it('shows a module user the restricted view and sends no read at all', () => {
    mocks.role.current = 'MODULE_USER';

    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('Access Restricted');
    expect(
      screen.getByText('Certification records are restricted to HR managers and administrators.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to HR Dashboard' })).toHaveAttribute(
      'href',
      '/hr',
    );
    expect(screen.queryByText('Certification Dashboard')).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
