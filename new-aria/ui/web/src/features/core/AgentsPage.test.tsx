import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { AgentRequestsResponse } from '../../../../shared/api-contract.ts';
import { setToken } from '../../api/token-store.ts';
import { AgentsPage } from './AgentsPage.tsx';

const REQUESTS: AgentRequestsResponse = {
  byState: { accepted: 3, pending: 1, rejected: 1 },
  requests: [
    {
      requestId: 'req-0001',
      cycleId: 'cycle-2026-09-03-001',
      role: 'reviewer',
      targetAgent: 'aria-reviewer',
      state: 'accepted',
      createdAt: '2026-09-03T08:00:00Z',
      claimedAt: '2026-09-03T08:01:00Z',
      submittedAt: '2026-09-03T08:20:00Z',
      resultStatus: 'accepted',
    },
    {
      requestId: 'req-0002',
      cycleId: null,
      role: null,
      targetAgent: null,
      state: 'pending',
      createdAt: '2026-09-03T09:00:00Z',
      claimedAt: null,
      submittedAt: null,
      resultStatus: null,
    },
  ],
};

function stubFetch(body: AgentRequestsResponse): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api/v1/agents/requests')) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
}

describe('AgentsPage', () => {
  beforeEach(() => {
    setToken('test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leads with the lifecycle distribution and keeps kernel states verbatim', async () => {
    stubFetch(REQUESTS);
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeDefined();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Lifecycle' })).toBeDefined());
    // The distribution tiles are labelled with the kernel's own state words.
    expect(screen.getAllByText('accepted').length).toBeGreaterThan(0);
    expect(screen.getAllByText('rejected').length).toBeGreaterThan(0);
    for (const header of ['State', 'Role', 'Agent', 'Request', 'Cycle', 'Created', 'Claimed', 'Submitted', 'Result']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(header) })).toBeDefined();
    }
    const table = screen.getByRole('table');
    expect(within(table).getByRole('link', { name: 'cycle-2026-09-03-001' })).toBeDefined();
  });

  it('offers an English state filter whose options stay in kernel vocabulary', async () => {
    stubFetch(REQUESTS);
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    const select = screen.getByLabelText('State');
    expect(within(select).getByRole('option', { name: 'All' })).toBeDefined();
    expect(within(select).getByRole('option', { name: 'expired' })).toBeDefined();
  });

  it('explains an empty agent ledger instead of printing "no rows"', async () => {
    stubFetch({ byState: {}, requests: [] });
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('No agent requests yet')).toBeDefined());
    expect(screen.getByText(/the agent ledgers have no rows/)).toBeDefined();
    expect(screen.getByText(/Each lifecycle state the agent ledgers recorded would be counted here/)).toBeDefined();
  });
});
