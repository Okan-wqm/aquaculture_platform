/**
 * useMobilePermissions Hook Tests
 *
 * D07 RBAC-01: Fail-closed defaults
 * SEC-04: Per-user cache with 8-hour TTL
 * Tests:
 * - Default settings: all false (Wave 4)
 * - Load permissions from backend
 * - Load from cache (8h TTL)
 * - Network error -> fail-closed (default false)
 * - canAccess: feature-based control
 */

import { renderHook, waitFor } from '@testing-library/react';
import { set } from 'idb-keyval';
import { createElement, type ReactNode } from 'react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

// idb-keyval mock
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
}));

// Mock fetch — typed signature so recorded calls (mockFetch.mock.calls) are
// typed [string, RequestInit?] rather than any[]; this lets the header
// assertions read call args without an unsafe `any` matcher. vi.stubGlobal
// installs it as the global fetch (auto-restored by vi.unstubAllGlobals /
// restoreAllMocks) and accepts the mock without a cast.
const mockFetch = vi.fn<(input: string, init?: RequestInit) => Promise<unknown>>();
vi.stubGlobal('fetch', mockFetch);

// Mock useAuth
const mockAuth: Record<string, unknown> = {
  accessToken: 'test-token',
  isAuthenticated: true,
  isLoading: false,
  user: {
    id: 'user-1',
    email: 'test@test.com',
    name: 'Test User',
    role: 'MODULE_USER' as const,
    tenantId: 'tenant-1',
  },
  // WHY: useMobilePermissions destructures tenantId from useAuth() at the top level
  // (not from user.tenantId). Without this, getCacheKey() generates a non-tenant-scoped
  // key (mobile_permissions_user-1 instead of mobile_permissions_tenant-1_user-1).
  tenantId: 'tenant-1',
};

vi.mock('../useAuth', () => ({
  useAuth: () => mockAuth,
}));

// D07 API-01: authenticatedFetch reads tokens from the module-level auth store.
// We must keep it in sync with mockAuth so that authenticatedFetch injects the
// correct Authorization header. This is done in beforeEach below.

// Import after mocks (vitest hoists vi.mock() above all imports, so the mocked
// forms resolve regardless of import position)
import { MobilePermissionsProvider, useMobilePermissions } from '../useMobilePermissions';
import type { MobileFeature } from '../useMobilePermissions';

import { syncAuthStore } from '@/services/authenticated-fetch';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createWrapper() {
  return ({ children }: { children: ReactNode }) =>
    createElement(MobilePermissionsProvider, null, children);
}

interface MockGraphQLResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function createSuccessResponse(settings: Record<string, unknown>): MockGraphQLResponse {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        data: { getMyMobileSettings: settings },
      }),
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('useMobilePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idbStorage.clear();
    mockAuth.accessToken = 'test-token';
    mockAuth.isAuthenticated = true;
    mockAuth.isLoading = false;
    mockAuth.tenantId = 'tenant-1';
    mockAuth.user = {
      id: 'user-1',
      email: 'test@test.com',
      name: 'Test User',
      role: 'MODULE_USER' as const,
      tenantId: 'tenant-1',
    };
    // D07 API-01: Sync the module-level auth store so authenticatedFetch
    // injects the correct Authorization / X-Tenant-Id headers.
    syncAuthStore('test-token', 'tenant-1', () => Promise.resolve(true));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========================================================================
  // Default settings: all false (D07 RBAC-01)
  // ========================================================================

  describe('Default Settings (Fail-Closed)', () => {
    it('should have isMobileEnabled = false by default', async () => {
      mockAuth.isAuthenticated = false;
      mockAuth.accessToken = null;
      mockAuth.user = null;

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.isMobileEnabled).toBe(false);
    });

    it('should have all feature permissions false by default', async () => {
      mockAuth.isAuthenticated = false;
      mockAuth.accessToken = null;
      mockAuth.user = null;

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      const features: MobileFeature[] = [
        'mortality',
        'cull',
        'harvest',
        'feeding',
        'waterQuality',
        'tankView',
        'schedule',
        'attendance',
        'leave',
        'tasks',
        'transfer',
      ];

      for (const feature of features) {
        expect(result.current.canAccess(feature)).toBe(false);
      }
    });

    it('should reset to defaults when user logs out', async () => {
      // First render with auth
      mockFetch.mockResolvedValue(
        createSuccessResponse({
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: true,
            harvest: false,
            feeding: false,
            waterQuality: false,
            tankView: false,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: false,
            transfer: false,
          },
        }),
      );

      const { result, rerender } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Now simulate logout
      mockAuth.isAuthenticated = false;
      mockAuth.accessToken = null;
      mockAuth.user = null;

      rerender();

      await waitFor(() => {
        expect(result.current.isMobileEnabled).toBe(false);
      });
    });
  });

  // ========================================================================
  // Load permissions from backend
  // ========================================================================

  describe('Backend Permission Loading', () => {
    it('should fetch permissions from /graphql on mount', async () => {
      mockFetch.mockResolvedValue(
        createSuccessResponse({
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: false,
            harvest: true,
            feeding: true,
            waterQuality: false,
            tankView: true,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: true,
            transfer: false,
          },
        }),
      );

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Read the typed recorded call rather than nesting an `any` objectContaining
      // matcher as an object-literal property (which would be a no-unsafe-assignment).
      const graphqlCall = mockFetch.mock.calls.find(([url]) => url === '/graphql');
      expect(graphqlCall).toBeDefined();
      const init = graphqlCall?.[1];
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe('Bearer test-token');
    });

    it('should update settings from backend response', async () => {
      mockFetch.mockResolvedValue(
        createSuccessResponse({
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: false,
            harvest: true,
            feeding: true,
            waterQuality: false,
            tankView: true,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: true,
            transfer: false,
          },
        }),
      );

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.isMobileEnabled).toBe(true);
      expect(result.current.canAccess('mortality')).toBe(true);
      expect(result.current.canAccess('cull')).toBe(false);
      expect(result.current.canAccess('harvest')).toBe(true);
      expect(result.current.canAccess('tasks')).toBe(true);
    });

    it('should cache permissions to IndexedDB with per-user key (SEC-04)', async () => {
      mockFetch.mockResolvedValue(
        createSuccessResponse({
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: false,
            harvest: false,
            feeding: false,
            waterQuality: false,
            tankView: false,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: false,
            transfer: false,
          },
        }),
      );

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Should have cached under per-user key. Read the typed recorded call rather
      // than nesting `any` matchers as object-literal properties (no-unsafe-assignment).
      const setMock = vi.mocked(set);
      const cacheCall = setMock.mock.calls.find(
        ([key]) => key === 'mobile_permissions_tenant-1_user-1',
      );
      expect(cacheCall).toBeDefined();
      const cached = cacheCall?.[1] as
        | { settings?: { isMobileEnabled?: boolean }; expiresAt?: number }
        | undefined;
      expect(cached?.settings?.isMobileEnabled).toBe(true);
      expect(typeof cached?.expiresAt).toBe('number');
    });

    it('should handle 401 response by setting defaults', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
      });

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.isMobileEnabled).toBe(false);
    });
  });

  // ========================================================================
  // Cache reading (8-hour TTL)
  // ========================================================================

  describe('Cache Reading (8h TTL)', () => {
    it('should load permissions from cache when available', async () => {
      // Pre-populate cache with valid entry (not expired)
      const cachedSettings = {
        settings: {
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: true,
            harvest: false,
            feeding: false,
            waterQuality: false,
            tankView: false,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: false,
            transfer: false,
          },
        },
        expiresAt: Date.now() + 4 * 60 * 60 * 1000, // 4 hours from now
      };
      idbStorage.set('mobile_permissions_tenant-1_user-1', cachedSettings);

      // Make fetch hang to verify cache is used first
      mockFetch.mockReturnValue(new Promise<never>(() => undefined));

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.isMobileEnabled).toBe(true);
      expect(result.current.canAccess('mortality')).toBe(true);
      expect(result.current.canAccess('cull')).toBe(true);
    });

    it('should not use expired cache entries', async () => {
      // Expired cache
      const expiredSettings = {
        settings: {
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: true,
            harvest: true,
            feeding: true,
            waterQuality: true,
            tankView: true,
            schedule: true,
            attendance: true,
            leave: true,
            tasks: true,
            transfer: true,
          },
        },
        expiresAt: Date.now() - 1000, // expired 1 second ago
      };
      idbStorage.set('mobile_permissions_tenant-1_user-1', expiredSettings);

      // Backend returns restricted permissions
      mockFetch.mockResolvedValue(
        createSuccessResponse({
          isMobileEnabled: false,
          allowedFeatures: {
            mortality: false,
            cull: false,
            harvest: false,
            feeding: false,
            waterQuality: false,
            tankView: false,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: false,
            transfer: false,
          },
        }),
      );

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Should use backend result, not expired cache
      expect(result.current.isMobileEnabled).toBe(false);
    });

    it('should cache with 8-hour TTL', async () => {
      mockFetch.mockResolvedValue(
        createSuccessResponse({
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: false,
            harvest: false,
            feeding: false,
            waterQuality: false,
            tankView: false,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: false,
            transfer: false,
          },
        }),
      );

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Check cached expiresAt is approximately 8 hours from now
      expect(set).toHaveBeenCalledWith(
        'mobile_permissions_tenant-1_user-1',
        expect.objectContaining({
          expiresAt: now + 8 * 60 * 60 * 1000,
        }),
      );

      vi.spyOn(Date, 'now').mockRestore();
    });
  });

  // ========================================================================
  // Network error -> fail-closed (default false)
  // ========================================================================

  describe('Network Error (Fail-Closed)', () => {
    it('should fall back to cache on network error', async () => {
      // Valid cache exists — tenant-scoped key
      idbStorage.set('mobile_permissions_tenant-1_user-1', {
        settings: {
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: false,
            harvest: false,
            feeding: false,
            waterQuality: false,
            tankView: false,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: false,
            transfer: false,
          },
        },
        expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      });

      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Should use cached permissions (not degraded because cache is valid)
      expect(result.current.isMobileEnabled).toBe(true);
      expect(result.current.canAccess('mortality')).toBe(true);
      expect(result.current.permissionsDegraded).toBe(false);
      expect(result.current.permissionSource).toBe('cache');
    });

    it('should use fail-closed fallback when no cache and network error (MEDIUM-004)', async () => {
      // No cache exists
      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // SECURITY: fail-closed — when authenticated but settings endpoint is
      // unreachable AND no cache exists, deny all features. Granting access
      // by default is a privilege escalation vector (MEDIUM-004).
      expect(result.current.isMobileEnabled).toBe(false);
      expect(result.current.canAccess('mortality')).toBe(false);
      expect(result.current.canAccess('attendance')).toBe(false);
      expect(result.current.canAccess('leave')).toBe(false);
      expect(result.current.canAccess('tasks')).toBe(false);
      expect(result.current.permissionsDegraded).toBe(true);
      expect(result.current.permissionSource).toBe('fail-closed');
    });
  });

  // ========================================================================
  // canAccess: Feature-based control
  // ========================================================================

  describe('canAccess (Feature-Based Control)', () => {
    it('should return true for allowed features when mobile is enabled', async () => {
      mockFetch.mockResolvedValue(
        createSuccessResponse({
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: false,
            harvest: true,
            feeding: false,
            waterQuality: false,
            tankView: true,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: false,
            transfer: false,
          },
        }),
      );

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.canAccess('mortality')).toBe(true);
      expect(result.current.canAccess('harvest')).toBe(true);
      expect(result.current.canAccess('tankView')).toBe(true);
      expect(result.current.canAccess('cull')).toBe(false);
      expect(result.current.canAccess('feeding')).toBe(false);
    });

    it('should return false for all features when mobile is disabled', async () => {
      mockFetch.mockResolvedValue(
        createSuccessResponse({
          isMobileEnabled: false,
          allowedFeatures: {
            mortality: true,
            cull: true,
            harvest: true,
            feeding: true,
            waterQuality: true,
            tankView: true,
            schedule: true,
            attendance: true,
            leave: true,
            tasks: true,
            transfer: true,
          },
        }),
      );

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Even though all features are "true", isMobileEnabled is false
      expect(result.current.canAccess('mortality')).toBe(false);
      expect(result.current.canAccess('tasks')).toBe(false);
    });

    it('should return false for unknown feature key', async () => {
      mockFetch.mockResolvedValue(
        createSuccessResponse({
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: false,
            harvest: false,
            feeding: false,
            waterQuality: false,
            tankView: false,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: false,
            transfer: false,
          },
        }),
      );

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Unknown feature should return false
      expect(result.current.canAccess('unknownFeature' as MobileFeature)).toBe(false);
    });
  });

  // ========================================================================
  // Error: must be used within Provider
  // ========================================================================

  describe('Provider Requirement', () => {
    it('should throw when used without MobilePermissionsProvider', () => {
      // Suppress console.error for expected error
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(() => {
        renderHook(() => useMobilePermissions());
      }).toThrow('useMobilePermissions must be used within MobilePermissionsProvider');

      spy.mockRestore();
    });
  });

  // ========================================================================
  // AQ-06: Fail-closed regression — network failure + no cache
  // ========================================================================

  describe('Fail-closed regression (AQ-06)', () => {
    it('should deny all features when network fails and NO cache exists', async () => {
      // No cache — idbStorage is empty
      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // SECURITY: fail-closed — all features denied
      expect(result.current.isMobileEnabled).toBe(false);
      expect(result.current.permissionSource).toBe('fail-closed');
      expect(result.current.permissionsDegraded).toBe(true);

      const allFeatures: MobileFeature[] = [
        'mortality',
        'cull',
        'harvest',
        'feeding',
        'waterQuality',
        'tankView',
        'schedule',
        'attendance',
        'leave',
        'tasks',
        'transfer',
        'storage',
      ];
      for (const feature of allFeatures) {
        expect(result.current.canAccess(feature)).toBe(false);
      }
    });

    it('should use stale cache and show degraded when network fails WITH stale cache', async () => {
      // Pre-populate stale cache (expired TTL)
      idbStorage.set('mobile_permissions_tenant-1_user-1', {
        settings: {
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: false,
            harvest: false,
            feeding: false,
            waterQuality: false,
            tankView: false,
            schedule: false,
            attendance: false,
            leave: true,
            tasks: true,
            transfer: false,
            storage: false,
          },
        },
        expiresAt: Date.now() - 1000, // expired 1 second ago
      });

      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Should use stale cache — features from cache are available
      expect(result.current.isMobileEnabled).toBe(true);
      expect(result.current.canAccess('mortality')).toBe(true);
      expect(result.current.canAccess('leave')).toBe(true);
      expect(result.current.canAccess('tasks')).toBe(true);
      expect(result.current.canAccess('cull')).toBe(false);

      // Should show degraded mode because cache is stale
      expect(result.current.permissionsDegraded).toBe(true);
      expect(result.current.permissionSource).toBe('stale-cache');
    });
  });

  // ========================================================================
  // AQ-06: Tenant-scoped cache key — switching tenant clears previous
  // ========================================================================

  describe('Tenant-scoped cache key (AQ-06)', () => {
    it('should use tenant-specific cache key (tenant-1 vs tenant-2)', async () => {
      // Pre-populate cache for tenant-1
      idbStorage.set('mobile_permissions_tenant-1_user-1', {
        settings: {
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: true,
            harvest: false,
            feeding: false,
            waterQuality: false,
            tankView: false,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: false,
            transfer: false,
            storage: false,
          },
        },
        expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      });

      // Make fetch hang to verify cache is used
      mockFetch.mockReturnValue(new Promise<never>(() => undefined));

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Should use tenant-1 cache
      expect(result.current.isMobileEnabled).toBe(true);
      expect(result.current.canAccess('mortality')).toBe(true);
    });

    it('should NOT read tenant-1 cache when user is on tenant-2', async () => {
      // Cache for tenant-1 exists
      idbStorage.set('mobile_permissions_tenant-1_user-1', {
        settings: {
          isMobileEnabled: true,
          allowedFeatures: {
            mortality: true,
            cull: true,
            harvest: true,
            feeding: true,
            waterQuality: true,
            tankView: true,
            schedule: true,
            attendance: true,
            leave: true,
            tasks: true,
            transfer: true,
            storage: true,
          },
        },
        expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      });

      // No cache for tenant-2
      // Switch to tenant-2
      mockAuth.user = {
        id: 'user-1',
        email: 'test@test.com',
        name: 'Test User',
        role: 'MODULE_USER' as const,
        tenantId: 'tenant-2',
      };
      mockAuth.tenantId = 'tenant-2';

      // Backend returns restricted permissions for tenant-2
      mockFetch.mockResolvedValue(
        createSuccessResponse({
          isMobileEnabled: false,
          allowedFeatures: {
            mortality: false,
            cull: false,
            harvest: false,
            feeding: false,
            waterQuality: false,
            tankView: false,
            schedule: false,
            attendance: false,
            leave: false,
            tasks: false,
            transfer: false,
            storage: false,
          },
        }),
      );

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Should NOT inherit tenant-1's cached permissions
      expect(result.current.isMobileEnabled).toBe(false);
      expect(result.current.canAccess('mortality')).toBe(false);
    });
  });
});
