/**
 * Guard family behavior specs.
 *
 * The gates read auth through `useAuthContext()`; these specs drive that seam
 * with the REAL context (default-exported `AuthContext`) fed a controlled
 * value — no module mocking, so the guards are exercised exactly as mounted.
 * Capability rules (hasResourcePermission / hasTenantPanelAccess) run their
 * real implementations — they are pure functions.
 *
 * Covers: RequireAuth, RequireRole (+ its parametric faces), RequirePlatform-
 * Admin, RequireTenantPanel, RequireCapability and ErrorBoundary. Their
 * loading surface is the BrandLoader (components/Loading, its own spec).
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AuthContextModule, { useAuthContext } from '../../../contexts/AuthContext';
import type { AuthUser, UserModule, UserRole } from '../../../contexts/AuthContext';
import {
  ErrorBoundary,
  RequireAuth,
  RequireCapability,
  RequirePlatformAdmin,
  RequireRole,
  RequireTenantPanel,
} from '../index';

type AuthContextValue = ReturnType<typeof useAuthContext>;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * The ErrorBoundary family resolves its retry-time query-cache reset from the
 * ambient QueryClientProvider, so its specs mount one (fresh per test — the
 * reset assertions are per-instance).
 */
function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const resetQueriesSpy = vi.spyOn(queryClient, 'resetQueries');
  const rendered = render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { ...rendered, queryClient, resetQueriesSpy };
}

function randomIdLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

const ROLE_HIERARCHY: Record<UserRole, UserRole[]> = {
  SUPER_ADMIN: ['TENANT_ADMIN', 'MODULE_MANAGER', 'MODULE_USER'],
  TENANT_ADMIN: ['MODULE_MANAGER', 'MODULE_USER'],
  MODULE_MANAGER: ['MODULE_USER'],
  MODULE_USER: [],
};

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'u1',
    email: 'user@test.com',
    role: 'MODULE_USER',
    isActive: true,
    ...overrides,
  };
}

/** Controlled AuthContextValue — mirrors the provider's helper semantics. */
function authValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  const currentUser = 'user' in overrides ? (overrides.user ?? null) : null;
  const modules: UserModule[] = 'modules' in overrides ? (overrides.modules ?? []) : [];
  const role = currentUser?.role;
  return {
    user: currentUser,
    modules,
    isLoading: false,
    isAuthenticated: currentUser !== null,
    error: null,
    login: vi.fn(),
    verifyMfaLogin: vi.fn(),
    logout: vi.fn(),
    clearError: vi.fn(),
    refreshAuth: vi.fn(),
    isSuperAdmin: () => role === 'SUPER_ADMIN',
    isTenantAdmin: () => role === 'TENANT_ADMIN',
    isModuleManager: () => role === 'MODULE_MANAGER',
    isModuleUser: () => role === 'MODULE_USER',
    hasRoleOrHigher: (required: UserRole) =>
      role === required || (ROLE_HIERARCHY[role ?? 'MODULE_USER']?.includes(required) ?? false),
    hasModuleAccess: (moduleCode: string) => {
      if (!role) return false;
      if (role === 'SUPER_ADMIN') return false;
      if (role === 'TENANT_ADMIN') return true;
      return modules.some((m) => m.code === moduleCode);
    },
    ...overrides,
  } satisfies AuthContextValue;
}

function renderGuarded(ui: React.ReactElement, auth: AuthContextValue): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={<AuthContextModule.Provider value={auth}>{ui}</AuthContextModule.Provider>}
        />
        <Route path="/login" element={<div data-testid="login-page">Login Page</div>} />
        <Route
          path="/unauthorized"
          element={<div data-testid="unauthorized-page">Unauthorized Page</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const CHILD = <div data-testid="guarded-content">guarded</div>;

// ---------------------------------------------------------------------------
// RequireAuth
// ---------------------------------------------------------------------------

describe('RequireAuth', () => {
  it('renders children for an authenticated session', () => {
    renderGuarded(<RequireAuth>{CHILD}</RequireAuth>, authValue({ user: user() }));
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor to /login', () => {
    renderGuarded(<RequireAuth>{CHILD}</RequireAuth>, authValue());
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(screen.queryByTestId('guarded-content')).not.toBeInTheDocument();
  });

  it('renders the default GuardLoading surface while the session check is in flight', () => {
    renderGuarded(
      <RequireAuth>{CHILD}</RequireAuth>,
      authValue({ isLoading: true, isAuthenticated: false }),
    );
    // The one loading screen, naming the session check for screen readers (FE-MEDIUM-349).
    expect(screen.getByRole('status')).toHaveClass('brand-loader');
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session, please wait.');
    expect(screen.queryByTestId('guarded-content')).not.toBeInTheDocument();
  });

  it('renders a custom loadingFallback when provided', () => {
    renderGuarded(
      <RequireAuth loadingFallback={<div data-testid="custom-fallback">…</div>}>
        {CHILD}
      </RequireAuth>,
      authValue({ isLoading: true, isAuthenticated: false }),
    );
    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// RequireRole
// ---------------------------------------------------------------------------

describe('RequireRole', () => {
  it('renders children for an authenticated user when no requirement is declared', () => {
    renderGuarded(<RequireRole>{CHILD}</RequireRole>, authValue({ user: user() }));
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor to /login', () => {
    renderGuarded(<RequireRole requiredRoles={['TENANT_ADMIN']}>{CHILD}</RequireRole>, authValue());
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });

  it('renders the loading surface while the session check is in flight', () => {
    renderGuarded(
      <RequireRole requiredRoles={['TENANT_ADMIN']}>{CHILD}</RequireRole>,
      authValue({ isLoading: true }),
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('admits a user holding a required role', () => {
    renderGuarded(
      <RequireRole requiredRoles={['TENANT_ADMIN']}>{CHILD}</RequireRole>,
      authValue({ user: user({ role: 'TENANT_ADMIN' }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('admits SUPER_ADMIN to a TENANT_ADMIN route (hierarchy)', () => {
    renderGuarded(
      <RequireRole requiredRoles={['TENANT_ADMIN']}>{CHILD}</RequireRole>,
      authValue({ user: user({ role: 'SUPER_ADMIN' }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('denies an authenticated user lacking the required role (fail-closed)', () => {
    renderGuarded(
      <RequireRole requiredRoles={['TENANT_ADMIN']}>{CHILD}</RequireRole>,
      authValue({ user: user({ role: 'MODULE_USER' }) }),
    );
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
  });

  it('admits a delegate holding a required capability (MT-HIGH-060 delegation)', () => {
    renderGuarded(
      <RequireRole requiredCapabilities={['users:view']}>{CHILD}</RequireRole>,
      authValue({ user: user({ resourcePermissions: ['users:view'] }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('denies a delegate lacking the required capability', () => {
    renderGuarded(
      <RequireRole requiredCapabilities={['users:view']}>{CHILD}</RequireRole>,
      authValue({ user: user({ resourcePermissions: ['roles:view'] }) }),
    );
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
  });

  it('passes on role OR capability when both are declared', () => {
    const ui = (
      <RequireRole requiredRoles={['TENANT_ADMIN']} requiredCapabilities={['users:view']}>
        {CHILD}
      </RequireRole>
    );
    const { rerender } = renderGuarded(
      ui,
      authValue({ user: user({ resourcePermissions: ['users:view'] }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <AuthContextModule.Provider value={authValue({ user: user() })}>
                {ui}
              </AuthContextModule.Provider>
            }
          />
          <Route path="/login" element={<div data-testid="login-page">Login Page</div>} />
          <Route
            path="/unauthorized"
            element={<div data-testid="unauthorized-page">Unauthorized Page</div>}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
  });

  it('admits a user holding the requiredModule grant', () => {
    const farmModule: UserModule = { code: 'farm', name: 'Farm', defaultRoute: '/sites' };
    renderGuarded(
      <RequireRole requiredModule="farm">{CHILD}</RequireRole>,
      authValue({ user: user(), modules: [farmModule] }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('bypasses requiredModule for SUPER_ADMIN (system-level access)', () => {
    renderGuarded(
      <RequireRole requiredModule="farm">{CHILD}</RequireRole>,
      authValue({ user: user({ role: 'SUPER_ADMIN' }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('denies requiredModule without the grant', () => {
    renderGuarded(
      <RequireRole requiredModule="farm">{CHILD}</RequireRole>,
      authValue({ user: user() }),
    );
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
  });

  it('blocks MOBILE_ONLY users when blockMobileOnly is set', () => {
    renderGuarded(
      <RequireRole blockMobileOnly>{CHILD}</RequireRole>,
      authValue({ user: user({ accessType: 'MOBILE_ONLY' }) }),
    );
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
  });

  it('admits BOTH users when blockMobileOnly is set', () => {
    renderGuarded(
      <RequireRole blockMobileOnly>{CHILD}</RequireRole>,
      authValue({ user: user({ accessType: 'BOTH' }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// RequirePlatformAdmin
// ---------------------------------------------------------------------------

describe('RequirePlatformAdmin', () => {
  it('renders children for SUPER_ADMIN', () => {
    renderGuarded(
      <RequirePlatformAdmin>{CHILD}</RequirePlatformAdmin>,
      authValue({ user: user({ role: 'SUPER_ADMIN' }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('denies an authenticated non-super-admin to /unauthorized', () => {
    renderGuarded(
      <RequirePlatformAdmin>{CHILD}</RequirePlatformAdmin>,
      authValue({ user: user({ role: 'TENANT_ADMIN' }) }),
    );
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
  });

  it('waits for the session check instead of flash-redirecting (loading face)', () => {
    renderGuarded(
      <RequirePlatformAdmin>{CHILD}</RequirePlatformAdmin>,
      authValue({ user: user({ role: 'SUPER_ADMIN' }), isLoading: true }),
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('unauthorized-page')).not.toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor to /login', () => {
    renderGuarded(<RequirePlatformAdmin>{CHILD}</RequirePlatformAdmin>, authValue());
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// RequireTenantPanel
// ---------------------------------------------------------------------------

describe('RequireTenantPanel', () => {
  it('renders children for a global tenant admin', () => {
    renderGuarded(
      <RequireTenantPanel>{CHILD}</RequireTenantPanel>,
      authValue({ user: user({ role: 'TENANT_ADMIN' }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('renders children for SUPER_ADMIN (panel-access SSoT)', () => {
    renderGuarded(
      <RequireTenantPanel>{CHILD}</RequireTenantPanel>,
      authValue({ user: user({ role: 'SUPER_ADMIN' }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('renders children for a delegate holding a panel capability', () => {
    renderGuarded(
      <RequireTenantPanel>{CHILD}</RequireTenantPanel>,
      authValue({ user: user({ resourcePermissions: ['users:view'] }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('denies a capability-less user before any page loads (fail-closed)', () => {
    renderGuarded(<RequireTenantPanel>{CHILD}</RequireTenantPanel>, authValue({ user: user() }));
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor to /login', () => {
    renderGuarded(<RequireTenantPanel>{CHILD}</RequireTenantPanel>, authValue());
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// RequireCapability
// ---------------------------------------------------------------------------

describe('RequireCapability', () => {
  it('bypasses for a global tenant admin on an adminOnly page', () => {
    renderGuarded(
      <RequireCapability adminOnly>{CHILD}</RequireCapability>,
      authValue({ user: user({ role: 'TENANT_ADMIN' }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('admits a delegate holding the page capability', () => {
    renderGuarded(
      <RequireCapability capability="users:view">{CHILD}</RequireCapability>,
      authValue({ user: user({ resourcePermissions: ['users:view'] }) }),
    );
    expect(screen.getByTestId('guarded-content')).toBeInTheDocument();
  });

  it('denies a delegate on an adminOnly page', () => {
    renderGuarded(
      <RequireCapability capability="users:view" adminOnly>
        {CHILD}
      </RequireCapability>,
      authValue({ user: user({ resourcePermissions: ['users:view'] }) }),
    );
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
  });

  it('denies a delegate lacking the page capability', () => {
    renderGuarded(
      <RequireCapability capability="roles:view">{CHILD}</RequireCapability>,
      authValue({ user: user({ resourcePermissions: ['users:view'] }) }),
    );
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
  });

  it('denies a delegate when the guard is misconfigured (no capability)', () => {
    renderGuarded(
      <RequireCapability>{CHILD}</RequireCapability>,
      authValue({ user: user({ resourcePermissions: ['users:view'] }) }),
    );
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor to /login', () => {
    renderGuarded(
      <RequireCapability capability="users:view">{CHILD}</RequireCapability>,
      authValue(),
    );
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------

function Bomb({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) throw new Error('bomb exploded');
  return <div data-testid="recovered">recovered</div>;
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    renderWithQueryClient(
      <ErrorBoundary moduleName="Test">
        <div data-testid="healthy">healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('healthy')).toBeInTheDocument();
  });

  it('contains a crash and shows the module-scoped error UI', () => {
    renderWithQueryClient(
      <ErrorBoundary moduleName="Sensor">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Failed to Load Sensor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh Page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Home' })).toBeInTheDocument();
  });

  it('recovers via Retry (state reset re-renders the subtree)', () => {
    function RecoveryHarness(): React.ReactElement {
      // The parent heals the children BEFORE the boundary's Retry is clicked,
      // so the reset re-renders a healthy subtree — the recovery contract.
      const [throwing, setThrowing] = React.useState(true);
      return (
        <div>
          <button type="button" data-testid="heal" onClick={() => setThrowing(false)}>
            heal
          </button>
          <ErrorBoundary>
            {throwing ? <Bomb shouldThrow /> : <div data-testid="recovered">recovered</div>}
          </ErrorBoundary>
        </div>
      );
    }

    renderWithQueryClient(<RecoveryHarness />);
    expect(screen.getByText('An Error Occurred')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('heal'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByTestId('recovered')).toBeInTheDocument();
  });

  it('renders a custom fallback when provided', () => {
    renderWithQueryClient(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">oops</div>}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
  });

  it('observes the error via onError', () => {
    const onError = vi.fn();
    renderWithQueryClient(
      <ErrorBoundary onError={onError}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[0].message).toBe('bomb exploded');
    expect(typeof onError.mock.calls[0]?.[1].componentStack).toBe('string');
  });
});

describe('ErrorBoundary (retry budget & support keys)', () => {
  it('shows a support errorId (client-generated, UUID-shaped) on the card', () => {
    renderWithQueryClient(
      <ErrorBoundary moduleName="Sensor">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    const shareLine = screen.getByText('Share this code with support:', { exact: false });
    expect(shareLine).toBeInTheDocument();
    const mono = shareLine.parentElement?.querySelector('span.font-mono');
    expect(mono).not.toBeNull();
    expect(randomIdLike(mono?.textContent ?? '')).toBe(true);
  });

  it('resets the query cache on Retry and exhausts the budget after three tries', () => {
    const { resetQueriesSpy } = renderWithQueryClient(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    const retry = () => screen.getByRole('button', { name: 'Retry' });
    expect(retry()).toBeEnabled();
    fireEvent.click(retry());
    fireEvent.click(retry());
    fireEvent.click(retry());
    expect(resetQueriesSpy).toHaveBeenCalledTimes(3);
    expect(retry()).toBeDisabled();
  });
});
