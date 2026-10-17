/**
 * Renders the facility-structure tab for its specs, inside the providers it
 * needs. WHY not renderWithProviders: its `rerender` drops the providers, and
 * these specs re-render in place to stand in for a refetch (structureFixtures
 * `state` changed) while the tab keeps its selection, open rows and focus.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

import { FacilityStructureTab } from '../FacilityStructureTab';

export interface StructureRender extends RenderResult {
  /** Re-render the same tab after the fixtures changed (a refetch). */
  refetch: () => void;
}

export function renderStructure(): StructureRender {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Providers({ children }: { children: React.ReactNode }): React.ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/sites/setup/structure']}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  const result = render(<FacilityStructureTab />, { wrapper: Providers });
  return { ...result, refetch: () => result.rerender(<FacilityStructureTab />) };
}
