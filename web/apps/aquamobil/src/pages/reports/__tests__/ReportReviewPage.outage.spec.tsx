/**
 * ReportReviewPage outage specs (ORPHAN-MEDIUM-590, via ORPHAN-HIGH-595).
 *
 * This page is where a Mattilsynet submission is reviewed and approved. It
 * previously branched on `isLoading` and `isSuccess && !draft` only, so a FAILED
 * query rendered the header and nothing beneath it — not "could not load", not
 * "nothing here", just a blank regulated surface.
 *
 * It now goes through Loadable/DataState rather than a hand-rolled isError
 * branch, so the failure arm cannot be dropped again without a compile error.
 * These specs prove the arm actually renders, because five previous instances
 * of this defect all passed code review while failing under a real failure.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { ReportReviewPage } from '../ReportReviewPage';

const h = vi.hoisted(() => ({
  shouldFail: false,
  graphqlRequest: vi.fn(),
}));

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => {
    if (h.shouldFail) return Promise.reject(new Error('network down'));
    return h.graphqlRequest(...args);
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ tenantId: 't1', isAuthenticated: true, user: { name: 'Ola' } }),
}));

vi.mock('@/hooks/useNetworkStatus', () => ({ useNetworkStatus: () => true }));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ draftId: 'draft-1' }),
}));

function wrap(node: ReactNode): ReactNode {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(() => {
  h.shouldFail = false;
  h.graphqlRequest.mockReset();
  cleanup();
});

describe('ReportReviewPage — a failed fetch is not a blank regulated surface', () => {
  it('says the draft could not be loaded, and offers a retry', async () => {
    h.shouldFail = true;
    render(wrap(<ReportReviewPage />));

    await waitFor(() => {
      expect(screen.getByText(/could not load the report draft/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('does NOT say the draft is missing when the fetch simply failed', async () => {
    // "Draft not found" tells a manager the submission is gone. A network error
    // is not entitled to make that claim about a regulatory record.
    h.shouldFail = true;
    render(wrap(<ReportReviewPage />));

    await waitFor(() => {
      expect(screen.getByText(/could not load/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/draft not found/i)).not.toBeInTheDocument();
  });

  it('still reports a genuinely missing draft as missing', async () => {
    // The inverse half of the contract: a SUCCESSFUL fetch that returns no
    // matching draft must not be dressed up as an outage.
    h.shouldFail = false;
    h.graphqlRequest.mockResolvedValue({ reportDrafts: [] });
    render(wrap(<ReportReviewPage />));

    await waitFor(() => {
      expect(screen.getByText(/draft not found/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
  });
});
