/**
 * useTaskActions Hook Tests — Task Offline Regression Coverage
 *
 * AQ-05: Truthful queued-state UI (task actions return wasQueued semantics)
 * FARM-HIGH-057: every task mutation now carries the at-most-once command
 * envelope (clientCommandId + payloadHash) on BOTH the online and offline paths;
 * the checklist mutation SETs an absolute target (no flip) and queues offline.
 *
 * Tests:
 * - Online task action attaches the command envelope and returns { wasQueued: false }.
 * - Offline task action returns { wasQueued: true, operationId }.
 * - setChecklistItem sends the ABSOLUTE target and queues offline.
 * - The SAME clientCommandId is reused across an online-fail → offline-queue
 *   fallback so the server dedups the retry.
 */

import { renderHook } from '@testing-library/react';
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
const mockGraphqlRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

// Mock graphql/operations — the hook only needs opaque document handles here.
vi.mock('@/graphql/operations', () => ({
  COMPLETE_TASK: 'mutation CompleteTask { ... }',
  START_TASK: 'mutation StartTask { ... }',
  SET_CHECKLIST_ITEM: 'mutation SetChecklistItem { ... }',
  ADD_TASK_NOTE: 'mutation AddTaskNote { ... }',
}));

// FARM-HIGH-057: mock the offline queue's payload-hash helper deterministically.
// The hook reuses the REAL `computePayloadHash` so the online envelope and the
// offline replay agree; here a stub keeps the assertion deterministic without
// depending on a real SubtleCrypto digest in jsdom.
const mockComputePayloadHash = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@/pwa/offline-queue', () => ({
  computePayloadHash: (...args: unknown[]) => mockComputePayloadHash(...args),
}));

// FARM-HIGH-057: a deterministic clientCommandId so the online/offline dedup
// assertion can prove the SAME id is threaded through both paths.
const FIXED_COMMAND_ID = '11111111-1111-4111-8111-111111111111';
vi.stubGlobal('crypto', {
  ...globalThis.crypto,
  randomUUID: () => FIXED_COMMAND_ID,
});

// Import after mocks — useTaskActions uses plain useCallback hooks, no JSX rendering needed
import { useTaskActions } from '../useTaskActions';

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('useTaskActions — offline regression coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnline = true;
    // FE-HIGH-050: addToQueue resolves a discriminated AddToQueueResult.
    mockAddToQueue.mockResolvedValue({ status: 'queued', id: 'op-queued-123' });
    mockInvalidateQueries.mockResolvedValue(undefined);
    mockComputePayloadHash.mockResolvedValue('hash-deterministic');
  });

  // ========================================================================
  // FARM-HIGH-057: Online task action attaches the command envelope
  // ========================================================================

  describe('Online task action — confirmed result + command envelope (AQ-05, FARM-HIGH-057)', () => {
    it('completeTask attaches the envelope under input and returns { wasQueued: false }', async () => {
      mockIsOnline = true;
      mockGraphqlRequest.mockResolvedValue({
        completeTask: { id: 'task-123', status: 'COMPLETED', completedAt: '2026-04-13T00:00:00Z' },
      });

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.completeTask('task-123');

      expect(actionResult.wasQueued).toBe(false);
      expect(actionResult.operationId).toBeUndefined();
      // FARM-HIGH-057: the online call carries id + clientCommandId + payloadHash
      // wrapped in `input` (TaskLifecycleInput).
      expect(mockGraphqlRequest).toHaveBeenCalledWith(expect.anything(), {
        input: { id: 'task-123', clientCommandId: FIXED_COMMAND_ID, payloadHash: 'hash-deterministic' },
      });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 'tenant-1', 'myTasks'] });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 'tenant-1', 'taskStats'] });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 'tenant-1', 'dailyOpsCounts'] });
      expect(mockAddToQueue).not.toHaveBeenCalled();
    });

    it('startTask attaches the envelope under input and returns { wasQueued: false }', async () => {
      mockIsOnline = true;
      mockGraphqlRequest.mockResolvedValue({ startTask: { id: 'task-456', status: 'IN_PROGRESS' } });

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.startTask('task-456');

      expect(actionResult.wasQueued).toBe(false);
      expect(mockGraphqlRequest).toHaveBeenCalledWith(expect.anything(), {
        input: { id: 'task-456', clientCommandId: FIXED_COMMAND_ID, payloadHash: 'hash-deterministic' },
      });
      expect(mockAddToQueue).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // AQ-05: Offline task action returns wasQueued semantics
  // ========================================================================

  describe('Offline task action — wasQueued result (AQ-05)', () => {
    it('completeTask queues with the raw payload + threaded clientCommandId when offline', async () => {
      mockIsOnline = false;

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.completeTask('task-123');

      expect(actionResult.wasQueued).toBe(true);
      expect(actionResult.operationId).toBe('op-queued-123');
      // FARM-HIGH-057: queue receives the RAW domain payload (no envelope — the
      // queue stamps it) plus the stable clientCommandId as the 3rd argument.
      expect(mockAddToQueue).toHaveBeenCalledWith('completeTask', { id: 'task-123' }, FIXED_COMMAND_ID);
      expect(mockGraphqlRequest).not.toHaveBeenCalled();
    });

    it('startTask queues with the raw payload + threaded clientCommandId when offline', async () => {
      mockIsOnline = false;

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.startTask('task-456');

      expect(actionResult.wasQueued).toBe(true);
      expect(actionResult.operationId).toBe('op-queued-123');
      expect(mockAddToQueue).toHaveBeenCalledWith('startTask', { id: 'task-456' }, FIXED_COMMAND_ID);
    });
  });

  // ========================================================================
  // FARM-HIGH-057: online-fail → offline-queue reuses the SAME clientCommandId
  // ========================================================================

  describe('Online-fail fallback — stable clientCommandId for server dedup (FARM-HIGH-057)', () => {
    it('threads the SAME clientCommandId to the online attempt and the offline queue', async () => {
      mockIsOnline = true;
      mockGraphqlRequest.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.completeTask('task-789');

      // Fell through to the queue after the online attempt failed.
      expect(actionResult.wasQueued).toBe(true);
      expect(actionResult.operationId).toBe('op-queued-123');

      // The online attempt and the offline fallback carried the SAME command id.
      const onlineCallArgs = mockGraphqlRequest.mock.calls[0][1] as {
        input: { clientCommandId: string };
      };
      const queueCallArgs = mockAddToQueue.mock.calls[0];
      expect(onlineCallArgs.input.clientCommandId).toBe(FIXED_COMMAND_ID);
      expect(queueCallArgs).toEqual(['completeTask', { id: 'task-789' }, FIXED_COMMAND_ID]);
    });
  });

  // ========================================================================
  // FARM-HIGH-057: checklist SET (absolute target, queues offline)
  // ========================================================================

  describe('setChecklistItem — absolute target + offline queue (FARM-HIGH-057)', () => {
    it('sends the ABSOLUTE isCompleted with the envelope when online', async () => {
      mockIsOnline = true;
      mockGraphqlRequest.mockResolvedValue({
        setChecklistItem: { id: 'task-123', checklistItems: [] },
      });

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.setChecklistItem('task-123', 'item-1', true);

      expect(actionResult.wasQueued).toBe(false);
      expect(mockGraphqlRequest).toHaveBeenCalledWith(expect.anything(), {
        input: {
          taskId: 'task-123',
          itemId: 'item-1',
          isCompleted: true,
          clientCommandId: FIXED_COMMAND_ID,
          payloadHash: 'hash-deterministic',
        },
      });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 'tenant-1', 'myTasks'] });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['tenant', 'tenant-1', 'task'] });
    });

    it('queues the checklist SET offline with the raw absolute payload', async () => {
      mockIsOnline = false;

      const { result } = renderHook(() => useTaskActions());

      const actionResult = await result.current.setChecklistItem('task-123', 'item-1', false);

      expect(actionResult.wasQueued).toBe(true);
      expect(actionResult.operationId).toBe('op-queued-123');
      // FARM-HIGH-057: the checklist now has a real OperationType — it queues with
      // the absolute target instead of throwing "requires network".
      expect(mockAddToQueue).toHaveBeenCalledWith(
        'setChecklistItem',
        { taskId: 'task-123', itemId: 'item-1', isCompleted: false },
        FIXED_COMMAND_ID,
      );
    });
  });
});
