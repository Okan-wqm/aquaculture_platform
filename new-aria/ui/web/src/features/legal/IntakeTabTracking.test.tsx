import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import type { JobResponse } from '../../../../shared/api-contract.ts';
import type {
  LegalCaseDetailResponse,
  LegalIntakeResponse,
} from '../../../../shared/legal-contract.ts';
import { setToken } from '../../api/token-store.ts';
import { IntakeTab } from './IntakeTab.tsx';

vi.mock('../../app/HealthProvider.tsx', () => ({
  useHealth: () => ({
    state: {
      status: 'success',
      data: {
        legal: { toolId: 'legal-document-inventory', adapter: 'registered', detail: null },
      },
    },
    can: (actionClass: string) =>
      actionClass === 'case_intake' || actionClass === 'corpus_inventory',
  }),
}));

const DETAIL: LegalCaseDetailResponse = {
  case: {
    caseId: 'case-pending',
    title: 'Pending matter',
    jurisdiction: 'NO',
    courtReference: null,
    custodian: 'Lawyer One',
    createdAt: '2026-09-05T10:00:00Z',
    createdBy: 'operator-one',
  },
  summary: null,
  coverage: null,
  runKey: null,
  lifecycle: { state: 'open', retainUntil: null, decision: null },
};

const INTAKE: LegalIntakeResponse = {
  caseMeta: DETAIL.case,
  intake: [],
  chain: {
    status: 'empty',
    valid: true,
    rows: 0,
    brokenAt: null,
    reason: null,
    anchored: false,
    keyId: null,
  },
  lifecycle: DETAIL.lifecycle,
  removedRowHashes: [],
};

function job(state: JobResponse['state'], exitCode: number | null = null): JobResponse {
  return {
    jobId: 'job-1',
    kind: 'legal-inventory',
    state,
    command: ['secret-binary', '--private-path'],
    startedAt: '2026-09-05T10:01:00Z',
    finishedAt: state === 'succeeded' ? '2026-09-05T10:01:02Z' : null,
    exitCode,
    stdoutTail: 'private stdout',
    stderrTail: 'private stderr',
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('IntakeTab inventory tracking', () => {
  it('polls the accepted job to success, refreshes the case, and exposes no process streams', async () => {
    setToken('test-token');
    const reloadCase = vi.fn();
    let inventoryStarts = 0;
    let statusReads = 0;
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
        if (url.endsWith('/intake')) return Response.json(INTAKE);
        if (url.endsWith('/inventory') && method === 'POST') {
          inventoryStarts += 1;
          return Response.json(job('queued'));
        }
        if (url.endsWith('/jobs/job-1')) {
          statusReads += 1;
          if (statusReads === 1) {
            return Response.json(
              { error: 'status_temporarily_unavailable', detail: '/private/job/path' },
              { status: 503 },
            );
          }
          return Response.json(job('succeeded', 0));
        }
        return Response.json({ error: 'not_found' }, { status: 404 });
      },
    );

    render(
      <MemoryRouter initialEntries={['/legal/cases/case-pending/intake']}>
        <Routes>
          <Route
            element={<Outlet context={{ caseId: 'case-pending', detail: DETAIL, reloadCase }} />}
          >
            <Route path="/legal/cases/:caseId/intake" element={<IntakeTab />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const start = await screen.findByRole('button', { name: 'Run inventory' });
    vi.useFakeTimers();
    fireEvent.click(start);
    await act(async () => Promise.resolve());

    expect(screen.getByText('queued')).toBeDefined();
    expect(start.hasAttribute('disabled')).toBe(true);
    expect(reloadCase).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('secret-binary');
    expect(document.body.textContent).not.toContain('private stdout');
    expect(document.body.textContent).not.toContain('private stderr');

    await act(async () => vi.advanceTimersByTimeAsync(2000));

    expect(screen.getByText('Inventory status unavailable')).toBeDefined();
    expect(screen.getByText('status_temporarily_unavailable')).toBeDefined();
    expect(document.body.textContent).not.toContain('/private/job/path');
    expect(start.hasAttribute('disabled')).toBe(true);
    fireEvent.click(start);
    expect(inventoryStarts).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(2000));

    expect(screen.getByText('succeeded')).toBeDefined();
    expect(screen.getByText('exit 0')).toBeDefined();
    expect(reloadCase).toHaveBeenCalledTimes(1);
  });
});
