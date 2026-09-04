import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { OverviewResponse } from '../../../../shared/api-contract.ts';
import { setToken } from '../../api/token-store.ts';
import { OverviewContent, OverviewPage } from './OverviewPage.tsx';

const OVERVIEW: OverviewResponse = {
  generatedAt: '2026-09-03T10:00:00Z',
  toolsDir: '/srv/aria/tools',
  workspaceRoot: '/srv/repo',
  profile: { current: 'standard', schedulerCeiling: 'strict', setBy: 'operator', setAt: '2026-09-01T00:00:00Z' },
  killSwitch: { engaged: true },
  breakers: [
    { name: 'llm_budget', state: 'closed', rows: 12 },
    { name: 'tool_failures', state: 'tripped', rows: 3 },
  ],
  budget: { tripped: false, detail: { spentUsd: 1.25 } },
  lastCycle: {
    cycleId: 'cycle-2026-09-03-001',
    startedAt: '2026-09-03T09:00:00Z',
    endedAt: '2026-09-03T09:12:00Z',
    status: 'completed',
    durationSeconds: 720,
    gitHeadSha: 'abcdef1234567890',
    toolDecisionCount: 9,
  },
  counts: { cycles: 41, rawFindings: 1200, beliefs: 87, pressures: 5, humanRequiredOpen: 2, agentRequests: 14, governanceRows: 3300 },
  gateway: { heartbeatAt: '2026-09-03T09:59:00Z', inboxPending: 1 },
};

describe('OverviewContent', () => {
  it('renders profile, ceiling, kill switch, breakers, counts and last cycle verbatim', () => {
    render(
      <MemoryRouter>
        <OverviewContent data={OVERVIEW} />
      </MemoryRouter>,
    );
    expect(screen.getAllByText('standard').length).toBeGreaterThan(0);
    expect(screen.getAllByText('strict').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('alert').some((node) => node.textContent?.includes('Kill switch devrede') === true)).toBe(true);
    expect(screen.getByText('llm_budget')).toBeDefined();
    expect(screen.getByText('tripped')).toBeDefined();
    expect(screen.getByRole('link', { name: 'cycle-2026-09-03-001' })).toBeDefined();
    expect(screen.getByText('completed')).toBeDefined();
    expect(screen.getByText('1.200')).toBeDefined();
    expect(screen.getByText('3.300')).toBeDefined();
  });

  it('shows explicit empty states for missing gateway and last cycle', () => {
    render(
      <MemoryRouter>
        <OverviewContent data={{ ...OVERVIEW, gateway: null, lastCycle: null, killSwitch: { engaged: false } }} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Gateway verisi yok/)).toBeDefined();
    expect(screen.getByText(/Henüz döngü kaydı yok/)).toBeDefined();
    expect(screen.queryByText('Kill switch devrede')).toBeNull();
    expect(document.body.textContent).not.toContain('undefined');
  });
});

describe('OverviewPage', () => {
  beforeEach(() => {
    setToken('test-token');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      if (url === '/api/v1/overview' && headers.get('authorization') === 'Bearer test-token') {
        return new Response(JSON.stringify(OVERVIEW), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the overview through the authenticated client and renders it', async () => {
    render(
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Genel Bakış' })).toBeDefined();
    await waitFor(() => expect(screen.getByRole('link', { name: 'cycle-2026-09-03-001' })).toBeDefined());
    expect(screen.getAllByText('standard').length).toBeGreaterThan(0);
  });
});
