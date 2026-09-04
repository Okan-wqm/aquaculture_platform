import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HumanRequiredResponse } from '../../../../shared/api-contract.ts';
import { setToken } from '../../api/token-store.ts';
import { HumanRequiredPage } from './HumanRequiredPage.tsx';

const QUEUE: HumanRequiredResponse = {
  open: 2,
  items: [
    {
      requestId: 'hr-2026-09-03-001',
      severity: 'CRITICAL',
      reason: 'Kernel promotion needs an operator verdict',
      recordedAt: '2026-09-03T08:00:00Z',
      slaDeadline: '2026-09-03T09:00:00Z',
      slaBreached: true,
      resolved: false,
      context: { cycle_id: 'cycle-2026-09-03-001' },
    },
    {
      requestId: 'hr-2026-09-03-002',
      severity: 'MEDIUM',
      reason: 'Tool scope widened beyond its declared paths',
      recordedAt: '2026-09-03T10:00:00Z',
      slaDeadline: '2026-09-04T10:00:00Z',
      slaBreached: false,
      resolved: false,
      context: {},
    },
    {
      requestId: 'hr-2026-09-02-009',
      severity: 'LOW',
      reason: 'Ledger seal mismatch reviewed',
      recordedAt: '2026-09-02T10:00:00Z',
      slaDeadline: '2026-09-02T12:00:00Z',
      slaBreached: true,
      resolved: true,
      context: {},
    },
  ],
};

function stubFetch(body: HumanRequiredResponse): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api/v1/human-required')) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
}

describe('HumanRequiredPage', () => {
  beforeEach(() => {
    setToken('test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the English queue copy and keeps severities verbatim', async () => {
    stubFetch(QUEUE);
    render(<HumanRequiredPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Human required' })).toBeDefined();
    await waitFor(() => expect(screen.getByText('hr-2026-09-03-001')).toBeDefined());
    for (const header of ['Severity', 'SLA deadline', 'Reason', 'Request', 'Recorded', 'Status']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(header) })).toBeDefined();
    }
    const table = screen.getByRole('table');
    // Severities are kernel words and are never translated or re-cased.
    expect(within(table).getByText('CRITICAL')).toBeDefined();
    expect(within(table).getByText('MEDIUM')).toBeDefined();
  });

  it('makes a breached SLA unmistakable and names what the console cannot do', async () => {
    stubFetch(QUEUE);
    render(<HumanRequiredPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Open items are past their SLA deadline')).toBeDefined();
    expect(alert.textContent).toContain('adjudications ledger');
    // The resolved item is filtered out, so only the one open breach counts.
    expect(alert.textContent).toContain('1 open item is past the deadline');
  });

  it('explains an empty queue instead of printing "no rows"', async () => {
    stubFetch({ open: 0, items: [] });
    render(<HumanRequiredPage />);
    await waitFor(() => expect(screen.getByText('Nothing awaiting a decision')).toBeDefined());
    expect(screen.getByText(/every recorded item has been resolved/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks for a selection before it shows context', async () => {
    stubFetch(QUEUE);
    render(<HumanRequiredPage />);
    await waitFor(() => expect(screen.getByText('No item selected')).toBeDefined());
    expect(screen.getByText(/Select a row to read the reason/)).toBeDefined();
  });
});
