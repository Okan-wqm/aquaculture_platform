/**
 * IdentityBoundary defense-in-depth test — MT-CRITICAL-050.
 *
 * Keying the authenticated subtree by `${tenantId}:${userId}` must force a full
 * UNMOUNT + REMOUNT of the child tree whenever the identity changes, so no
 * component state belonging to user A can survive into user B's session on a
 * shared device. This test drives a mocked useAuth through an identity switch
 * and asserts the child component is destroyed and recreated (a fresh mount
 * counter), not merely re-rendered.
 */

import { render, act } from '@testing-library/react';
import { useEffect } from 'react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

let authValue: { user: { id: string } | null; tenantId: string | null };
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => authValue,
}));

import { IdentityBoundary } from '../IdentityBoundary';

let mountCount = 0;
let unmountCount = 0;

function Child(): null {
  useEffect(() => {
    mountCount += 1;
    return () => {
      unmountCount += 1;
    };
  }, []);
  return null;
}

beforeEach(() => {
  mountCount = 0;
  unmountCount = 0;
});

describe('IdentityBoundary (MT-CRITICAL-050 defense-in-depth)', () => {
  it('remounts the subtree when the user changes (logout → next user)', () => {
    authValue = { user: { id: 'user-A' }, tenantId: 'tenant-1' };
    const { rerender } = render(
      <IdentityBoundary>
        <Child />
      </IdentityBoundary>,
    );
    expect(mountCount).toBe(1);
    expect(unmountCount).toBe(0);

    // Identity switches to a different user on the SAME device.
    act(() => {
      authValue = { user: { id: 'user-B' }, tenantId: 'tenant-1' };
      rerender(
        <IdentityBoundary>
          <Child />
        </IdentityBoundary>,
      );
    });

    // The prior subtree was destroyed and a fresh one created.
    expect(unmountCount).toBe(1);
    expect(mountCount).toBe(2);
  });

  it('remounts when the tenant changes for the same user id', () => {
    authValue = { user: { id: 'user-A' }, tenantId: 'tenant-1' };
    const { rerender } = render(
      <IdentityBoundary>
        <Child />
      </IdentityBoundary>,
    );
    expect(mountCount).toBe(1);

    act(() => {
      authValue = { user: { id: 'user-A' }, tenantId: 'tenant-2' };
      rerender(
        <IdentityBoundary>
          <Child />
        </IdentityBoundary>,
      );
    });

    expect(unmountCount).toBe(1);
    expect(mountCount).toBe(2);
  });

  it('does NOT remount on an unrelated re-render with a stable identity', () => {
    authValue = { user: { id: 'user-A' }, tenantId: 'tenant-1' };
    const { rerender } = render(
      <IdentityBoundary>
        <Child />
      </IdentityBoundary>,
    );
    expect(mountCount).toBe(1);

    act(() => {
      // Same identity object values — re-render must not churn the subtree.
      authValue = { user: { id: 'user-A' }, tenantId: 'tenant-1' };
      rerender(
        <IdentityBoundary>
          <Child />
        </IdentityBoundary>,
      );
    });

    expect(unmountCount).toBe(0);
    expect(mountCount).toBe(1);
  });
});
