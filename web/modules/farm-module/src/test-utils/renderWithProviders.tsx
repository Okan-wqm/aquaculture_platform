/**
 * Provider harness for farm-module page specs (FARM-MEDIUM-120 scaffolding).
 *
 * Fresh QueryClient per render (no cross-test cache bleed, retries off so
 * failure-path tests settle immediately) + MemoryRouter because most pages
 * read route params / searchParams.
 */
import React from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

export interface RenderWithProvidersOptions {
  /** Initial location, e.g. '/production/batches/batch-1?tab=tanks'. */
  route?: string;
  /** Route pattern to mount `ui` under when the page reads useParams, e.g. 'production/batches/:batchId/*'. */
  path?: string;
}

export function renderWithProviders(
  ui: React.ReactElement,
  { route = '/', path }: RenderWithProvidersOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        {path ? (
          <Routes>
            <Route path={path} element={ui} />
          </Routes>
        ) : (
          ui
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}
