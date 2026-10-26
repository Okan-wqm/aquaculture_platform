/**
 * PerformancePage — the managers' review desk, decided before it reads anything.
 *
 * The HR service refuses pendingReviews below MODULE_MANAGER, and the page asks for the reader's
 * own pending reviews the moment it mounts. A module user who opens it must be shown the restricted
 * view with no read sent, not a page with a failed alert.
 */
import type { UserRole } from '@aquaculture/shared-ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET_PENDING_REVIEWS, GET_PERFORMANCE_REVIEWS } from '../../graphql';
import { newQueryClient, requestsFor } from '../../hooks/__tests__/scopeHarness';
import PerformancePage from '../PerformancePage';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  role: { current: 'MODULE_MANAGER' as UserRole },
}));

vi.mock('../../hooks/useGraphQL', () => ({
  useGraphQLClient: () => ({ client: true }),
  graphqlRequest: mocks.request,
}));

// WHY: useIsWorkforceManager and useCurrentEmployeeId read the session through shared-ui's own
// useAuth module, so the session is faked at that module.
vi.mock('@shared-ui/hooks/useAuth', () => ({
  useAuth: () => ({
    token: 'token',
    tenantId: 'tenant-1',
    user: { id: 'user-1', role: mocks.role.current },
  }),
}));

const ANSWERS = new Map<unknown, unknown>([
  [GET_PENDING_REVIEWS, { pendingReviews: [] }],
  [GET_PERFORMANCE_REVIEWS, { performanceReviews: { items: [], total: 0 } }],
]);

function renderPage(): void {
  render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter>
        <PerformancePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PerformancePage', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockImplementation((_client: unknown, document: unknown) =>
      Promise.resolve(ANSWERS.get(document) ?? {}),
    );
  });

  it('reads the reviews and the reader’s pending reviews for a manager', async () => {
    mocks.role.current = 'MODULE_MANAGER';

    renderPage();

    expect(screen.getByText('Performance reviews and goal tracking')).toBeInTheDocument();
    await waitFor(() => expect(requestsFor(mocks.request, GET_PENDING_REVIEWS)).toHaveLength(1));
    expect(requestsFor(mocks.request, GET_PENDING_REVIEWS)[0]).toEqual({ reviewerId: 'user-1' });
    expect(requestsFor(mocks.request, GET_PERFORMANCE_REVIEWS)).toHaveLength(1);
    expect(screen.queryByText('Access Restricted')).not.toBeInTheDocument();
  });

  it('shows a module user the restricted view and sends no read at all', () => {
    mocks.role.current = 'MODULE_USER';

    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('Access Restricted');
    expect(
      screen.getByText('Performance reviews are restricted to HR managers and administrators.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to HR Dashboard' })).toHaveAttribute(
      'href',
      '/hr',
    );
    expect(screen.queryByText('Performance reviews and goal tracking')).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
