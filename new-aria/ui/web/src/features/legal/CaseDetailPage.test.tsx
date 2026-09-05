import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type {
  LegalCaseDetailResponse,
  LegalCaseResponse,
} from '../../../../shared/legal-contract.ts';
import { setToken } from '../../api/token-store.ts';
import { CaseDetailPage } from './CaseDetailPage.tsx';

const LIFECYCLE = { state: 'open' as const, retainUntil: null, decision: null };

function renderDetail(
  detail: LegalCaseDetailResponse,
  initialTab = 'documents',
): ReturnType<typeof createMemoryRouter> {
  vi.stubGlobal(
    'fetch',
    async (): Promise<Response> =>
      new Response(JSON.stringify(detail), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const router = createMemoryRouter(
    [
      {
        path: '/legal/cases/:caseId',
        element: <CaseDetailPage />,
        children: [
          { path: 'intake', element: <div>Upload intake</div> },
          { path: 'documents', element: <div>Document inventory</div> },
        ],
      },
    ],
    { initialEntries: [`/legal/cases/case-pending/${initialTab}`] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  setToken('test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CaseDetailPage', () => {
  it('opens a created case at Intake and says honestly that no inventory exists', async () => {
    const router = renderDetail({
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
      lifecycle: LIFECYCLE,
    });

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/legal/cases/case-pending/intake'),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Pending matter' })).toBeDefined();
    expect(screen.getAllByText('Not inventoried yet')).toHaveLength(2);
    expect(await screen.findByText('Upload intake')).toBeDefined();
    expect(document.body.textContent).not.toContain('Snapshot');
    expect(document.body.textContent).not.toContain('coverage complete');
  });

  it('offers Intake alongside the evidence tabs once an inventory exists', async () => {
    const ready: LegalCaseResponse = {
      case: {
        caseId: 'case-pending',
        title: 'Inventoried matter',
        jurisdiction: 'NO',
        courtReference: null,
        archiveRoot: 'archive',
        createdAt: '2026-09-05T10:00:00Z',
        snapshotSha256: 'a'.repeat(64),
        adapterId: 'legal-document-inventory',
        adapterVersion: '1.0.0',
        runId: 'run-1',
        cycleId: null,
      },
      summary: {
        caseId: 'case-pending',
        title: 'Inventoried matter',
        documents: 1,
        unreadable: 0,
        statements: 0,
        statementsNeedingReview: 0,
        timelineEvents: 0,
        parties: 0,
        createdAt: '2026-09-05T10:00:00Z',
      },
      coverage: {
        caseId: 'case-pending',
        totalFiles: 1,
        distinctDocuments: 1,
        byExtraction: { text: 1, metadata_only: 0, unreadable: 0, excluded: 0 },
        byKind: { DOCUMENT: 1 },
        excludedRoots: [],
        unreadable: [],
        reconciliation: null,
        truncated: { findings: 0, statements: 0, timeline: 0 },
        complete: true,
      },
      runKey: 'run-1',
      lifecycle: LIFECYCLE,
    };
    renderDetail(ready);

    expect(await screen.findByRole('tab', { name: 'Intake' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Documents 1' })).toBeDefined();
    expect(screen.getByText('Document inventory')).toBeDefined();
  });
});
