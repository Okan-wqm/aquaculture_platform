import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlansResponse } from '../../../../shared/api-contract.ts';
import { setToken } from '../../api/token-store.ts';
import { PlansPage } from './PlansPage.tsx';

const PLANS: PlansResponse = {
  byState: { converged: 2, running: 1 },
  plans: [
    {
      planId: 'plan-2026-09-03-001',
      state: 'converged',
      round: 3,
      pressureEventId: 'pressure-0042',
      updatedAt: '2026-09-03T09:00:00Z',
      terminalState: 'converged',
    },
    {
      planId: 'plan-2026-09-03-002',
      state: 'running',
      round: 1,
      pressureEventId: null,
      updatedAt: '2026-09-03T10:00:00Z',
      terminalState: null,
    },
  ],
};

function stubFetch(body: PlansResponse): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api/v1/plans')) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
}

describe('PlansPage', () => {
  beforeEach(() => {
    setToken('test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the English column headers and keeps plan states verbatim', async () => {
    stubFetch(PLANS);
    render(<PlansPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Plans' })).toBeDefined();
    await waitFor(() => expect(screen.getByText('plan-2026-09-03-001')).toBeDefined());
    for (const header of ['State', 'Plan', 'Round', 'Pressure event', 'Terminal state', 'Updated']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(header) })).toBeDefined();
    }
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('converged').length).toBeGreaterThan(0);
    expect(within(table).getByText('running')).toBeDefined();
  });

  it('states how many loaded plans are still moving', async () => {
    stubFetch(PLANS);
    render(<PlansPage />);
    await waitFor(() => expect(screen.getByText(/1 of 2 loaded plans have no terminal state/)).toBeDefined());
  });

  it('explains an empty plan ledger instead of printing "no rows"', async () => {
    stubFetch({ byState: {}, plans: [] });
    render(<PlansPage />);
    await waitFor(() => expect(screen.getByText('No plans yet')).toBeDefined());
    expect(screen.getByText(/plans\/ has no records/)).toBeDefined();
  });
});
