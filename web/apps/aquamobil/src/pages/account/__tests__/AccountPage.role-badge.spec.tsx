// FE-MEDIUM-051 — the AccountPage role badge is keyed by the canonical backend
// Role enum (SUPER_ADMIN / TENANT_ADMIN / MODULE_MANAGER / MODULE_USER). The old
// phantom MANAGER/OPERATOR/VIEWER entries are gone; these tests assert the badge
// renders for the canonical roles and that no phantom branch is reachable.
//
// Compile-time backstop (tier-3): ROLE_BADGE_CONFIG is a Record<Role, ...>, so a
// phantom key or a missing canonical key is a tsc error. This spec is the
// runtime complement proving the rendered label tracks the canonical role.

import { render, screen, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import { AccountPage } from '../AccountPage';

import type { Role } from '@/types';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

let currentRole: Role = 'MODULE_MANAGER';
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.com', name: 'Ada Lovelace', role: currentRole, tenantId: 't1' },
    tenantId: 't1',
    logout: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({ pendingCount: 0, isOnline: true, isSyncing: false, syncNow: vi.fn(() => Promise.resolve({ success: 0, failed: 0 })) }),
}));

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => ({ unreadCount: 0 }),
}));

vi.mock('@/hooks/useWebAuthn', () => ({
  useWebAuthn: () => ({ isSupported: false, hasCredentials: false }),
  storeBiometricEmail: vi.fn(),
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'night',
    preference: 'system',
    setPreference: vi.fn(),
    isDark: true,
  }),
}));

vi.mock('@/hooks/useDensity', () => ({
  useDensity: () => ({ density: 'standard', setDensity: vi.fn(), isGlove: false }),
}));

vi.mock('@/pwa/offline-queue', () => ({
  clearCache: vi.fn(() => Promise.resolve()),
  clearAllOperations: vi.fn(() => Promise.resolve()),
}));

describe('AccountPage role badge (FE-MEDIUM-051)', () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders the Manager badge for a MODULE_MANAGER', () => {
    currentRole = 'MODULE_MANAGER';
    render(<AccountPage />);
    expect(screen.getByText('Manager')).toBeTruthy();
  });

  it('renders the Operator badge for a MODULE_USER', () => {
    currentRole = 'MODULE_USER';
    render(<AccountPage />);
    expect(screen.getByText('Operator')).toBeTruthy();
  });

  it('renders the Tenant Admin badge for a TENANT_ADMIN', () => {
    currentRole = 'TENANT_ADMIN';
    render(<AccountPage />);
    expect(screen.getByText('Tenant Admin')).toBeTruthy();
  });

  it('renders the Super Admin badge for a SUPER_ADMIN', () => {
    currentRole = 'SUPER_ADMIN';
    render(<AccountPage />);
    expect(screen.getByText('Super Admin')).toBeTruthy();
  });

  it('never renders a phantom Viewer badge for any canonical role', () => {
    for (const role of ['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER', 'MODULE_USER'] as const) {
      currentRole = role;
      render(<AccountPage />);
      expect(screen.queryByText('Viewer')).toBeNull();
      cleanup();
    }
  });
});
