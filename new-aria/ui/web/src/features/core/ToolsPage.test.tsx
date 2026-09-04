import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolsResponse } from '../../../../shared/api-contract.ts';
import { setToken } from '../../api/token-store.ts';
import { ToolsPage } from './ToolsPage.tsx';

const TOOLS: ToolsResponse = {
  tools: [
    {
      toolId: 'ruff',
      kind: 'linter',
      status: 'ACTIVE',
      version: '0.6.4',
      declaredScope: ['aria-kernel/**'],
      lastRunAt: '2026-09-03T09:00:00Z',
      lastRunStatus: 'completed',
      runCount: 12,
    },
    {
      toolId: 'seal-checker',
      kind: 'verifier',
      status: 'ACTIVE',
      version: '1.0.0',
      declaredScope: [],
      lastRunAt: null,
      lastRunStatus: null,
      runCount: 0,
    },
    {
      toolId: 'scope-widener',
      kind: null,
      status: 'QUARANTINED',
      version: null,
      declaredScope: ['**'],
      lastRunAt: '2026-09-02T09:00:00Z',
      lastRunStatus: 'failed',
      runCount: 4,
    },
  ],
};

function stubFetch(body: ToolsResponse): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api/v1/tools')) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
}

describe('ToolsPage', () => {
  beforeEach(() => {
    setToken('test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the English column headers and keeps lifecycle statuses verbatim', async () => {
    stubFetch(TOOLS);
    render(<ToolsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Tools' })).toBeDefined();
    await waitFor(() => expect(screen.getByText('ruff')).toBeDefined());
    for (const header of ['Status', 'Tool', 'Kind', 'Version', 'Declared scope', 'Runs', 'Last run', 'Last run status']) {
      // A plain string name matches the whole accessible name: 'Status' and
      // 'Last run status' are distinct columns and a substring match would let
      // one stand in for the other.
      expect(screen.getByRole('columnheader', { name: header })).toBeDefined();
    }
    const table = screen.getByRole('table');
    expect(within(table).getByText('QUARANTINED')).toBeDefined();
    expect(within(table).getByText('failed')).toBeDefined();
  });

  it('names the registry entries the run history does not back up', async () => {
    stubFetch(TOOLS);
    render(<ToolsPage />);
    await waitFor(() => expect(screen.getByText('The registry and the run history disagree')).toBeDefined());
    const callout = screen.getByText('The registry and the run history disagree').closest('div');
    expect(callout?.textContent).toContain('seal-checker');
    // Total runs are summed across the registry, so the tile carries a number
    // the operator can compare against runs.jsonl.
    expect(screen.getByText('Recorded runs')).toBeDefined();
    expect(screen.getByText('16')).toBeDefined();
  });

  it('explains an empty registry instead of printing "no rows"', async () => {
    stubFetch({ tools: [] });
    render(<ToolsPage />);
    await waitFor(() => expect(screen.getByText('No tools registered')).toBeDefined());
    expect(screen.getByText(/registry\.json holds no entries/)).toBeDefined();
    expect(screen.queryByText('The registry and the run history disagree')).toBeNull();
  });
});
