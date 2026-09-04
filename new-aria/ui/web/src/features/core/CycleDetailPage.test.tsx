import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CycleDetailResponse } from '../../../../shared/api-contract.ts';
import { setToken } from '../../api/token-store.ts';
import { CycleDetailPage } from './CycleDetailPage.tsx';

const DETAIL: CycleDetailResponse = {
  cycle: {
    cycleId: 'cycle-2026-09-03-001',
    startedAt: '2026-09-03T09:00:00Z',
    endedAt: '2026-09-03T09:12:00Z',
    status: 'completed',
    durationSeconds: 720,
    gitHeadSha: 'abcdef1234567890',
    toolDecisionCount: 9,
  },
  discovery: { completionProof: null, repoFingerprint: { treeHash: 'deadbeef' } },
  metrics: { phases: 4 },
  runs: [{ at: '2026-09-03T09:01:00Z', ledger_hash: 'aa11', tool_id: 'ruff' }],
  governance: [{ at: '2026-09-03T09:02:00Z', ledger_hash: 'bb22', event: 'gate_passed' }],
};

function renderAt(cycleId: string, body: CycleDetailResponse | null): void {
  vi.stubGlobal('fetch', async (): Promise<Response> => {
    if (body === null) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  render(
    <MemoryRouter initialEntries={[`/cycles/${cycleId}`]}>
      <Routes>
        <Route path="/cycles/:cycleId" element={<CycleDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CycleDetailPage', () => {
  beforeEach(() => {
    setToken('test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('joins the cycle facts, the discovery evidence and the ledgers under English headings', async () => {
    renderAt('cycle-2026-09-03-001', DETAIL);
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Cycle' })).toBeDefined());
    expect(screen.getByRole('heading', { level: 1, name: 'cycle-2026-09-03-001' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Cycles' })).toBeDefined();
    expect(screen.getByText('completed')).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: 'Repo fingerprint' })).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: 'Cycle metrics' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: 'Governance rows in this cycle' })).toBeDefined();
    // A cycle without a completion proof is a warning the operator must see.
    expect(screen.getByText(/Discovery did not close in this cycle/)).toBeDefined();
    expect(screen.getByText('Tool decisions')).toBeDefined();
  });

  it('names what failed when the cycle cannot be loaded', async () => {
    renderAt('missing-cycle', null);
    await waitFor(() => expect(screen.getByText('Could not load this cycle')).toBeDefined());
  });
});
