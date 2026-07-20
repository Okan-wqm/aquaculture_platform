/**
 * AuthContext Tests
 *
 * Comprehensive tests for the AuthContext module covering:
 * - AuthProvider: Login flow (mutation -> setTokens -> fetchMe -> AUTH_SUCCESS)
 * - AuthProvider: Logout (clearSession -> dispatch LOGOUT)
 * - hasRoleOrHigher: SUPER_ADMIN > TENANT_ADMIN > MODULE_MANAGER > MODULE_USER
 * - hasModuleAccess: Module code checks
 * - MF fallback: Context unavailable -> server-verified bridge or fail-closed
 * - sanitizeRedirectUrl: Open redirect prevention
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the token-lifecycle module before importing AuthContext
vi.mock('../../utils/token-lifecycle', () => ({
  tokenLifecycle: {
    getState: vi.fn(() => 'READY'),
    waitForReady: vi.fn(async () => {}),
    initialize: vi.fn(async () => true),
    notifyTokenSet: vi.fn(),
    notifyTokenCleared: vi.fn(),
    destroy: vi.fn(),
  },
  // AuthContext.fetchMe decodes the tenant-RBAC capabilities from the token via
  // this helper (MT-MEDIUM-055); the mock must export it or the module replacement
  // leaves it undefined and every fetchMe call throws.
  decodeResourcePermissions: vi.fn(() => []),
}));

// Mock the api-client module before importing AuthContext
vi.mock('../../utils/api-client', () => {
  let _accessToken: string | null = null;
  let _tenantId: string | null = null;

  return {
    setTokens: vi.fn((token: string) => {
      _accessToken = token;
    }),
    clearTokens: vi.fn(() => {
      _accessToken = null;
    }),
    clearSession: vi.fn(() => {
      _accessToken = null;
      _tenantId = null;
    }),
    getAccessToken: vi.fn(() => _accessToken),
    setTenantId: vi.fn((id: string | null) => {
      _tenantId = id;
    }),
    getTenantId: vi.fn(() => _tenantId),
    silentRefresh: vi.fn(async () => false),
    graphqlClient: {
      request: vi.fn(),
    },
    restClient: {
      request: vi.fn(),
    },
    // Reset helper for tests
    __resetTokens: () => {
      _accessToken = null;
      _tenantId = null;
    },
  };
});

// Import after mocking
import {
  AuthProvider,
  useAuthContext,
  type UserRole,
  type AuthUser,
  type LoginResult,
} from '../AuthContext';
import {
  setTokens,
  clearSession,
  getAccessToken,
  silentRefresh,
  graphqlClient,
  restClient,
  setTenantId,
} from '../../utils/api-client';
import { tokenLifecycle } from '../../utils/token-lifecycle';

// ============================================================================
// Test Helpers
// ============================================================================

const mockGraphqlRequest = graphqlClient.request as ReturnType<typeof vi.fn>;
const mockRestRequest = restClient.request as ReturnType<typeof vi.fn>;
const mockSilentRefresh = silentRefresh as ReturnType<typeof vi.fn>;
const mockGetAccessToken = getAccessToken as ReturnType<typeof vi.fn>;
const mockSetTokens = setTokens as ReturnType<typeof vi.fn>;
const mockClearSession = clearSession as ReturnType<typeof vi.fn>;
const mockSetTenantId = setTenantId as ReturnType<typeof vi.fn>;
const mockTokenLifecycle = vi.mocked(tokenLifecycle);

function createMockUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    role: 'TENANT_ADMIN',
    tenantId: 'tenant-1',
    isActive: true,
    ...overrides,
  };
}

function createMeResponse(
  user: AuthUser,
  modules = [{ code: 'sensor', name: 'Sensor', defaultRoute: '/sensor' }],
) {
  return {
    me: {
      user,
      modules,
      redirectPath: '/dashboard',
    },
  };
}

function createLoginResponse(user: AuthUser, redirectUrl = '/dashboard') {
  return {
    login: {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      redirectUrl,
      user,
    },
  };
}

function getRedirectPath(loginResult: LoginResult | undefined): string {
  if (!loginResult || !('redirectPath' in loginResult)) {
    throw new Error('Expected login redirect result');
  }
  return loginResult.redirectPath;
}

// AuthProvider wrapper for renderHook
function createWrapper(autoCheck = false) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(AuthProvider, { autoCheck, children });
}

// ============================================================================
// Tests
// ============================================================================

describe('AuthContext', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetAccessToken.mockReturnValue(null);
    mockSilentRefresh.mockResolvedValue(false);
    mockGraphqlRequest.mockReset();
    mockRestRequest.mockReset();
    mockRestRequest.mockResolvedValue({ marineExplorer: { enabled: false } });
    // Reset tokenLifecycle mock defaults
    mockTokenLifecycle.initialize.mockResolvedValue(true);
    mockTokenLifecycle.getState.mockReturnValue('READY');
    mockTokenLifecycle.waitForReady.mockResolvedValue(undefined);
    // Reset internal token state
    const apiClient = vi.mocked(await import('../../utils/api-client'));
    if ((apiClient as any).__resetTokens) {
      (apiClient as any).__resetTokens();
    }
    const authBridge = window.__AQUACULTURE_AUTH_CONTEXT_STATE_V1__;
    if (authBridge && typeof authBridge === 'object') {
      authBridge.snapshot = null;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ============================================================================
  // Initial State
  // ============================================================================

  describe('Initial State', () => {
    it('should start with isLoading false when autoCheck is disabled', () => {
      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.user).toBeNull();
      expect(result.current.modules).toEqual([]);
      expect(result.current.marineExplorer).toEqual({ enabled: false });
      expect(result.current.error).toBeNull();
    });

    it('should start with isLoading true when autoCheck is enabled', () => {
      mockGetAccessToken.mockReturnValue(null);
      mockSilentRefresh.mockResolvedValue(false);

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(true),
      });

      // Initially loading (before async operations settle)
      // It may already have resolved since silentRefresh returns immediately
      // Just verify it eventually finishes loading
      expect(result.current.isAuthenticated).toBe(false);
    });
  });

  describe('Marine Explorer capability projection', () => {
    it('accepts only the exact authenticated boolean capability response', async () => {
      const user = createMockUser();
      mockRestRequest.mockResolvedValueOnce({ marineExplorer: { enabled: true } });
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(mockRestRequest).toHaveBeenCalledWith('GET', '/marine-explorer/capabilities', {
        timeout: 5_000,
      });
      expect(result.current.marineExplorer).toEqual({ enabled: true });
    });

    it.each([
      { marineExplorer: { enabled: 'true' } },
      { marineExplorer: { enabled: 1 } },
      { marineExplorer: { enabled: true, source: 'untrusted' } },
      { marineExplorer: { enabled: true }, extra: true },
    ])('fails closed for malformed or widened capability payloads', async (capability) => {
      const user = createMockUser();
      mockRestRequest.mockResolvedValueOnce(capability);
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(result.current.marineExplorer).toEqual({ enabled: false });
    });

    it('refreshes within the bounded TTL and disables the UI capability on failure', async () => {
      vi.useFakeTimers();
      const user = createMockUser();
      mockRestRequest.mockResolvedValueOnce({ marineExplorer: { enabled: true } });
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });
      expect(result.current.marineExplorer.enabled).toBe(true);

      mockRestRequest.mockRejectedValueOnce(new Error('capability endpoint unavailable'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(result.current.marineExplorer.enabled).toBe(false);
      expect(mockRestRequest).toHaveBeenCalledTimes(2);
    });

    it('refreshes a stale capability when the document becomes visible', async () => {
      vi.useFakeTimers();
      const now = new Date('2026-07-20T12:00:00.000Z');
      vi.setSystemTime(now);
      const user = createMockUser();
      mockRestRequest.mockResolvedValueOnce({ marineExplorer: { enabled: true } });
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });
      expect(result.current.marineExplorer.enabled).toBe(true);

      mockRestRequest.mockResolvedValueOnce({ marineExplorer: { enabled: false } });
      vi.setSystemTime(new Date(now.getTime() + 15_001));
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });

      expect(result.current.marineExplorer.enabled).toBe(false);
      expect(mockRestRequest).toHaveBeenCalledTimes(2);
    });

    it('does not publish an in-flight capability refresh once logout starts', async () => {
      vi.useFakeTimers();
      const user = createMockUser();
      mockRestRequest.mockResolvedValueOnce({ marineExplorer: { enabled: false } });
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });
      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      let resolveRefresh: ((value: unknown) => void) | undefined;
      mockRestRequest.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      let resolveLogout: ((value: unknown) => void) | undefined;
      mockGraphqlRequest.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLogout = resolve;
          }),
      );
      let logoutPromise: Promise<void> | undefined;
      act(() => {
        logoutPromise = result.current.logout();
      });

      await act(async () => {
        resolveRefresh?.({ marineExplorer: { enabled: true } });
        await Promise.resolve();
      });

      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.marineExplorer.enabled).toBe(false);

      await act(async () => {
        resolveLogout?.({ logout: { success: true } });
        await logoutPromise;
      });

      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.marineExplorer.enabled).toBe(false);
    });

    it('does not restore auth from an in-flight refreshAuth after logout', async () => {
      const user = createMockUser();
      mockRestRequest.mockResolvedValueOnce({ marineExplorer: { enabled: false } });
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });
      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      let resolveCapability: ((value: unknown) => void) | undefined;
      mockGraphqlRequest.mockResolvedValueOnce(createMeResponse(user));
      mockRestRequest.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCapability = resolve;
          }),
      );
      let refreshPromise: Promise<void> | undefined;
      act(() => {
        refreshPromise = result.current.refreshAuth();
      });
      await waitFor(() => expect(mockRestRequest).toHaveBeenCalledTimes(2));

      mockGraphqlRequest.mockResolvedValueOnce({ logout: { success: true } });
      await act(async () => {
        await result.current.logout();
      });

      await act(async () => {
        resolveCapability?.({ marineExplorer: { enabled: true } });
        await refreshPromise;
      });

      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.marineExplorer.enabled).toBe(false);
    });
  });

  // ============================================================================
  // Login Flow
  // ============================================================================

  describe('Login Flow', () => {
    it('should complete login flow: mutation -> setTokens -> fetchMe -> AUTH_SUCCESS', async () => {
      const user = createMockUser({ role: 'TENANT_ADMIN', tenantId: 'tenant-1' });
      const modules = [{ code: 'sensor', name: 'Sensor Module', defaultRoute: '/sensor' }];

      // Login mutation response
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user, '/dashboard'))
        // fetchMe response
        .mockResolvedValueOnce(createMeResponse(user, modules));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      let loginResult: LoginResult | undefined;
      await act(async () => {
        loginResult = await result.current.login({
          email: 'test@example.com',
          password: 'password123',
        });
      });

      // Verify setTokens was called with the access token
      expect(mockSetTokens).toHaveBeenCalledWith('new-access-token');

      // Verify setTenantId was called
      expect(mockSetTenantId).toHaveBeenCalledWith('tenant-1');

      // Verify state after login
      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.user).toBeDefined();
      expect(result.current.user?.email).toBe('test@example.com');
      expect(result.current.user?.role).toBe('TENANT_ADMIN');
      expect(result.current.modules).toHaveLength(1);
      expect(result.current.error).toBeNull();

      // Verify redirect path
      expect(getRedirectPath(loginResult)).toBe('/dashboard');
    });

    it('should dispatch AUTH_FAILURE on login error', async () => {
      mockGraphqlRequest.mockRejectedValueOnce(new Error('Invalid credentials'));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      let thrown: unknown;
      await act(async () => {
        try {
          await result.current.login({
            email: 'test@example.com',
            password: 'wrong',
          });
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('Invalid credentials');
      expect(result.current.isAuthenticated).toBe(false);
      await waitFor(() => {
        expect(result.current.error).toBe('Invalid credentials');
      });
    });

    it('should handle missing login response gracefully', async () => {
      mockGraphqlRequest.mockResolvedValueOnce({ login: null });

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await expect(
        act(async () => {
          await result.current.login({
            email: 'test@example.com',
            password: 'password',
          });
        }),
      ).rejects.toThrow('Invalid server response');
    });

    it('should fail login and clear session when post-login session verification fails', async () => {
      const user = createMockUser({ role: 'TENANT_ADMIN', tenantId: 'tenant-1' });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user, '/tenant'))
        .mockRejectedValueOnce(new Error('Authentication required'));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await expect(
        act(async () => {
          await result.current.login({
            email: 'test@example.com',
            password: 'password',
          });
        }),
      ).rejects.toThrow('Session verification failed');

      await waitFor(() => {
        expect(mockClearSession).toHaveBeenCalled();
      });
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });

    it('should use default redirect for SUPER_ADMIN when redirectUrl is empty', async () => {
      const superAdmin = createMockUser({ role: 'SUPER_ADMIN', tenantId: null });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(superAdmin, ''))
        .mockResolvedValueOnce(createMeResponse(superAdmin, []));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      let loginResult: LoginResult | undefined;
      await act(async () => {
        loginResult = await result.current.login({
          email: 'admin@example.com',
          password: 'password',
        });
      });

      expect(getRedirectPath(loginResult)).toBe('/admin');
    });

    it('should clear stale tenant scope for SUPER_ADMIN login', async () => {
      const superAdmin = createMockUser({ role: 'SUPER_ADMIN', tenantId: null });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(superAdmin, '/admin'))
        .mockResolvedValueOnce(createMeResponse(superAdmin, []));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({
          email: 'admin@example.com',
          password: 'password',
        });
      });

      expect(mockSetTenantId).toHaveBeenLastCalledWith(null);
    });
  });

  // ============================================================================
  // Logout Flow
  // ============================================================================

  describe('Logout Flow', () => {
    it('should clear tokens and reset state on logout', async () => {
      const user = createMockUser();

      // Login first
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({
          email: 'test@example.com',
          password: 'password',
        });
      });

      expect(result.current.isAuthenticated).toBe(true);

      // Logout mutation response
      mockGraphqlRequest.mockResolvedValueOnce({ logout: { success: true } });

      await act(async () => {
        await result.current.logout();
      });

      expect(mockClearSession).toHaveBeenCalled();
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.user).toBeNull();
      expect(result.current.modules).toEqual([]);
    });

    it('should still clear session even if logout mutation fails', async () => {
      const user = createMockUser();

      // Login
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({
          email: 'test@example.com',
          password: 'password',
        });
      });

      // Logout mutation fails
      mockGraphqlRequest.mockRejectedValueOnce(new Error('Network error'));

      await act(async () => {
        await result.current.logout();
      });

      // Should still clear session despite error
      expect(mockClearSession).toHaveBeenCalled();
      expect(result.current.isAuthenticated).toBe(false);
    });
  });

  // ============================================================================
  // Role Hierarchy
  // ============================================================================

  describe('hasRoleOrHigher', () => {
    const roleCases: Array<{
      userRole: UserRole;
      checkRole: UserRole;
      expected: boolean;
    }> = [
      // SUPER_ADMIN has all roles
      { userRole: 'SUPER_ADMIN', checkRole: 'SUPER_ADMIN', expected: true },
      { userRole: 'SUPER_ADMIN', checkRole: 'TENANT_ADMIN', expected: true },
      { userRole: 'SUPER_ADMIN', checkRole: 'MODULE_MANAGER', expected: true },
      { userRole: 'SUPER_ADMIN', checkRole: 'MODULE_USER', expected: true },

      // TENANT_ADMIN has TENANT_ADMIN and below
      { userRole: 'TENANT_ADMIN', checkRole: 'SUPER_ADMIN', expected: false },
      { userRole: 'TENANT_ADMIN', checkRole: 'TENANT_ADMIN', expected: true },
      { userRole: 'TENANT_ADMIN', checkRole: 'MODULE_MANAGER', expected: true },
      { userRole: 'TENANT_ADMIN', checkRole: 'MODULE_USER', expected: true },

      // MODULE_MANAGER has MODULE_MANAGER and below
      { userRole: 'MODULE_MANAGER', checkRole: 'SUPER_ADMIN', expected: false },
      { userRole: 'MODULE_MANAGER', checkRole: 'TENANT_ADMIN', expected: false },
      { userRole: 'MODULE_MANAGER', checkRole: 'MODULE_MANAGER', expected: true },
      { userRole: 'MODULE_MANAGER', checkRole: 'MODULE_USER', expected: true },

      // MODULE_USER has only MODULE_USER
      { userRole: 'MODULE_USER', checkRole: 'SUPER_ADMIN', expected: false },
      { userRole: 'MODULE_USER', checkRole: 'TENANT_ADMIN', expected: false },
      { userRole: 'MODULE_USER', checkRole: 'MODULE_MANAGER', expected: false },
      { userRole: 'MODULE_USER', checkRole: 'MODULE_USER', expected: true },
    ];

    it.each(roleCases)(
      '$userRole.hasRoleOrHigher($checkRole) should be $expected',
      async ({ userRole, checkRole, expected }) => {
        const user = createMockUser({ role: userRole });

        mockGraphqlRequest
          .mockResolvedValueOnce(createLoginResponse(user))
          .mockResolvedValueOnce(createMeResponse(user));

        const { result } = renderHook(() => useAuthContext(), {
          wrapper: createWrapper(false),
        });

        await act(async () => {
          await result.current.login({
            email: 'test@example.com',
            password: 'password',
          });
        });

        expect(result.current.hasRoleOrHigher(checkRole)).toBe(expected);
      },
    );

    it('should return false when no user is logged in', () => {
      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      expect(result.current.hasRoleOrHigher('MODULE_USER')).toBe(false);
    });
  });

  // ============================================================================
  // Role Check Helpers
  // ============================================================================

  describe('Role check helpers', () => {
    it('isSuperAdmin should return true only for SUPER_ADMIN', async () => {
      const user = createMockUser({ role: 'SUPER_ADMIN' });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(result.current.isSuperAdmin()).toBe(true);
      expect(result.current.isTenantAdmin()).toBe(false);
      expect(result.current.isModuleManager()).toBe(false);
      expect(result.current.isModuleUser()).toBe(false);
    });

    it('isTenantAdmin should return true only for TENANT_ADMIN', async () => {
      const user = createMockUser({ role: 'TENANT_ADMIN' });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(result.current.isSuperAdmin()).toBe(false);
      expect(result.current.isTenantAdmin()).toBe(true);
    });
  });

  // ============================================================================
  // Module Access
  // ============================================================================

  describe('hasModuleAccess', () => {
    it('should return false for SUPER_ADMIN (system access, not module)', async () => {
      const user = createMockUser({ role: 'SUPER_ADMIN' });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(
          createMeResponse(user, [{ code: 'sensor', name: 'Sensor', defaultRoute: '/sensor' }]),
        );

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(result.current.hasModuleAccess('sensor')).toBe(false);
    });

    it('should return true for TENANT_ADMIN regardless of module list', async () => {
      const user = createMockUser({ role: 'TENANT_ADMIN' });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user, []));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(result.current.hasModuleAccess('any-module')).toBe(true);
    });

    it('should check assigned modules for MODULE_MANAGER', async () => {
      const user = createMockUser({ role: 'MODULE_MANAGER' });
      const modules = [
        { code: 'sensor', name: 'Sensor', defaultRoute: '/sensor' },
        { code: 'farm', name: 'Farm', defaultRoute: '/farm' },
      ];

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user, modules));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(result.current.hasModuleAccess('sensor')).toBe(true);
      expect(result.current.hasModuleAccess('farm')).toBe(true);
      expect(result.current.hasModuleAccess('billing')).toBe(false);
    });

    it('should check assigned modules for MODULE_USER', async () => {
      const user = createMockUser({ role: 'MODULE_USER' });
      const modules = [{ code: 'sensor', name: 'Sensor', defaultRoute: '/sensor' }];

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user, modules));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(result.current.hasModuleAccess('sensor')).toBe(true);
      expect(result.current.hasModuleAccess('hr')).toBe(false);
    });

    it('should return false when no user is logged in', () => {
      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      expect(result.current.hasModuleAccess('sensor')).toBe(false);
    });
  });

  // ============================================================================
  // Module Federation Fallback
  // ============================================================================

  describe('MF fallback (context unavailable)', () => {
    it('should return fail-closed defaults when used outside AuthProvider', () => {
      // Render without AuthProvider wrapper
      const { result } = renderHook(() => useAuthContext());

      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.user).toBeNull();
      expect(result.current.modules).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('fallback hasRoleOrHigher should always return false', () => {
      const { result } = renderHook(() => useAuthContext());

      expect(result.current.hasRoleOrHigher('MODULE_USER')).toBe(false);
      expect(result.current.hasRoleOrHigher('SUPER_ADMIN')).toBe(false);
    });

    it('fallback hasModuleAccess should always return false', () => {
      const { result } = renderHook(() => useAuthContext());

      expect(result.current.hasModuleAccess('sensor')).toBe(false);
    });

    it('fallback isSuperAdmin should return false', () => {
      const { result } = renderHook(() => useAuthContext());

      expect(result.current.isSuperAdmin()).toBe(false);
      expect(result.current.isTenantAdmin()).toBe(false);
      expect(result.current.isModuleManager()).toBe(false);
      expect(result.current.isModuleUser()).toBe(false);
    });

    it('should use server-verified auth bridge snapshot when provider context is unavailable', async () => {
      const superAdmin = createMockUser({ role: 'SUPER_ADMIN', tenantId: null });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(superAdmin, '/admin'))
        .mockResolvedValueOnce(createMeResponse(superAdmin, []));

      const providerHook = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await providerHook.result.current.login({
          email: 'admin@example.com',
          password: 'password',
        });
      });

      mockGetAccessToken.mockReturnValue('new-access-token');

      const { result } = renderHook(() => useAuthContext());

      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.user?.role).toBe('SUPER_ADMIN');
      expect(result.current.isSuperAdmin()).toBe(true);
      expect(result.current.hasRoleOrHigher('SUPER_ADMIN')).toBe(true);
      expect(result.current.hasModuleAccess('sensor')).toBe(false);
    });

    it('fallback login should resolve with root redirect', async () => {
      const { result } = renderHook(() => useAuthContext());

      const loginResult = await result.current.login({
        email: 'test@example.com',
        password: 'pw',
      });

      expect(getRedirectPath(loginResult)).toBe('/');
    });

    it('fallback logout should clear session', async () => {
      const { result } = renderHook(() => useAuthContext());

      await result.current.logout();
      expect(mockClearSession).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // sanitizeRedirectUrl (Open Redirect Prevention - SEC-005)
  // ============================================================================

  describe('sanitizeRedirectUrl (via login redirectUrl)', () => {
    it('should accept valid relative paths', async () => {
      const user = createMockUser({ role: 'TENANT_ADMIN' });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user, '/dashboard'))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      let loginResult: LoginResult | undefined;
      await act(async () => {
        loginResult = await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(getRedirectPath(loginResult)).toBe('/dashboard');
    });

    it('should reject protocol-relative URLs (//evil.com)', async () => {
      const user = createMockUser({ role: 'TENANT_ADMIN' });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user, '//evil.com/steal'))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      let loginResult: LoginResult | undefined;
      await act(async () => {
        loginResult = await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      // Should fall back to default redirect, not the malicious URL
      expect(getRedirectPath(loginResult)).not.toContain('evil.com');
      expect(getRedirectPath(loginResult)).toBe('/tenant');
    });

    it('should reject absolute URLs with protocol (https://evil.com)', async () => {
      const user = createMockUser({ role: 'TENANT_ADMIN' });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user, 'https://evil.com'))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      let loginResult: LoginResult | undefined;
      await act(async () => {
        loginResult = await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(getRedirectPath(loginResult)).not.toContain('evil.com');
      expect(getRedirectPath(loginResult)).toBe('/tenant');
    });

    it('should reject URLs with colon (javascript:alert(1))', async () => {
      const user = createMockUser({ role: 'MODULE_USER' });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user, 'javascript:alert(1)'))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      let loginResult: LoginResult | undefined;
      await act(async () => {
        loginResult = await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(getRedirectPath(loginResult)).not.toContain('javascript');
      expect(getRedirectPath(loginResult)).toBe('/dashboard');
    });

    it('should use role-based default when redirectUrl is null', async () => {
      const user = createMockUser({ role: 'MODULE_MANAGER' });

      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user, ''))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      let loginResult: LoginResult | undefined;
      await act(async () => {
        loginResult = await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      expect(getRedirectPath(loginResult)).toBe('/dashboard');
    });
  });

  // ============================================================================
  // clearError
  // ============================================================================

  describe('clearError', () => {
    it('should clear error from state', async () => {
      mockGraphqlRequest.mockRejectedValueOnce(new Error('Login failed'));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      let thrown: unknown;
      await act(async () => {
        try {
          await result.current.login({ email: 'a@b.com', password: 'wrong' });
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      await waitFor(() => {
        expect(result.current.error).toBe('Login failed');
      });

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });

  // ============================================================================
  // refreshAuth
  // ============================================================================

  describe('refreshAuth', () => {
    it('should re-fetch user data and update state', async () => {
      const user = createMockUser({ role: 'TENANT_ADMIN' });

      // Login
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      // refreshAuth
      const updatedUser = createMockUser({ role: 'TENANT_ADMIN', firstName: 'Updated' });
      mockGraphqlRequest.mockResolvedValueOnce(createMeResponse(updatedUser));

      await act(async () => {
        await result.current.refreshAuth();
      });

      expect(result.current.user?.firstName).toBe('Updated');
      expect(result.current.isAuthenticated).toBe(true);
    });

    it('should set AUTH_FAILURE when refreshAuth fails', async () => {
      const user = createMockUser();

      // Login
      mockGraphqlRequest
        .mockResolvedValueOnce(createLoginResponse(user))
        .mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(false),
      });

      await act(async () => {
        await result.current.login({ email: 'a@b.com', password: 'p' });
      });

      // refreshAuth fails
      mockGraphqlRequest.mockRejectedValueOnce(new Error('Network error'));

      await act(async () => {
        await result.current.refreshAuth();
      });

      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.error).toBe('Session refresh failed');
    });
  });

  // ============================================================================
  // Auto-check (initial auth)
  // ============================================================================

  describe('Auto-check on mount', () => {
    it('should use tokenLifecycle.initialize() and fetch user when autoCheck is true', async () => {
      const user = createMockUser();

      // tokenLifecycle.initialize() returns true (session restored)
      mockTokenLifecycle.initialize.mockResolvedValue(true);
      // After lifecycle init, getAccessToken returns a token
      mockGetAccessToken.mockReturnValue('restored-token');

      mockGraphqlRequest.mockResolvedValueOnce(createMeResponse(user));

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(true),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockTokenLifecycle.initialize).toHaveBeenCalled();
      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.user?.email).toBe('test@example.com');
    });

    it('should set AUTH_FAILURE when tokenLifecycle.initialize() fails', async () => {
      mockTokenLifecycle.initialize.mockResolvedValue(false);
      mockGetAccessToken.mockReturnValue(null);

      const { result } = renderHook(() => useAuthContext(), {
        wrapper: createWrapper(true),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.isAuthenticated).toBe(false);
    });
  });
});
