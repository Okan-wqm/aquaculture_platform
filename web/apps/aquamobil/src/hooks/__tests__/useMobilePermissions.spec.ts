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

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

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

// Mock fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock useAuth
const mockAuth = {
  accessToken: 'test-token',
  isAuthenticated: true,
  isLoading: false,
  user: { id: 'user-1', email: 'test@test.com', name: 'Test User', role: 'OPERATOR' as const, tenantId: 'tenant-1' },
};

vi.mock('../useAuth', () => ({
  useAuth: () => mockAuth,
}));

// D07 API-01: authenticatedFetch reads tokens from the module-level auth store.
// We must keep it in sync with mockAuth so that authenticatedFetch injects the
// correct Authorization header. This is done in beforeEach below.

// Import after mocks
import { MobilePermissionsProvider, useMobilePermissions } from '../useMobilePermissions';
import type { MobileFeature } from '../useMobilePermissions';
import { get, set } from 'idb-keyval';
import { syncAuthStore } from '@/services/authenticated-fetch';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createWrapper() {
  return ({ children }: { children: ReactNode }) =>
    createElement(MobilePermissionsProvider, null, children);
}

function createSuccessResponse(settings: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
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
    mockAuth.user = {
      id: 'user-1',
      email: 'test@test.com',
      name: 'Test User',
      role: 'OPERATOR' as const,
      tenantId: 'tenant-1',
    };
    // D07 API-01: Sync the module-level auth store so authenticatedFetch
    // injects the correct Authorization / X-Tenant-Id headers.
    syncAuthStore('test-token', 'tenant-1', async () => true);
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
      mockAuth.accessToken = null as unknown as string;
      mockAuth.user = null as unknown as typeof mockAuth.user;

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.isMobileEnabled).toBe(false);
    });

    it('should have all feature permissions false by default', async () => {
      mockAuth.isAuthenticated = false;
      mockAuth.accessToken = null as unknown as string;
      mockAuth.user = null as unknown as typeof mockAuth.user;

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      const features: MobileFeature[] = [
        'mortality', 'cull', 'harvest', 'feeding', 'waterQuality',
        'tankView', 'schedule', 'attendance', 'leave', 'tasks', 'transfer',
      ];

      for (const feature of features) {
        expect(result.current.canAccess(feature)).toBe(false);
      }
    });

    it('should reset to defaults when user logs out', async () => {
      // First render with auth
      mockFetch.mockResolvedValue(createSuccessResponse({
        isMobileEnabled: true,
        allowedFeatures: { mortality: true, cull: true, harvest: false, feeding: false, waterQuality: false, tankView: false, schedule: false, attendance: false, leave: false, tasks: false, transfer: false },
      }));

      const { result, rerender } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Now simulate logout
      mockAuth.isAuthenticated = false;
      mockAuth.accessToken = null as unknown as string;
      mockAuth.user = null as unknown as typeof mockAuth.user;

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
      mockFetch.mockResolvedValue(createSuccessResponse({
        isMobileEnabled: true,
        allowedFeatures: {
          mortality: true, cull: false, harvest: true, feeding: true,
          waterQuality: false, tankView: true, schedule: false,
          attendance: false, leave: false, tasks: true, transfer: false,
        },
      }));

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(mockFetch).toHaveBeenCalledWith('/graphql', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }));
    });

    it('should update settings from backend response', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse({
        isMobileEnabled: true,
        allowedFeatures: {
          mortality: true, cull: false, harvest: true, feeding: true,
          waterQuality: false, tankView: true, schedule: false,
          attendance: false, leave: false, tasks: true, transfer: false,
        },
      }));

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
      mockFetch.mockResolvedValue(createSuccessResponse({
        isMobileEnabled: true,
        allowedFeatures: {
          mortality: true, cull: false, harvest: false, feeding: false,
          waterQuality: false, tankView: false, schedule: false,
          attendance: false, leave: false, tasks: false, transfer: false,
        },
      }));

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Should have cached under per-user key
      expect(set).toHaveBeenCalledWith(
        'mobile_permissions_tenant-1_user-1',
        expect.objectContaining({
          settings: expect.objectContaining({ isMobileEnabled: true }),
          expiresAt: expect.any(Number),
        }),
      );
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
            mortality: true, cull: true, harvest: false, feeding: false,
            waterQuality: false, tankView: false, schedule: false,
            attendance: false, leave: false, tasks: false, transfer: false,
          },
        },
        expiresAt: Date.now() + 4 * 60 * 60 * 1000, // 4 hours from now
      };
      idbStorage.set('mobile_permissions_tenant-1_user-1', cachedSettings);

      // Make fetch hang to verify cache is used first
      mockFetch.mockReturnValue(new Promise(() => {}));

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
            mortality: true, cull: true, harvest: true, feeding: true,
            waterQuality: true, tankView: true, schedule: true,
            attendance: true, leave: true, tasks: true, transfer: true,
          },
        },
        expiresAt: Date.now() - 1000, // expired 1 second ago
      };
      idbStorage.set('mobile_permissions_tenant-1_user-1', expiredSettings);

      // Backend returns restricted permissions
      mockFetch.mockResolvedValue(createSuccessResponse({
        isMobileEnabled: false,
        allowedFeatures: {
          mortality: false, cull: false, harvest: false, feeding: false,
          waterQuality: false, tankView: false, schedule: false,
          attendance: false, leave: false, tasks: false, transfer: false,
        },
      }));

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Should use backend result, not expired cache
      expect(result.current.isMobileEnabled).toBe(false);
    });

    it('should cache with 8-hour TTL', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse({
        isMobileEnabled: true,
        allowedFeatures: {
          mortality: true, cull: false, harvest: false, feeding: false,
          waterQuality: false, tankView: false, schedule: false,
          attendance: false, leave: false, tasks: false, transfer: false,
        },
      }));

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
            mortality: true, cull: false, harvest: false, feeding: false,
            waterQuality: false, tankView: false, schedule: false,
            attendance: false, leave: false, tasks: false, transfer: false,
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
      mockFetch.mockResolvedValue(createSuccessResponse({
        isMobileEnabled: true,
        allowedFeatures: {
          mortality: true, cull: false, harvest: true, feeding: false,
          waterQuality: false, tankView: true, schedule: false,
          attendance: false, leave: false, tasks: false, transfer: false,
        },
      }));

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
      mockFetch.mockResolvedValue(createSuccessResponse({
        isMobileEnabled: false,
        allowedFeatures: {
          mortality: true, cull: true, harvest: true, feeding: true,
          waterQuality: true, tankView: true, schedule: true,
          attendance: true, leave: true, tasks: true, transfer: true,
        },
      }));

      const { result } = renderHook(() => useMobilePermissions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      // Even though all features are "true", isMobileEnabled is false
      expect(result.current.canAccess('mortality')).toBe(false);
      expect(result.current.canAccess('tasks')).toBe(false);
    });

    it('should return false for unknown feature key', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse({
        isMobileEnabled: true,
        allowedFeatures: {
          mortality: true, cull: false, harvest: false, feeding: false,
          waterQuality: false, tankView: false, schedule: false,
          attendance: false, leave: false, tasks: false, transfer: false,
        },
      }));

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
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useMobilePermissions());
      }).toThrow('useMobilePermissions must be used within MobilePermissionsProvider');

      spy.mockRestore();
    });
  });
});
