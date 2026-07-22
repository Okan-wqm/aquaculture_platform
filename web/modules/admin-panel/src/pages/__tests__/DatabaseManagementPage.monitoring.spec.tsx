/**
 * APA-324 regression: the Monitoring tab's Index Recommendations must render the
 * real backend contract (recommendedAction + indexName + db-migrate authority),
 * never a phantom `createStatement` SQL block.
 *
 * The backend IndexRecommendation (database-management.entity.ts) deliberately
 * carries NO createStatement — runtime is forbidden to run DDL; recommendations
 * are applied through the audited db-migrate workflow. The FE interface, api
 * generic, and render had all drifted to promise `createStatement`, so the card
 * always showed an empty `<code>` block. This test renders a backend-shaped
 * recommendation and asserts the real fields appear.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/database-mgmt.md#APA-324
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import DatabaseManagementPage from '../DatabaseManagementPage';
import { databaseApi } from '../../services/api/database';

vi.mock('../../services/api/database', async () => {
  const actual =
    await vi.importActual<typeof import('../../services/api/database')>(
      '../../services/api/database',
    );
  return {
    ...actual,
    databaseApi: {
      ...actual.databaseApi,
      getSchemas: vi.fn(),
      getDatabaseHealth: vi.fn(),
      getConnectionStats: vi.fn(),
      getStorageByTenant: vi.fn(),
      getSlowQueries: vi.fn(),
      getIndexRecommendations: vi.fn(),
    },
  };
});

const api = vi.mocked(databaseApi);

describe('DatabaseManagementPage index recommendations (APA-324)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The default Schemas tab mounts first; resolve it cleanly so its loader
    // settles without an unhandled rejection when we switch to Monitoring.
    api.getSchemas.mockResolvedValue({ data: [], total: 0, page: 1, limit: 100, totalPages: 0 });
    // Health/connections render behind `data ? … : null` guards inside the
    // (mounted) Monitoring tab, so a caught rejection simply renders nothing.
    api.getDatabaseHealth.mockRejectedValue(new Error('unused in this test'));
    api.getConnectionStats.mockRejectedValue(new Error('unused in this test'));
    api.getStorageByTenant.mockResolvedValue([]);
    api.getSlowQueries.mockResolvedValue([]);
    api.getIndexRecommendations.mockResolvedValue([
      {
        tableName: 'auth.users',
        columns: ['email'],
        indexType: 'btree',
        reason: 'High sequential scan count (500) with 20000 rows',
        estimatedImpact: 'high',
        recommendedAction: 'add_index',
        indexName: 'idx_users_email',
        authority: 'db-migrate',
      },
    ]);
  });

  it('renders indexName + recommendedAction from the real backend contract, never an empty SQL block', async () => {
    render(
      <BrowserRouter>
        <DatabaseManagementPage />
      </BrowserRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /monitoring/i }));
    await waitFor(() => expect(api.getIndexRecommendations).toHaveBeenCalled());

    expect(await screen.findByText('idx_users_email')).toBeInTheDocument();
    expect(screen.getByText(/Add index/i)).toBeInTheDocument();
    expect(screen.getByText(/db-migrate workflow/i)).toBeInTheDocument();
  });
});
