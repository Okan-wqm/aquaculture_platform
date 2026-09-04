import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { CyclesResponse } from '../../../../shared/api-contract.ts';
import { setToken } from '../../api/token-store.ts';
import { CyclesPage } from './CyclesPage.tsx';

const CYCLES: CyclesResponse = {
  total: 2,
  cycles: [
    {
      cycleId: 'cycle-2026-09-03-001',
      startedAt: '2026-09-03T09:00:00Z',
      endedAt: '2026-09-03T09:12:00Z',
      status: 'completed',
      durationSeconds: 720,
      gitHeadSha: 'abcdef1234567890',
      toolDecisionCount: 9,
    },
    {
      cycleId: 'cycle-2026-09-02-004',
      startedAt: '2026-09-02T22:00:00Z',
      endedAt: null,
      status: 'failed',
      durationSeconds: null,
      gitHeadSha: null,
      toolDecisionCount: 0,
    },
  ],
};

function stubFetch(body: CyclesResponse): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api/v1/cycles')) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
}

describe('CyclesPage', () => {
  beforeEach(() => {
    setToken('test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the English column headers and keeps cycle statuses verbatim', async () => {
    stubFetch(CYCLES);
    render(
      <MemoryRouter>
        <CyclesPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Cycles' })).toBeDefined();
    await waitFor(() => expect(screen.getByRole('link', { name: 'cycle-2026-09-03-001' })).toBeDefined());
    for (const header of ['Cycle', 'Status', 'Started', 'Ended', 'Duration', 'git HEAD', 'Tool decisions']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(header) })).toBeDefined();
    }
    // Statuses are kernel words: they appear verbatim in the rows and, because
    // the filter is built from the loaded rows, in the status select as well.
    const table = screen.getByRole('table');
    expect(within(table).getByText('completed')).toBeDefined();
    expect(within(table).getByText('failed')).toBeDefined();
    expect(within(screen.getByLabelText('Status')).getByRole('option', { name: 'completed' })).toBeDefined();
  });

  it('states what an empty cycle ledger means instead of printing "no rows"', async () => {
    stubFetch({ total: 0, cycles: [] });
    render(
      <MemoryRouter>
        <CyclesPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('No cycles yet')).toBeDefined());
    expect(screen.getByText(/Every kernel run appends a row to cycles\.jsonl/)).toBeDefined();
  });
});
