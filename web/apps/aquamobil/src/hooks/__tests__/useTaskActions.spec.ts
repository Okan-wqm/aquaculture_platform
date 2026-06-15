/**
 * useTaskActions Hook Tests — Task Offline Regression Coverage
 *
 * AQ-05: Truthful queued-state UI (task actions return wasQueued semantics)
 *
 * Tests:
 * - Offline task action returns { wasQueued: true, operationId }
 * - Checklist toggle throws when offline (no queue type for checklists)
 * - Online task action returns { wasQueued: false } on success
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — must be declared before imports
// --------------------------------------------------------------------------

// Mock useOfflineQueue to avoid the full OfflineProvider + QueryClientProvider tree.
// WHY: The monorepo has duplicated React instances (root vs local node_modules)
// which breaks renderHook with full provider trees. Mocking the dependency hook
// lets us test useTaskActions logic without the provider infrastructure.
const mockAddToQueue = vi.fn();
let mockIsOnline = true;
const mockInvalidateQueries = vi.fn();

vi.mock('../useOfflineQueue', () => ({
  useOfflineQueue: () => ({
    addToQueue: mockAddToQueue,
    isOnline: mockIsOnline,
    pendingCount: 0,
    pendingOperations: [],
    isSyncing: false,
    syncError: null,
    syncNow: vi.fn(),
    removeFromQueue: vi.fn(),
    refreshQueue: vi.fn(),
    clearError: vi.fn(),
    getSyncStatus: vi.fn().mockReturnValue('pending'),
  }),
}));

vi.mock('../useAuth', () => ({
  useAuth: () => ({
    tenantId: 'tenant-1',
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: mockInvalidateQueries,
    }),
  };
});

// Mock authenticated-fetch
const mockGraphqlRequest = vi.fn();

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

// Mock graphql/operations
vi.mock('@/graphql/operations', () => ({
  COMPLETE_TASK: 'mutation CompleteTask { ... }',
  START_TASK: 'mutation StartTask { ... }',
  TOGGLE_CHECKLIST_ITEM: 'mutation ToggleChecklistItem { ... }',
  ADD_TASK_NOTE: 'mutation AddTaskNote { ... }',
}));

// Import after mocks — useTaskActions uses plain useCallback hooks, no JSX rendering needed
import { useTaskActions } from '../useTaskActions';
import { renderHook } from '@testing-library/react';

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('useTaskActions — offline regression coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnline = true;
    // FE-HIGH-050: addToQueue now resolves a discriminated AddToQueueResult.
    mockAddToQueue.mockResolvedValue({ status: 'queued', id: 'op-queued-123' });
    mockInvalidateQueries.mockResolvedValue(undefined);
  });

  // ========================================================================
  // AQ-05: Offline task action returns wasQueued semantics
  // ========================================================================

  describe('Offline task action — wasQueued result (AQ-05)', () => {
    it('should return { wasQueued: true, operationId } when offline', async () => {
      mockIsOnline = false;

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.completeTask('task-123');

      expect(actionResult).toBeDefined();
      expect(actionResult.wasQueued).toBe(true);
      expect(actionResult.operationId).toBe('op-queued-123');
      expect(mockAddToQueue).toHaveBeenCalledWith('completeTask', { id: 'task-123' });
    });

    it('should return { wasQueued: true, operationId } for startTask when offline', async () => {
      mockIsOnline = false;

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.startTask('task-456');

      expect(actionResult).toBeDefined();
      expect(actionResult.wasQueued).toBe(true);
      expect(actionResult.operationId).toBe('op-queued-123');
      expect(mockAddToQueue).toHaveBeenCalledWith('startTask', { id: 'task-456' });
    });
  });

  // ========================================================================
  // AQ-05: Online task action returns confirmed result
  // ========================================================================

  describe('Online task action — confirmed result (AQ-05)', () => {
    it('should return { wasQueued: false } when online and server succeeds', async () => {
      mockIsOnline = true;
      mockGraphqlRequest.mockResolvedValue({
        completeTask: { id: 'task-123', status: 'COMPLETED', completedAt: '2026-04-13T00:00:00Z' },
      });

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.completeTask('task-123');

      expect(actionResult).toBeDefined();
      expect(actionResult.wasQueued).toBe(false);
      expect(actionResult.operationId).toBeUndefined();
      expect(mockGraphqlRequest).toHaveBeenCalled();
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 'tenant-1', 'myTasks'] });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 'tenant-1', 'taskStats'] });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 'tenant-1', 'dailyOpsCounts'] });
      expect(mockAddToQueue).not.toHaveBeenCalled();
    });

    it('should fall through to queue when online but network error occurs', async () => {
      mockIsOnline = true;
      mockGraphqlRequest.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.completeTask('task-789');

      // Should fall through to offline queue
      expect(actionResult).toBeDefined();
      expect(actionResult.wasQueued).toBe(true);
      expect(actionResult.operationId).toBe('op-queued-123');
      // graphqlRequest was called first (and failed), then addToQueue was called
      expect(mockGraphqlRequest).toHaveBeenCalled();
      expect(mockAddToQueue).toHaveBeenCalledWith('completeTask', { id: 'task-789' });
    });
  });

  // ========================================================================
  // AQ-05: Checklist toggle throws when offline
  // ========================================================================

  describe('Checklist toggle — no offline queue (AQ-05)', () => {
    it('should throw when offline because no OperationType exists for checklists', async () => {
      mockIsOnline = false;

      const { result } = renderHook(() => useTaskActions());

      await expect(
        result.current.toggleChecklistItem('task-123', 'item-1'),
      ).rejects.toThrow('Checklist toggle requires network connectivity');

      // addToQueue should NOT be called — there is no queue type for checklists
      expect(mockAddToQueue).not.toHaveBeenCalled();
    });

    it('should throw when online but network fails for checklist toggle', async () => {
      mockIsOnline = true;
      mockGraphqlRequest.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useTaskActions());

      await expect(
        result.current.toggleChecklistItem('task-123', 'item-1'),
      ).rejects.toThrow('Checklist toggle requires network connectivity');

      expect(mockAddToQueue).not.toHaveBeenCalled();
    });
  });
});
