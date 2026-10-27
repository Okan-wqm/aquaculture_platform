/**
 * The Sync Status page lists the replays the server rejected for re-entry (PKG-42; ADR-051 C6).
 *
 * Before, a write refused on replay sat among the pending rows as "Permanently failed — please
 * remove": the worker saw neither what they had recorded nor why it was refused, so removing it
 * meant losing it. Now each rejected replay shows the reason in the worker's language and the
 * values they entered, and is dismissed only once they have entered it again.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncStatusPage } from '../SyncStatusPage';

import type { QueuedOperation } from '@/types';

const h = vi.hoisted(() => ({
  removeFromQueue: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
  operations: [] as QueuedOperation[],
}));

vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({
    pendingOperations: h.operations,
    pendingCount: h.operations.length,
    isOnline: true,
    isSyncing: false,
    syncNow: vi.fn(() => Promise.resolve({ success: 0, failed: 0 })),
    removeFromQueue: h.removeFromQueue,
  }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Ada Lovelace', role: 'MODULE_USER' } }),
}));

const REJECTED: QueuedOperation = {
  id: 'op-rejected',
  tenantId: 'tenant-1',
  type: 'acknowledgeAlert',
  payload: { alertId: 'alert-42', note: 'aerator restarted' },
  createdAt: '2026-10-27T06:31:00.000Z',
  retryCount: 1,
  status: 'failed',
  lastError: 'Forbidden resource',
  lastErrorCode: 'FORBIDDEN',
};

const PENDING: QueuedOperation = {
  id: 'op-pending',
  tenantId: 'tenant-1',
  type: 'acknowledgeAlert',
  payload: { alertId: 'alert-43' },
  createdAt: '2026-10-27T06:32:00.000Z',
  retryCount: 0,
  status: 'pending',
};

function renderPage(): void {
  render(<SyncStatusPage />);
}

describe('SyncStatusPage — rejected replays', () => {
  afterEach(() => {
    cleanup();
    h.removeFromQueue.mockClear();
  });

  it('lists a rejected replay with its reason and what the worker entered', () => {
    h.operations = [REJECTED, PENDING];
    renderPage();

    const section = screen.getByRole('region', { name: 'Needs re-entry' });
    expect(within(section).getByText('You no longer have access to record this.')).toBeTruthy();
    expect(within(section).getByText('alertId')).toBeTruthy();
    expect(within(section).getByText('alert-42')).toBeTruthy();
    expect(within(section).getByText('aerator restarted')).toBeTruthy();
    // The still-pending write is not listed as rejected.
    expect(within(section).queryByText('alert-43')).toBeNull();
  });

  it('dismisses a rejected replay only on the worker’s request', () => {
    h.operations = [REJECTED];
    renderPage();

    const section = screen.getByRole('region', { name: 'Needs re-entry' });
    fireEvent.click(within(section).getByRole('button', { name: 'Dismiss — entered again' }));

    expect(h.removeFromQueue).toHaveBeenCalledWith('op-rejected');
  });

  it('shows no re-entry list while nothing was rejected', () => {
    h.operations = [PENDING];
    renderPage();

    expect(screen.queryByRole('region', { name: 'Needs re-entry' })).toBeNull();
  });
});
