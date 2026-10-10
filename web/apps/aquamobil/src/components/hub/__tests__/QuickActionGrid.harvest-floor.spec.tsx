// SEC-MEDIUM-050 — the harvest CTA is gated on BOTH the 'harvest' feature flag
// AND a MODULE_MANAGER role floor. A MODULE_USER whose harvest feature is ON must
// NOT see the harvest action (it would 403 after the success screen); a
// MODULE_MANAGER (and higher) sees it. Non-floored actions (cull) stay visible to
// a MODULE_USER on the feature flag alone.

import { render, screen, cleanup } from '@testing-library/react';
import { Package, Scissors } from 'lucide-react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { QuickActionGrid } from '../QuickActionGrid';

import type { MobileFeature } from '@/hooks/useMobilePermissions';
import type { Role } from '@/types';

// useNavigate is invoked at render; stub it so the component mounts headless.
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

// canAccess returns true for every feature in these tests, so the ONLY variable
// is the role floor — isolating the SEC-MEDIUM-050 behavior.
vi.mock('@/hooks/useMobilePermissions', () => ({
  useMobilePermissions: () => ({ canAccess: (_f: MobileFeature) => true }),
}));

let currentRole: Role = 'MODULE_USER';
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { role: currentRole } }),
}));

const ACTIONS = [
  {
    feature: 'cull' as MobileFeature,
    path: '/cull/record',
    icon: Scissors,
    label: 'Culling',
    gradient: 'from-amber-500 to-amber-600',
  },
  {
    feature: 'harvest' as MobileFeature,
    path: '/harvest/record',
    icon: Package,
    label: 'Harvest',
    gradient: 'from-violet-500 to-violet-600',
  },
];

describe('QuickActionGrid harvest role floor (SEC-MEDIUM-050)', () => {
  beforeEach(() => {
    cleanup();
  });

  it('hides the Harvest CTA from a MODULE_USER even with the feature ON', () => {
    currentRole = 'MODULE_USER';
    render(<QuickActionGrid actions={ACTIONS} />);
    expect(screen.queryByLabelText('Harvest')).toBeNull();
    // The non-floored cull action stays visible on the feature flag alone.
    expect(screen.queryByLabelText('Culling')).not.toBeNull();
  });

  it('shows the Harvest CTA to a MODULE_MANAGER', () => {
    currentRole = 'MODULE_MANAGER';
    render(<QuickActionGrid actions={ACTIONS} />);
    expect(screen.queryByLabelText('Harvest')).not.toBeNull();
  });

  it('shows the Harvest CTA to a TENANT_ADMIN', () => {
    currentRole = 'TENANT_ADMIN';
    render(<QuickActionGrid actions={ACTIONS} />);
    expect(screen.queryByLabelText('Harvest')).not.toBeNull();
  });
});
