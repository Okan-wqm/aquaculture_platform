/**
 * useLeave Hook Tests — Offline Leave Regression Coverage
 *
 * AQ-01: Leave authoritative submit (contract-valid payload, dedup, no queue UUID as domain ID)
 * AQ-02: Leave readback convergence (React Query invalidation, refetchOnMount)
 *
 * Tests:
 * - Leave mutation invalidates leaveRequests and leaveBalances query keys
 * - Offline leave queues with contract-valid payload (server-resolved employee, totalDays, command envelope)
 * - Dedup fingerprint prevents duplicate leave requests (same leaveTypeId+startDate+endDate)
 */

import { webcrypto } from 'node:crypto';

import { renderHook } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

// idb-keyval mock for offline-queue tests
const idbStorage = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn((key: string) => Promise.resolve(idbStorage.get(key))),
  set: vi.fn((key: string, value: unknown) => {
    idbStorage.set(key, value);
    return Promise.resolve();
  }),
  del: vi.fn((key: string) => {
    idbStorage.delete(key);
    return Promise.resolve();
  }),
  keys: vi.fn(() => Promise.resolve(Array.from(idbStorage.keys()))),
  entries: vi.fn(() => Promise.resolve(Array.from(idbStorage.entries()))),
  createStore: vi.fn(() => 'mock-store'),
}));

// Mock crypto
Object.defineProperty(globalThis, 'crypto', {
  value: {
    subtle: {
      generateKey: vi.fn().mockResolvedValue({ type: 'secret', algorithm: 'AES-GCM' }),
      // Real SHA-256 via Node's WebCrypto. FE-HIGH-050 keys offline dedup off
      // the payload fingerprint, so a fake digest would mask hash collisions and
      // produce false dedup matches between distinct payloads — exactly the bug
      // the "different leave types" / "different date ranges" cases must catch.
      digest: (algorithm: AlgorithmIdentifier, data: BufferSource) =>
        webcrypto.subtle.digest(algorithm, data as Parameters<typeof webcrypto.subtle.digest>[1]),
      encrypt: vi.fn((_algo: unknown, _key: unknown, data: ArrayBuffer) =>
        Promise.resolve(new Uint8Array(data).buffer),
      ),
      decrypt: vi.fn((_algo: unknown, _key: unknown, data: ArrayBuffer) =>
        Promise.resolve(new Uint8Array(data).buffer),
      ),
    },
    randomUUID: () => `uuid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    },
  },
  configurable: true,
});

// Mock navigator.serviceWorker
Object.defineProperty(globalThis, 'navigator', {
  value: {
    ...globalThis.navigator,
    onLine: true,
    serviceWorker: {
      ready: Promise.resolve({
        sync: { register: vi.fn() },
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  },
  configurable: true,
  writable: true,
});

// --------------------------------------------------------------------------
// AQ-02: Mock @tanstack/react-query to capture mutation onSuccess callbacks.
//
// WHY: The monorepo has duplicated React instances (root vs local node_modules)
// which breaks renderHook with QueryClientProvider. By mocking react-query, we
// intercept the useMutation call to capture its onSuccess handler, then invoke
// it directly to verify that invalidateQueries is called with the correct keys.
// --------------------------------------------------------------------------

interface MutationConfig {
  mutationFn: (id: string) => Promise<void>;
  onSuccess?: () => void;
}

const mockInvalidateQueries = vi.fn();
const capturedMutationConfigs: MutationConfig[] = [];

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
  }),
  useMutation: (config: MutationConfig) => {
    capturedMutationConfigs.push(config);
    return {
      mutateAsync: vi.fn().mockImplementation(async (id: string) => {
        await config.mutationFn(id);
        config.onSuccess?.();
      }),
      isPending: false,
    };
  },
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    error: null,
  }),
}));

// Mock authenticated-fetch
// SSoT: typed mock signature (matches the other hook specs) so the mocked
// graphqlRequest returns Promise<unknown> instead of `any` (no-unsafe-return).
const mockGraphqlRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

// Mock graphql/operations
vi.mock('@/graphql/operations', () => ({
  GET_MY_LEAVE_REQUESTS: 'query GetMyLeaveRequests { ... }',
  GET_MY_LEAVE_BALANCES: 'query GetMyLeaveBalances { ... }',
  GET_LEAVE_TYPES: 'query GetLeaveTypes { ... }',
  SUBMIT_LEAVE_REQUEST: 'mutation SubmitLeaveRequest { ... }',
  CANCEL_LEAVE_REQUEST: 'mutation CancelLeaveRequest { ... }',
}));

// Mock useAuth
vi.mock('../useAuth', () => ({
  useAuth: () => ({
    accessToken: 'test-token',
    isAuthenticated: true,
    tenantId: 'tenant-1',
    user: { id: 'user-1', employeeId: 'emp-001' },
  }),
}));

// Import after mocks
import { useSubmitLeaveRequest, useCancelLeaveRequest } from '../useLeave';

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('useLeave — offline regression coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idbStorage.clear();
    capturedMutationConfigs.length = 0;
    mockGraphqlRequest.mockResolvedValue({ submitLeaveRequest: { id: 'lr-1', status: 'PENDING' } });
  });

  // ========================================================================
  // AQ-02: Leave mutation cache invalidation
  // ========================================================================

  describe('Leave mutation cache invalidation (AQ-02)', () => {
    it('useSubmitLeaveRequest onSuccess should invalidate leaveRequests and leaveBalances', () => {
      // renderHook provides React fiber context for useCallback inside the hook.
      // No wrapper/provider needed because @tanstack/react-query is fully mocked.
      const { result } = renderHook(() => useSubmitLeaveRequest());

      // The hook should return submit and loading
      expect(result.current.submit).toBeDefined();
      expect(typeof result.current.submit).toBe('function');

      // Find the mutation config captured by our mock
      expect(capturedMutationConfigs.length).toBeGreaterThanOrEqual(1);

      // Trigger the onSuccess handler directly to test invalidation behavior
      const submitConfig = capturedMutationConfigs[capturedMutationConfigs.length - 1];
      submitConfig.onSuccess?.();

      // Verify both query key families are invalidated
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ['tenant', 'tenant-1', 'leaveRequests'],
      });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ['tenant', 'tenant-1', 'leaveBalances'],
      });
    });

    it('useCancelLeaveRequest onSuccess should invalidate leaveRequests and leaveBalances', () => {
      mockInvalidateQueries.mockClear();
      capturedMutationConfigs.length = 0;

      const { result } = renderHook(() => useCancelLeaveRequest());

      expect(result.current.cancel).toBeDefined();
      expect(typeof result.current.cancel).toBe('function');

      // The cancel hook registers its own useMutation call
      expect(capturedMutationConfigs.length).toBeGreaterThanOrEqual(1);

      const cancelConfig = capturedMutationConfigs[capturedMutationConfigs.length - 1];
      cancelConfig.onSuccess?.();

      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ['tenant', 'tenant-1', 'leaveRequests'],
      });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ['tenant', 'tenant-1', 'leaveBalances'],
      });
    });
  });

  // ========================================================================
  // AQ-01: Offline leave queues with contract-valid payload
  // ========================================================================

  describe('Offline leave queue payload contract (AQ-01)', () => {
    it('should include all required CreateLeaveRequestInput fields and command envelope in queued payload', async () => {
      // Directly test the offline-queue module to verify payload integrity
      const { queueOperation, getOperation } = await import('@/pwa/offline-queue');

      const payload = {
        leaveTypeId: 'lt-annual',
        startDate: '2026-04-20',
        endDate: '2026-04-22',
        totalDays: 3,
        isHalfDayStart: false,
        isHalfDayEnd: false,
        reason: 'Family event',
      };

      // FE-HIGH-050: queueOperation returns a discriminated AddToQueueResult.
      const result = await queueOperation('tenant-1', 'createLeaveRequest', payload);
      expect(result.status).toBe('queued');
      const id = result.id;
      const op = await getOperation('tenant-1', id);

      expect(op).toBeDefined();
      if (!op) throw new Error('expected queued operation to be defined');
      expect(op.type).toBe('createLeaveRequest');
      // Verify the decrypted payload has the required fields
      const p = op.payload as {
        employeeId?: unknown;
        totalDays?: number;
        leaveTypeId?: string;
        startDate?: string;
        endDate?: string;
        clientCommandId?: string;
        clientCreatedAt?: unknown;
        deviceId?: unknown;
        operationType?: string;
        payloadHash?: unknown;
        schemaVersion?: string;
      };
      expect(p.employeeId).toBeUndefined();
      expect(p.totalDays).toBe(3);
      expect(p.leaveTypeId).toBe('lt-annual');
      expect(p.startDate).toBe('2026-04-20');
      expect(p.endDate).toBe('2026-04-22');
      expect(p.clientCommandId).toBe(id);
      expect(typeof p.clientCreatedAt).toBe('string');
      expect(typeof p.deviceId).toBe('string');
      expect(p.operationType).toBe('createLeaveRequest');
      expect(typeof p.payloadHash).toBe('string');
      expect(p.schemaVersion).toBe('mobile-command-v1');
    });
  });

  // ========================================================================
  // AQ-01: Dedup fingerprint prevents duplicate leave requests
  // ========================================================================

  describe('Leave dedup fingerprint (AQ-01, FE-HIGH-050 payloadHash)', () => {
    it('should dedup an identical createLeaveRequest within the window (status duplicate)', async () => {
      const { queueOperation } = await import('@/pwa/offline-queue');

      const payload = {
        leaveTypeId: 'lt-annual',
        startDate: '2026-04-20',
        endDate: '2026-04-22',
        totalDays: 3,
      };

      // First submission writes a fresh op.
      const r1 = await queueOperation('tenant-1', 'createLeaveRequest', payload);
      expect(r1.status).toBe('queued');
      expect(r1.id.length).toBeGreaterThan(0);

      // FE-HIGH-050: a byte-identical re-submit within the window is collapsed
      // onto the existing op — status 'duplicate', id pointing at the first op.
      const r2 = await queueOperation('tenant-1', 'createLeaveRequest', payload);
      expect(r2.status).toBe('duplicate');
      expect(r2.id).toBe(r1.id);
    });

    it('should NOT dedup leave requests with different date ranges', async () => {
      const { queueOperation } = await import('@/pwa/offline-queue');

      const payload1 = {
        leaveTypeId: 'lt-annual',
        startDate: '2026-04-20',
        endDate: '2026-04-22',
        totalDays: 3,
      };

      const payload2 = {
        leaveTypeId: 'lt-annual',
        startDate: '2026-05-01',
        endDate: '2026-05-03',
        totalDays: 3,
      };

      const r1 = await queueOperation('tenant-1', 'createLeaveRequest', payload1);
      const r2 = await queueOperation('tenant-1', 'createLeaveRequest', payload2);

      // Both write fresh ops — different date ranges hash differently.
      expect(r1.status).toBe('queued');
      expect(r2.status).toBe('queued');
      expect(r2.id).not.toBe(r1.id);
    });

    it('should NOT dedup leave requests with different leave types', async () => {
      const { queueOperation } = await import('@/pwa/offline-queue');

      const payload1 = {
        leaveTypeId: 'lt-annual',
        startDate: '2026-04-20',
        endDate: '2026-04-22',
        totalDays: 3,
      };

      const payload2 = {
        leaveTypeId: 'lt-sick',
        startDate: '2026-04-20',
        endDate: '2026-04-22',
        totalDays: 3,
      };

      const r1 = await queueOperation('tenant-1', 'createLeaveRequest', payload1);
      const r2 = await queueOperation('tenant-1', 'createLeaveRequest', payload2);

      // Both write fresh ops — different leave types hash differently.
      expect(r1.status).toBe('queued');
      expect(r2.status).toBe('queued');
      expect(r2.id).not.toBe(r1.id);
    });
  });
});
